const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const jwt=require('jsonwebtoken');
const {Worker}=require('node:worker_threads');
const path=require('node:path');
const db=require('../config/db');
const S=require('../services/studioStore');
const ai=require('../services/ai');
function sample() {
    const assessments={};let n=1;
    for(const stage of ['baseline','practice','followup','retention'])assessments[stage]=[0,1,2].map(()=>{const a=n++;return {prompt:`A walker moves ${a*3} metres in ${a} seconds. What is their average speed in m/s?`,concept:'Average speed',options:['1','2','3','4'],correctIndex:2,explanation:`Divide distance ${a*3} by time ${a} to get 3 m/s.`,sourcePage:null};});
    return {objectives:['Calculate average speed from distance and time.'],lesson:'Average speed is the total distance travelled divided by the time taken. Always use consistent units, such as metres and seconds, and explain what the calculated value means.',workedExample:'For 10 metres in 2 seconds, divide 10 by 2. The average speed is 5 metres per second.',cards:[{front:'How is average speed calculated?',back:'Divide total distance travelled by total time taken.'},{front:'What is a unit of speed?',back:'Metres per second, written m/s.'}],viva:['Explain why average speed needs both distance and time.','How would you convert kilometres per hour into metres per second?'],lab:'motion',assessments};
}
function approvedReview(prompt) {const c=JSON.parse(prompt.split('Draft with answer keys withheld: ')[1].split('.\nFor EVERY')[0]);return {lessonApproved:true,lessonIssues:[],questions:Object.entries(c.assessments).flatMap(([stage,qs])=>qs.map((q,questionIndex)=>({stage,questionIndex,correctIndex:q.options.indexOf('3'),unambiguous:true,explanation:'Divide distance by time to get 3 m/s.'}))) };}
test('Connected Studio protects sources, immutable assignments, independent checks, teacher reviews and aggregate exports',async t=>{
    await S.ready();await require('../controllers/teachingStudioController').ready();
    const app=express();app.use(express.json({limit:'10mb'}));app.use('/api/studio',require('../controllers/studioController'));app.use('/api/learning',require('../controllers/learningController'));app.use('/api/teaching-studio',require('../controllers/teachingStudioController'));
    const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
    const createUser=async(name,role)=>{const r=await db.run('INSERT INTO users (username,password,role) VALUES (?,?,?)',[name,'unused',role]);return {id:r.lastID,token:jwt.sign({user:{id:r.lastID,role}},process.env.JWT_SECRET)};};
    const teacher=await createUser('pack-teacher','teacher'),student=await createUser('pack-student','student'),outsider=await createUser('pack-outsider','student');
    const c=await db.run("INSERT INTO classrooms (name,section,class_code,created_by,status) VALUES ('Physics','A','PACKS',?,'active')",[teacher.id]);const classId=c.lastID;
    await db.run("INSERT INTO teacher_classes (class_id,teacher_id,role) VALUES (?,?,'owner')",[classId,teacher.id]);await db.run("INSERT INTO class_enrollments (class_id,student_id,status) VALUES (?,?,'active')",[classId,student.id]);
    const call=async(url,user,body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/`+url,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+user.token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json()};};
    const old=ai.generateJSON,oldText=ai.generateText;ai.generateJSON=async(p,s)=>s.includes('subject-content reviewer')?approvedReview(p):sample();ai.generateText=async()=> 'Check the time units before dividing. What conversion do you need?';t.after(()=>{ai.generateJSON=old;ai.generateText=oldText;});
    const input={title:'Motion',subject:'Physics',grade:'Class 9',board:'CBSE',edition:'User-supplied edition',language:'Hindi / Hinglish',sourceText:'Distance is measured in metres.',classId,preparationMinutes:5};
    assert.equal((await call('studio/packs',outsider,input)).status,403);
    const created=await call('studio/packs',teacher,input);assert.equal(created.status,201);const id=created.data.id,prefix='studio/packs/'+id;
    const authored=(await call(prefix,teacher)).data.content.assessments, answers=stage=>authored[stage].map(q=>q.correctIndex), wrong=stage=>answers(stage).map((a,i)=>i<2?(a+1)%4:a);
    assert.equal((await call(prefix,outsider)).status,404);
    assert.equal((await call(prefix+'/publish',teacher,{reviewed:true,version:1,students:[outsider.id]})).status,400);
    assert.equal((await call(prefix+'/edit',teacher,{version:99,content:sample()})).status,409);
    assert.equal((await call(prefix+'/publish',teacher,{reviewed:true,version:1,students:[student.id]})).status,200);
    assert.equal((await call(prefix+'/publish',teacher,{reviewed:true,version:1,students:[student.id]})).status,409);
    assert.equal((await call(prefix+'/edit',teacher,{version:2,content:sample()})).status,409);
    const publicPack=(await call(prefix,student)).data;
    assert.equal((await call('learning/dashboard',student)).data.tasks.some(t=>t.packId===id&&t.key.endsWith(':baseline')),true);
    assert.equal((await call('learning/dashboard',outsider)).data.tasks.some(t=>t.packId===id),false);
    assert.equal(publicPack.content.assessments.baseline[0].correctIndex,undefined);assert.equal(publicPack.content.assessments.followup,undefined);assert.equal(publicPack.content.cards.length,0);
    assert.equal((await call(prefix+'/attempts',student,{stage:'followup',answers:answers('followup'),unassisted:true})).status,409);
    assert.equal((await call(prefix+'/attempts',student,{stage:'baseline',answers:answers('baseline')})).status,400);
    const baseline=await call(prefix+'/attempts',student,{stage:'baseline',answers:wrong('baseline'),unassisted:true});assert.equal(baseline.data.score,1);
    const starting=(await call(`studio/classes/${classId}/insights`,teacher)).data;assert.equal(starting.concepts[0].misses,2);assert.equal(starting.concepts[0].signal,'Review suggested');
    const duplicate=await call(prefix+'/attempts',student,{stage:'baseline',answers:answers('baseline'),unassisted:true});assert.equal(duplicate.data.score,1);assert.equal(duplicate.data.alreadySubmitted,true);
    const lesson=(await call(prefix,student)).data;assert.match(lesson.content.lesson,/total distance/);assert.equal(lesson.content.assessments.practice.length,3);assert.equal(lesson.content.assessments.retention,undefined);
    const coached=await call(prefix+'/coach',student,{kind:'working',question:'How do I calculate speed?',response:'I multiplied distance by time.',level:'hint'});assert.equal(coached.status,200);
    await call(`studio/classes/${classId}/coaching/${coached.data.id}/review`,teacher,{feedback:'Divide the distance by time; check the units.'});
    assert.match((await call(prefix,student)).data.coaching[0].teacher_feedback,/Divide/);
    await call(prefix+'/attempts',student,{stage:'practice',answers:wrong('practice')});await call(prefix+'/attempts',student,{stage:'followup',answers:answers('followup'),unassisted:true});
    assert.equal((await call(prefix+'/attempts',student,{stage:'retention',answers:answers('retention'),unassisted:true})).status,409);
    const insights=(await call(`studio/classes/${classId}/insights`,teacher)).data;assert.equal(insights.impact.matchedChecks,1);assert.equal(insights.impact.averageChangePoints,67);assert.equal(insights.impact.preparationMinutes,5);assert.equal(JSON.stringify(insights.impact).includes('pack-student'),false);assert.equal(insights.concepts[0].misses,0);assert.deepEqual(insights.concepts[0].students,[]);
    assert.equal((await call('learning/dashboard',student)).data.tasks.some(t=>t.packId===id),false);
    assert.equal((await call(`studio/classes/${classId}/insights`,student)).status,403);
    await db.run("UPDATE studio_attempts SET created_at=? WHERE pack_id=? AND stage='followup'",[new Date(Date.now()-8*86400000).toISOString(),id]);
    assert.equal((await call('learning/dashboard',student)).data.tasks.some(t=>t.packId===id&&t.key.endsWith(':retention')),true);
    assert.equal((await call(prefix+'/attempts',student,{stage:'retention',answers:answers('retention'),unassisted:true})).status,200);
    await db.run("UPDATE class_enrollments SET status='blocked' WHERE student_id=?",[student.id]);assert.equal((await call(prefix,student)).status,404);assert.equal((await call('studio/packs',student)).data.packs.length,0);
    const upload=await call(`teaching-studio/classes/${classId}/resources`,teacher,{name:'motion.txt',data:Buffer.from('Distance divided by time gives speed.').toString('base64')});assert.equal(upload.status,201);
    const resource=upload.data.id;await db.run("INSERT INTO studio_sources (resource_id,status,pages,warning,updated_at) VALUES (?,'ready',?,'Review needed',?)",[resource,JSON.stringify([{page:1,text:'OCR text'}]),new Date().toISOString()]);
    assert.equal((await call(`studio/classes/${classId}/sources/${resource}`,student)).status,403);
    const review={version:1,pages:[{page:1,text:'Corrected teacher source'}]};assert.equal((await call(`studio/classes/${classId}/sources/${resource}/review`,teacher,review)).status,200);assert.equal((await call(`studio/classes/${classId}/sources/${resource}/review`,teacher,review)).status,409);
    assert.equal((await db.get('SELECT source_text FROM teaching_resources WHERE id=?',[resource])).source_text,'[Source section 1] Corrected teacher source');
    await db.run("UPDATE users SET role='student' WHERE id=?",[teacher.id]);assert.equal((await call(`studio/classes/${classId}/insights`,teacher)).status,403);assert.equal((await call(prefix,teacher)).status,403);
});
test('pack creation rejects content-review failures and keeps repaired generated questions distinct from source citations',async t=>{
    const C=require('../services/studioContent'),old=ai.generateJSON;t.after(()=>{ai.generateJSON=old;});
    let reviews=0;
    ai.generateJSON=async(p,s)=>s.includes('subject-content reviewer')?{lessonApproved:false,lessonIssues:['The displacement cannot be inferred from an unspecified track.'],questions:[]}:sample();
    await assert.rejects(C.generate({title:'Motion'},[]),/did not pass the content checks/);
    ai.generateJSON=async(p,s)=>{if(s.includes('subject-content reviewer'))return ++reviews===1?{lessonApproved:false,lessonIssues:['Repair the calculation.'],questions:[]}:approvedReview(p);const draft=sample();for(const qs of Object.values(draft.assessments))for(const q of qs)q.sourcePage=1;return draft;};
    const repaired=await C.generate({title:'Motion'},[{page:1,text:'Speed is distance divided by time.'}]);assert.equal(reviews,2);
    for(const qs of Object.values(repaired.assessments))for(const q of qs){assert.equal(q.sourcePage,null);assert.equal(q.options[q.correctIndex],'3');}
    const uneven=sample();uneven.assessments.retention[0].concept='Unrelated concept';assert.throws(()=>C.validateContent(uneven),/same concept coverage/);
});
test('background roadmap keeps exact consecutive days, completed state, and resumes after pause',async t=>{
    await S.ready();const R=require('../services/studioRoadmaps');const u=await db.run("INSERT INTO users (username,password,role) VALUES ('roadmap-worker','unused','student')");
    const {id}=await R.create(u.lastID,{examName:'Learn motion',topics:'Distance and speed',days:8,hoursPerDay:1,startDate:'2026-10-01'});
    const batch=async p=>({plan:Array.from({length:Math.min(3,8-p.nextDay+1)},(_,i)=>({day:p.nextDay+i,focus:'Motion '+(p.nextDay+i),date:'2026-10-01'})),outline:[{startDay:1,endDay:8,focus:'Motion learning'}],sourceBasis:'Topic draft'});
    await R.processOne(batch);let row=await db.get('SELECT * FROM studio_roadmaps WHERE id=?',[id]);assert.equal(JSON.parse(row.plan).plan.length,3);
    await db.run("UPDATE studio_roadmaps SET status='paused' WHERE id=?",[id]);assert.equal(await R.processOne(batch),false);
    await db.run("UPDATE studio_roadmaps SET status='queued' WHERE id=?",[id]);await R.processOne(batch);await R.processOne(batch);row=await db.get('SELECT * FROM studio_roadmaps WHERE id=?',[id]);assert.equal(row.status,'complete');assert.deepEqual(JSON.parse(row.plan).plan.map(d=>d.day),[1,2,3,4,5,6,7,8]);
    const bad=await R.create(u.lastID,{examName:'Failed draft',topics:'Algebra basics',days:2,hoursPerDay:1,startDate:'2026-10-01'});await R.processOne(async()=>{throw new Error('Provider unavailable');});const failed=await db.get('SELECT * FROM studio_roadmaps WHERE id=?',[bad.id]);assert.equal(failed.status,'paused');assert.match(failed.error,/Provider unavailable/);
    const other=await db.run("INSERT INTO users (username,password,role) VALUES ('roadmap-outsider','unused','student')");
    const app=express();app.use(express.json());app.use('/roadmaps',require('../controllers/studioRoadmapController'));
    const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
    const call=async(user,path,body)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/roadmaps/${path}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Authorization:'Bearer '+jwt.sign({user:{id:user}},process.env.JWT_SECRET)},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};};
    assert.equal((await call(other.lastID,id)).status,404);
    assert.equal((await call(other.lastID,id+'/action',{action:'complete-day',day:1,completed:true})).status,404);
    assert.equal((await call(u.lastID,id+'/action',{action:'complete-day',day:1,completed:true})).status,200);
    assert.equal((await call(u.lastID,id+'/action',{action:'reschedule',shiftDays:2})).status,200);
    const saved=(await call(u.lastID,id)).data;assert.equal(saved.plan[0].completed,true);assert.equal(saved.plan[0].date,'2026-10-01');assert.equal(saved.plan[1].date,'2026-10-03');assert.equal(saved.examDate,'2026-10-11');assert.equal(saved.daysUntil,8);
});
test('extraction worker handles text, rejects unsupported content, and extracts bounded Office text',async()=>{
    const run=(name,buffer)=>new Promise((resolve,reject)=>{const w=new Worker(path.join(__dirname,'../services/studioExtractWorker.js'),{workerData:{name,data:buffer.toString('base64')}});w.once('message',r=>{w.terminate();resolve(r);});w.once('error',reject);});
    const text=await run('notes.txt',Buffer.from('Speed equals distance divided by time.'));assert.equal(text.status,'ready');assert.match(text.pages[0].text,/Speed/);
    const html=await run('script.html',Buffer.from('<script>alert(1)</script>'));assert.equal(html.status,'unsupported');
    const pdf=await run('broken.pdf',Buffer.from('This is not a PDF'));assert.equal(pdf.status,'failed');
    // A real PDF proxy must be released through loadingTask.
    const makePdf=text=>{
        let pdf='%PDF-1.4\n';const offsets=[0],stream=`BT /F1 18 Tf 30 740 Td (${text}) Tj ET`;
        const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
        objects.forEach((body,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${body}\nendobj\n`;});const xref=Buffer.byteLength(pdf);
        pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
        return Buffer.from(pdf);
    };
    const valid=await run('lesson.pdf',makePdf('Average speed is distance divided by time. Use metres and seconds.'));assert.equal(valid.status,'ready');assert.match(valid.pages[0].text,/distance divided by time/);
    const Zip=require('adm-zip'),zip=new Zip();zip.addFile('word/document.xml',Buffer.from('<w:document><w:p><w:t>Teaching &amp; learning</w:t></w:p></w:document>'));
    const doc=await run('lesson.docx',zip.toBuffer());assert.equal(doc.status,'ready');assert.match(doc.pages[0].text,/Teaching & learning/);assert.match(doc.warning,/not printed page numbers/);
});
