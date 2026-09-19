const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const learning = require('../services/learning');

test('learning journeys preserve ownership, grading integrity, retries and teacher review', async t => {
    await db.ready(); await learning.ready();
    for (const [id, name] of [[1,'student'],[2,'outsider'],[3,'teacher']]) await db.run('INSERT INTO users (id, username, password) VALUES (?, ?, ?)', [id,name,'unused']);
    const app = express(); app.use(express.json());
    app.use('/api/study',require('../controllers/studyController'));
    app.use('/api/learning',require('../controllers/learningController'));
    app.use('/api/classroom',require('../controllers/classroomController'));
    app.use('/api/review',require('../controllers/reviewController'));
    const server = await new Promise(resolve => {const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    t.after(()=>new Promise(resolve=>server.close(resolve)));
    const base='http://127.0.0.1:'+server.address().port;
    async function call(path, user=1, body, method) {
        const token=jwt.sign({user:{id:user}},process.env.JWT_SECRET);
        const r=await fetch(base+'/api/'+path,{method:method||(body?'POST':'GET'),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
        return { status:r.status, data:await r.json() };
    }
    const questions=[{question:'2 + 2?',options:['3','4','5','6'],correctIndex:1,explanation:'Two pairs make four.'}];
    let quiz;
    await t.test('answer keys stay on server and forged client quizzes are rejected',async()=>{
        quiz=await learning.createQuiz(1,'Arithmetic',questions);
        assert.equal(quiz.questions[0].correctIndex,undefined);
        assert.equal((await call('study/quiz/submit',1,{questions,answers:[1]})).status,400);
        assert.equal((await call('study/quiz/submit',2,{quizId:quiz.quizId,answers:[1]})).status,404);
        assert.equal((await call('study/quiz/submit',1,{quizId:quiz.quizId,answers:[]})).status,400);
    });
    await t.test('concurrent quiz retries award XP once and record one mistake',async()=>{
        const results=await Promise.all([call('study/quiz/submit',1,{quizId:quiz.quizId,answers:[0]}),call('study/quiz/submit',1,{quizId:quiz.quizId,answers:[0]})]);
        assert.ok(results.every(r=>r.status===200));
        assert.equal(results.reduce((s,r)=>s+r.data.xpEarned,0),10);
        assert.equal((await db.get('SELECT COUNT(*) AS n FROM quiz_attempts')).n,1);
        assert.equal((await db.get('SELECT COUNT(*) AS n FROM learning_mistakes')).n,1);
    });
    await t.test('spaced retests require ownership and prevent immediate replay',async()=>{
        const m=(await call('learning/mistakes')).data.mistakes[0];
        assert.equal(m.correct_index,undefined);
        assert.equal((await call(`learning/mistakes/${m.id}/review`,2,{answer:1})).status,404);
        const r=await call(`learning/mistakes/${m.id}/review`,1,{answer:1});assert.equal(r.data.correct,true);
        assert.equal((await call(`learning/mistakes/${m.id}/review`,1,{answer:1})).status,409);
    });
    await t.test('goals, daily plan, completion, export and account isolation',async()=>{
        assert.equal((await call('learning/goals',1,{title:'Exam',examDate:'2030-02-30',minutes:20,topics:['Arithmetic']})).status,400);
        const g=await call('learning/goals',1,{title:'Exam',examDate:'2030-12-20',minutes:20,topics:['Arithmetic']});assert.equal(g.status,200);
        const day=new Date().toISOString().slice(0,10);
        const plan=(await call('learning/dashboard?day='+day)).data;
        const task=plan.tasks.find(t=>t.key==='goal:'+g.data.id);assert.equal(task.topic,'Arithmetic');
        assert.equal((await call('learning/checkins',1,{day,taskKey:task.key,completed:true})).status,200);
        assert.equal((await call('learning/dashboard?day='+day)).data.tasks.find(t=>t.key===task.key).completed,true);
        assert.equal((await call('learning/dashboard',2)).data.goals.length,0);
        await call('learning/goals/'+g.data.id,2,null,'DELETE');
        assert.equal((await call('learning/export')).data.goals.length,1);
    });
    await db.run("INSERT INTO classrooms (id,name,section,created_by,class_code) VALUES (1,'Science','A',3,'TESTCLASS')");
    await db.run('INSERT INTO teacher_classes (class_id,teacher_id) VALUES (1,3)');
    await db.run('INSERT INTO class_enrollments (class_id,student_id) VALUES (1,1)');
    const worksheet={questions:[{id:1,type:'mcq',question:'2 + 2?',options:['3','4'],correct_answer:'4',explanation:'Addition',marks:2}]};
    await db.run('INSERT INTO class_worksheets (id,class_id,teacher_id,title,subject,worksheet_data,total_marks) VALUES (1,1,3,?,?,?,?)',['Addition','Math',JSON.stringify(worksheet),2]);
    await t.test('classroom list and stream strip answer keys; outsider and draft submissions denied',async()=>{
        const list=(await call('classroom/1/worksheets')).data.worksheets;
        assert.equal(JSON.parse(list[0].worksheet_data).questions[0].correct_answer,undefined);
        const feed=(await call('classroom/1/feed')).data.stream.worksheets;
        assert.equal(JSON.parse(feed[0].worksheet_data).questions[0].explanation,undefined);
        assert.equal((await call('classroom/worksheets/1/submit',2,{answers:[{id:1,answer:'4'}]})).status,403);
        await db.run("UPDATE class_worksheets SET status='draft' WHERE id=1");
        assert.equal((await call('classroom/worksheets/1/submit',1,{answers:[]})).status,403);
        await db.run("UPDATE class_worksheets SET status='published' WHERE id=1");
        const rs=await Promise.all([call('classroom/worksheets/1/submit',1,{answers:[{id:1,answer:'4'}]}),call('classroom/worksheets/1/submit',1,{answers:[{id:1,answer:'4'}]})]);
        assert.equal(rs.reduce((s,r)=>s+r.data.xpEarned,0),25);
    });
    await t.test('homework resubmission clears stale grading and does not duplicate XP',async()=>{
        await db.run("INSERT INTO class_homework (id,class_id,teacher_id,title,subject) VALUES (1,1,3,'Homework','Math')");
        const first=await call('classroom/homework/1/submit',1,{content:'First answer'}); assert.equal(first.data.xpEarned,30);
        await db.run("UPDATE homework_submissions SET marks=90, graded_at=CURRENT_TIMESTAMP, graded_by=3, feedback='Old feedback'");
        const second=await call('classroom/homework/1/submit',1,{content:'Revised answer'});assert.equal(second.data.xpEarned,0);
        const sub=await db.get('SELECT * FROM homework_submissions');assert.equal(sub.marks,null);assert.equal(sub.graded_at,null);assert.equal(sub.feedback,null);
    });
    await t.test('uncertain grading goes through authorized teacher review exactly once',async()=>{
        await db.run('UPDATE class_worksheets SET worksheet_data=? WHERE id=1',[JSON.stringify({questions:[{id:1,type:'short_answer',question:'Explain addition',correct_answer:'Combining numbers into a total',marks:2}]})]);
        const submission=await call('classroom/worksheets/1/submit',1,{answers:[{id:1,answer:'Combining numbers'}]});
        assert.equal(submission.data.pendingReview,true);assert.equal(submission.data.xpEarned,0);
        const queue=(await call('review/queue',3)).data.attempts;assert.equal(queue.length,1);
        assert.equal((await call('review/queue',2)).data.attempts.length,0);
        const payload={grades:[{id:1,awarded:2,feedback:'Correct explanation.'}]};
        assert.equal((await call('review/'+queue[0].id,2,payload)).status,404);
        assert.equal((await call('review/'+queue[0].id,3,{grades:[{id:1,awarded:9,feedback:'No'}]})).status,400);
        assert.equal((await call('review/'+queue[0].id,3,payload)).data.score,2);
        assert.equal((await call('review/'+queue[0].id,3,payload)).status,409);
        assert.equal((await call('review/queue',3)).data.attempts.length,0);
    });
    await t.test('failed transactions roll back without absorbing concurrent requests',async()=>{
        const before=(await db.get('SELECT xp FROM users WHERE id=1')).xp;
        await assert.rejects(db.transaction(async()=>{await db.run('UPDATE users SET xp=9999 WHERE id=1');throw new Error('rollback');}));
        assert.equal((await db.get('SELECT xp FROM users WHERE id=1')).xp,before);
    });
});
