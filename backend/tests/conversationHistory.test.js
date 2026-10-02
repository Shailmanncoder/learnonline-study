const {test}=require('node:test'),assert=require('node:assert/strict');
const express=require('express'),jwt=require('jsonwebtoken'),db=require('../config/db');
test('reopening a long conversation returns its most recent messages and keeps ownership',async t=>{
 await db.ready();await db.run("INSERT INTO users(id,username,password) VALUES(1,'history-owner','unused'),(2,'history-outsider','unused')");
 const thread=await db.run("INSERT INTO chat_threads(user_id,title) VALUES(1,'Long chat')");
 await db.transaction(async()=>{for(let i=1;i<=205;i++)await db.run('INSERT INTO chat_messages(thread_id,user_id,role,content) VALUES(?,1,?,?)',[thread.lastID,i%2?'user':'assistant','message '+i]);});
 const app=express();app.use('/ai',require('../controllers/aiController'));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const call=id=>fetch(`http://127.0.0.1:${server.address().port}/ai/threads/${thread.lastID}`,{headers:{Authorization:'Bearer '+jwt.sign({user:{id}},process.env.JWT_SECRET)}});
 const r=await call(1);assert.equal(r.status,200);const data=await r.json();assert.equal(data.messages.length,200);assert.equal(data.messages[0].content,'message 6');assert.equal(data.messages.at(-1).content,'message 205');assert.equal((await call(2)).status,404);
});
