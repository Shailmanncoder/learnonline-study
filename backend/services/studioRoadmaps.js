const {randomUUID}=require('node:crypto');
const {db,ready,now,lock,fail,quota}=require('./studioStore');
const roadmap=require('./roadmap');
let running=false;
function unpack(row){return {id:row.id,version:row.version,state:row.status,error:row.error,...JSON.parse(row.plan)};}
async function processOne(generate=roadmap.batch) {
    await ready();
    const claim=await db.transaction(async()=>{
        const row=await db.get(`SELECT r.* FROM studio_roadmaps r JOIN users u ON u.id=r.user_id WHERE r.status='queued' OR (r.status='generating' AND r.lease_until<?) ORDER BY r.updated_at LIMIT 1`+lock(),[now()]);
        if(!row)return null;
        const token=randomUUID();
        await db.run("UPDATE studio_roadmaps SET status='generating',lease_token=?,lease_until=? WHERE id=?",[token,new Date(Date.now()+180000).toISOString(),row.id]);
        return {...row,token};
    });
    if(!claim)return false;
    const heartbeat=setInterval(()=>db.run('UPDATE studio_roadmaps SET lease_until=? WHERE id=? AND lease_token=?',[new Date(Date.now()+180000).toISOString(),claim.id,claim.token]).catch(()=>{}),30000);heartbeat.unref();
    try {
        const saved=JSON.parse(claim.plan);
        const result=await generate({...saved,days:saved.daysUntil,nextDay:saved.plan.length+1,previous:saved.plan.slice(-42)});
        if(!Array.isArray(result.plan)||!result.plan.length||result.plan.length>3||result.plan.some((d,i)=>d.day!==saved.plan.length+i+1)||saved.plan.length+result.plan.length>saved.daysUntil)throw new Error('The generated batch skipped or duplicated a day.');
        await db.transaction(async()=>{
            const current=await db.get('SELECT * FROM studio_roadmaps WHERE id=?'+lock(),[claim.id]);
            if(!current||current.lease_token!==claim.token)return;
            const latest=JSON.parse(current.plan);
            const plan={...latest,outline:result.outline,sourceBasis:result.sourceBasis,plan:[...latest.plan,...result.plan],qualityVersion:2,complete:latest.plan.length+result.plan.length===latest.daysUntil};
            await db.run('UPDATE studio_roadmaps SET plan=?,status=?,error=?,version=version+1,lease_until=NULL,lease_token=NULL,updated_at=? WHERE id=?',[JSON.stringify(plan),plan.complete?'complete':current.status==='paused'?'paused':'queued','',now(),claim.id]);
        });
    } catch(e) {
        await db.run("UPDATE studio_roadmaps SET status='paused',error=?,lease_until=NULL,lease_token=NULL,updated_at=? WHERE id=? AND lease_token=?",[String(e.message).slice(0,1000),now(),claim.id,claim.token]);
    } finally {clearInterval(heartbeat);}
    return true;
}
async function drain(){if(running)return;running=true;try{while(await processOne()){} }finally{running=false;}}
function start(){const timer=setInterval(()=>drain().catch(e=>console.warn('[ROADMAP]',e.message)),10000);timer.unref();drain().catch(e=>console.warn('[ROADMAP]',e.message));}
async function create(userId,input) {
    const c=roadmap.config(input);await quota(userId);
    return db.transaction(async()=>{
        await db.get('SELECT id FROM users WHERE id=?'+lock(),[userId]);
        const active=await db.get("SELECT id FROM studio_roadmaps WHERE user_id=? AND status IN ('queued','generating')",[userId]);
        if(active)fail(409,'Pause your running plan before starting another.');
        const id=randomUUID(),plan={...c,plan:[],complete:false,qualityVersion:2};
        await db.run("INSERT INTO studio_roadmaps (id,user_id,plan,status,created_at,updated_at) VALUES (?,?,?,'queued',?,?)",[id,userId,JSON.stringify(plan),now(),now()]);
        return {id};
    });
}
module.exports={start,drain,processOne,create,unpack};
