require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { NCERT_CHANNEL, api, discover, textbookChapters, extractChapter, hash, list, gradeChapter } = require('../services/ncertSource');
const { createStore } = require('../services/ncertStore');

async function run() {
    const directory = path.join(__dirname, '../database');
    fs.mkdirSync(directory, {recursive:true});
    const lockPath = path.join(directory, 'ncert-sync.lock');
    const lock = fs.openSync(lockPath, 'wx');
    const cache = path.join(directory, 'ncert-resource-cache');
    fs.mkdirSync(cache,{recursive:true});
    const report = {startedAt:new Date().toISOString(),state:'discovering',discovered:0,processed:0,failed:0,ready:0,review:0,unavailable:0,catalogOnly:0,classes:{},errors:[]};
    const statusPath=path.join(directory,'ncert-sync-status.json');
    function progress(){
        report.updatedAt=new Date().toISOString();
        fs.writeFileSync(statusPath+'.tmp',JSON.stringify(report,null,2));fs.renameSync(statusPath+'.tmp',statusPath);
    }
    let stopping=false;
    process.on('SIGTERM',()=>{stopping=true;});
    process.on('SIGINT',()=>{stopping=true;});
    const inflight=new Map();
    async function resource(chapter){
        const key=hash(JSON.stringify([chapter.url,chapter.resourceVersion,'extractor-v2']));
        const file=path.join(cache,key+'.json');
        if(process.env.NCERT_FORCE!=='1' && fs.existsSync(file)){
            const saved=JSON.parse(fs.readFileSync(file,'utf8'));
            // Re-grade on read: cached entries carry whatever status the rule
            // said when they were written, and the rule has since changed.
            // Zero-page entries fall through so they get retried.
            if(saved.pages?.length){
                const g=gradeChapter(saved.pages);
                return {...chapter,...saved,status:g.status,readablePages:g.readablePages,textChars:g.chars};
            }
        }
        if(inflight.has(key))return {...chapter,...await inflight.get(key)};
        const pending=(async()=>{
            const result=await extractChapter(chapter);
            const content={pages:result.pages,status:result.status,sha256:result.sha256,fetchedAt:result.fetchedAt};
            fs.writeFileSync(file+'.tmp',JSON.stringify(content));fs.renameSync(file+'.tmp',file);
            return content;
        })();
        inflight.set(key,pending);
        try{return {...chapter,...await pending};}finally{inflight.delete(key);}
    }
    try {
        fs.writeFileSync(lock,JSON.stringify({pid:process.pid,started:report.startedAt}));
        progress();
        const store=createStore(require('../config/db'));
        const candidates=[];
        if(process.env.NCERT_CATALOG_FILE){
            candidates.push(...JSON.parse(fs.readFileSync(process.env.NCERT_CATALOG_FILE,'utf8')));
        }else{
            for await(const candidate of discover(JSON.parse(process.env.NCERT_FILTERS||'{}')))candidates.push(candidate);
        }
        report.discovered=candidates.length;report.state='importing';progress();
        // New editions first; round-robin classes so all grades begin filling promptly.
        const groups=new Map();
        const languageRank=b=>list(b.medium).includes('English')?0:list(b.medium).includes('Hindi')?1:list(b.medium).includes('Urdu')?2:3;
        for(const b of candidates.sort((a,b)=>languageRank(a)-languageRank(b)||Number(b.year||0)-Number(a.year||0))){
            const grade=list(b.gradeLevel).find(g=>/^Class (?:[1-9]|1[0-2])$/.test(g))||'Other';
            if(!groups.has(grade))groups.set(grade,[]);groups.get(grade).push(b);
        }
        const queue=[];
        while([...groups.values()].some(g=>g.length))for(const group of groups.values())if(group.length)queue.push(group.shift());
        let index=0;
        async function worker(){
            while(index<queue.length && !stopping){
                const candidate=queue[index++];
                try{
                    if(candidate.channel!==NCERT_CHANNEL)throw Error('Unexpected publisher channel');
                    const hierarchyFile=process.env.NCERT_HIERARCHY_CACHE && path.join(process.env.NCERT_HIERARCHY_CACHE,candidate.identifier+'.json');
                    const root=hierarchyFile&&fs.existsSync(hierarchyFile)?JSON.parse(fs.readFileSync(hierarchyFile,'utf8')):
                        (await api(`/action/content/v3/hierarchy/${encodeURIComponent(candidate.identifier)}`)).content;
                    if(!root||root.identifier!==candidate.identifier||!Array.isArray(root.children))throw Error('Incomplete hierarchy');
                    const revision=hash(JSON.stringify({id:candidate.identifier,version:candidate.pkgVersion,published:candidate.lastPublishedOn,root}));
                    const old=await store.get(candidate.identifier);
                    const chapters=textbookChapters(root);
                    const book={id:candidate.identifier,name:candidate.name,grades:list(candidate.gradeLevel),subjects:list(candidate.subject),
                        mediums:list(candidate.medium),year:candidate.year||null,publisher:candidate.publisher||candidate.copyright||'NCERT',
                        license:candidate.license||null,revision,source:'DIKSHA / NCERT channel',syncedAt:new Date().toISOString(),chapters:[]};
                    // Publish after every completed chapter to persist progress. Pending chapters remain explicit.
                    book.chapters=chapters;
                    for(let i=0;i<chapters.length;i++){
                        if(stopping)break;
                        const chapter=chapters[i];
                        const previous=old?.chapters.find(c=>c.id===chapter.id && c.url===chapter.url && c.resourceVersion===chapter.resourceVersion && c.status==='ready');
                        try{
                            chapters[i]=previous&&process.env.NCERT_FORCE!=='1'?{...chapter,...previous}:await resource(chapter);
                        }catch(e){chapters[i]={...chapter,status:'unavailable',error:e.message};}
                        const state=chapters[i].status;
                        report[state==='needs_review'?'review':state==='ready'?'ready':'unavailable']++;
                        await store.put(book);progress();
                        await new Promise(r=>setTimeout(r,150));
                    }
                    if(!chapters.length){report.catalogOnly++;await store.put(book);}
                    for(const grade of book.grades){
                        const stats=report.classes[grade]||={books:0,readyChapters:0,reviewChapters:0,unavailableChapters:0};
                        stats.books++;stats.readyChapters+=chapters.filter(c=>c.status==='ready').length;
                        stats.reviewChapters+=chapters.filter(c=>c.status==='needs_review').length;
                        stats.unavailableChapters+=chapters.filter(c=>c.status==='unavailable').length;
                    }
                }catch(e){report.failed++;report.errors.push({id:candidate.identifier,error:e.message});}
                report.processed++;progress();
                if(report.processed%10===0)console.log(JSON.stringify({processed:report.processed,total:report.discovered,ready:report.ready,review:report.review,unavailable:report.unavailable,failed:report.failed}));
            }
        }
        const workers=Math.min(4,Math.max(1,Number(process.env.NCERT_WORKERS)||3));
        await Promise.all(Array.from({length:workers},worker));
        report.state=stopping?'interrupted':report.failed||report.unavailable||report.review||report.catalogOnly?'completed_with_gaps':'completed';
        report.finishedAt=new Date().toISOString();progress();
        console.log(JSON.stringify(report));
        if(report.failed||report.unavailable)process.exitCode=1;
    }catch(e){report.state='failed';report.error=e.message;progress();throw e;}
    finally{fs.closeSync(lock);fs.unlinkSync(lockPath);}
}
run().then(()=>process.exit(process.exitCode||0)).catch(e=>{console.error(e.message);process.exit(1);});
