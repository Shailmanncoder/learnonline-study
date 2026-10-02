const {Worker}=require('node:worker_threads');
const path=require('node:path');
const {db,ready,now}=require('./studioStore');
let running=false;
function extractPreview(file) {
    return new Promise(resolve=>{
        const worker=new Worker(path.join(__dirname,'studioExtractWorker.js'),{workerData:file,resourceLimits:{maxOldGenerationSizeMb:256}});
        let finished=false;
        const finish=r=>{if(finished)return;finished=true;clearTimeout(timer);worker.terminate().catch(()=>{});resolve(r);};
        const timer=setTimeout(()=>finish({status:'failed',pages:[],warning:'Extraction reached its two-minute limit. Split the file or paste its text.'}),120000);
        worker.once('message',finish);worker.once('error',()=>finish({status:'failed',pages:[],warning:'The document could not be read. Try a smaller file or paste its text.'}));
        worker.once('exit',()=>finish({status:'failed',pages:[],warning:'Extraction stopped. Retry or paste its text.'}));
    });
}
async function drain() {
    if(running)return;running=true;
    try {
        await ready();
        for(;;) {
            const file=await db.get(`SELECT r.id,r.name,r.data FROM studio_sources s JOIN teaching_resources r ON r.id=s.resource_id WHERE s.status='queued' ORDER BY s.updated_at LIMIT 1`);
            if(!file)break;
            const claim=await db.run("UPDATE studio_sources SET status='processing',updated_at=? WHERE resource_id=? AND status='queued'",[now(),file.id]);
            if(!claim.changes)continue;
            const result=await new Promise(resolve=>{
                const worker=new Worker(path.join(__dirname,'studioExtractWorker.js'),{workerData:file,resourceLimits:{maxOldGenerationSizeMb:256}});
                let finished=false;
                const finish=r=>{if(finished)return;finished=true;clearTimeout(timer);worker.terminate().catch(()=>{});resolve(r);};
                const timer=setTimeout(()=>finish({status:'failed',pages:[],warning:'Extraction reached its two-minute limit. Split the file into smaller parts, or paste the source text.'}),120000);
                worker.once('message',finish);worker.once('error',()=>finish({status:'failed',pages:[],warning:'The file could not be extracted. Try a smaller PDF or paste the text.'}));
                worker.once('exit',()=>finish({status:'failed',pages:[],warning:'Extraction stopped. Retry or paste the text.'}));
            });
            await db.transaction(async()=>{
                await db.run('UPDATE studio_sources SET status=?,pages=?,warning=?,version=version+1,updated_at=? WHERE resource_id=? AND status=\'processing\'',[result.status,JSON.stringify(result.pages),result.warning,now(),file.id]);
                await db.run('UPDATE teaching_resources SET source_text=? WHERE id=?',[result.pages.map(p=>`[Source section ${p.page}] ${p.text}`).join('\n\n').slice(0,24000),file.id]);
            });
        }
    } finally {running=false;}
}
async function start() {
    await ready();
    // A stale processing state is retried only after a crashed worker's deadline.
    const timer=setInterval(()=>db.run("UPDATE studio_sources SET status='queued' WHERE status='processing' AND updated_at<?",[new Date(Date.now()-180000).toISOString()]).then(drain).catch(e=>console.warn('[SOURCE]',e.message)),15000);
    timer.unref();drain().catch(e=>console.warn('[SOURCE]',e.message));
}
module.exports={drain,start,extractPreview};
