const router=require('express').Router();
const auth=require('../middleware/auth');
const S=require('../services/studioStore');
const R=require('../services/studioRoadmaps');
const {db,fail,lock,now}=S;
const wrap=fn=>async(req,res)=>{try{await S.ready();await fn(req,res);}catch(e){res.status(e.status||400).json({msg:e.message});}};
router.use(auth);
router.post('/import',wrap(async(req,res)=>{
    const roadmap=require('../services/roadmap'),{randomUUID}=require('node:crypto');
    const c=roadmap.config({...req.body,days:req.body.daysUntil});
    const days=req.body.plan;
    if(req.body.qualityVersion!==2||!Array.isArray(days)||days.length>c.daysUntil||days.some((d,i)=>!roadmap.validateDays([d],i+1,1,Math.round(c.hoursPerDay*60))))fail(400,'This saved plan needs the current day structure before it can be synced. Download it to preserve the original.');
    const id=randomUUID(),p={...c,plan:days,outline:req.body.outline||[],sourceBasis:String(req.body.sourceBasis||'Imported plan; source alignment not independently verified').slice(0,2000),qualityVersion:2,complete:days.length===c.daysUntil};
    await db.run('INSERT INTO studio_roadmaps (id,user_id,plan,status,created_at,updated_at) VALUES (?,?,?,?,?,?)',[id,req.user.id,JSON.stringify(p),p.complete?'complete':'paused',now(),now()]);
    res.status(201).json({id});
}));
router.get('/',wrap(async(req,res)=>{
    const rows=await db.all('SELECT id,status,error,version,created_at,updated_at,plan FROM studio_roadmaps WHERE user_id=? ORDER BY created_at DESC LIMIT 20',[req.user.id]);
    res.json({roadmaps:rows.map(r=>{const p=JSON.parse(r.plan);return {id:r.id,title:p.examName,status:r.status,ready:p.plan.length,days:p.daysUntil,createdAt:r.created_at};})});
}));
router.post('/',wrap(async(req,res)=>{const result=await R.create(req.user.id,req.body);R.drain().catch(e=>console.warn('[ROADMAP]',e.message));res.status(202).json(result);}));
router.get('/:id',wrap(async(req,res)=>{const r=await db.get('SELECT * FROM studio_roadmaps WHERE id=? AND user_id=?',[req.params.id,req.user.id]);if(!r)fail(404,'Roadmap not found.');res.json(R.unpack(r));}));
router.post('/:id/action',wrap(async(req,res)=>{
    await db.transaction(async()=>{
        // Account lock keeps the one-running-plan rule consistent with creation.
        await db.get('SELECT id FROM users WHERE id=?'+lock(),[req.user.id]);
        const r=await db.get('SELECT * FROM studio_roadmaps WHERE id=? AND user_id=?'+lock(),[req.params.id,req.user.id]);
        if(!r)fail(404,'Roadmap not found.');
        const p=JSON.parse(r.plan),action=req.body.action;
        if(action==='pause')await db.run("UPDATE studio_roadmaps SET status=?,updated_at=? WHERE id=?",[p.complete?'complete':'paused',now(),r.id]);
        else if(action==='resume') {
            if(p.complete)return;
            const active=await db.get("SELECT id FROM studio_roadmaps WHERE user_id=? AND id<>? AND status IN ('queued','generating')",[req.user.id,r.id]);
            if(active)fail(409,'Pause the other running plan first.');
            // Do not release an active lease when a paused batch is still finishing.
            await db.run('UPDATE studio_roadmaps SET status=?,error=?,updated_at=? WHERE id=?',[r.lease_token&&r.lease_until>now()?'generating':'queued','',now(),r.id]);
        } else if(action==='complete-day') {
            const d=p.plan.find(d=>d.day===req.body.day);
            if(!d||typeof req.body.completed!=='boolean')fail(400,'Choose a generated day.');
            d.completed=req.body.completed;
            await db.run('UPDATE studio_roadmaps SET plan=?,version=version+1,updated_at=? WHERE id=?',[JSON.stringify(p),now(),r.id]);
        } else if(action==='reschedule') {
            if(!Number.isInteger(req.body.shiftDays)||req.body.shiftDays<1||req.body.shiftDays>365)fail(400,'Choose a shift of 1–365 days.');
            if(r.status==='generating'||r.status==='queued'||r.lease_token)fail(409,'Pause generation and wait for the current batch to finish before rescheduling.');
            const shift=req.body.shiftDays*86400000;
            const move=date=>new Date(Date.parse(date+'T00:00:00Z')+shift).toISOString().slice(0,10);
            p.startDate=move(p.startDate);p.examDate=move(p.examDate);
            p.plan=p.plan.map(d=>d.completed?d:{...d,date:move(d.date)});
            await db.run('UPDATE studio_roadmaps SET plan=?,version=version+1,updated_at=? WHERE id=?',[JSON.stringify(p),now(),r.id]);
        } else fail(400,'Unknown roadmap action.');
    });
    R.drain().catch(e=>console.warn('[ROADMAP]',e.message));res.json({success:true});
}));
module.exports=router;
