const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {once}=require('node:events');
test('Companion streams, saves history and passes retrieved sources to every provider',async t=>{
    const db=require('../config/db'), memory=require('../services/studyMemory'), web=require('../services/companionWeb'), progress=require('../services/progress');
    let saved=[], providerInput;
    // The Companion is a Plus feature, so this account holds one — otherwise
    // the request is refused at the gate and the streaming, history and source
    // behaviour under test here is never reached.
    t.mock.method(db,'get',async sql=>
        sql.includes('chat_threads') ? {id:91,title:'Cloud chat'} :
        sql.includes('payment_entitlements') ? {plan_id:'plus',ends_at:Date.now()+86400000} : null);
    t.mock.method(db,'all',async()=>[{role:'assistant',content:'We studied photosynthesis.'},{role:'user',content:'Explain chapter seven'}]);
    t.mock.method(db,'run',async(sql,args)=>{if(sql.includes('INSERT INTO chat_messages'))saved.push(args);return {};});
    t.mock.method(memory,'buildStudyContext',async()=>{throw new Error('Stale study context must not be read');});
    t.mock.method(web,'research',async(request,step)=>{assert.equal(request.query,'AWS');step('Searching the web for: AWS');return {sources:[{title:'AWS',url:'https://aws.amazon.com',source:'Website'}],context:'VERIFIED AWS PAGE: cloud computing.'};});
    const authPath=require.resolve('../middleware/auth');require(authPath);
    const oldAuth=require.cache[authPath].exports;require.cache[authPath].exports=(req,res,next)=>{req.user={id:7};next();};
    t.after(()=>{require.cache[authPath].exports=oldAuth;});
    for(const provider of ['groq','gemini','replit']) {
        await t.test(provider,async t=>{
            saved=[];providerInput=null;
            process.env.GROQ_API_KEY=provider==='groq'?'test-groq-key':'';
            process.env.GEMINI_API_KEY=provider==='gemini'?'test-gemini-key':'';
            process.env.AI_PROVIDER=provider;
            process.env.AI_INTEGRATIONS_GEMINI_BASE_URL=provider==='replit'?'https://example.invalid/v1':'';
            process.env.AI_INTEGRATIONS_GEMINI_API_KEY=provider==='replit'?'test-replit-key':'';
            const moduleName=provider==='groq'?'groq-sdk':provider==='gemini'?'@google/generative-ai':'openai';
            const modulePath=require.resolve(moduleName);require(modulePath);const previous=require.cache[modulePath].exports;
            async function* chunks(gemini=false) {
                yield gemini?{text:()=> 'AWS is '}:{choices:[{delta:{content:'AWS is '}}]};
                await new Promise(resolve=>setTimeout(resolve,15));
                assert.equal(progress.read(`flow-test-${provider}`,7).answer,'AWS is');
                yield gemini?{text:()=> 'a cloud platform.'}:{choices:[{delta:{content:'a cloud platform.'}}]};
            }
            const completion=async options=>{providerInput=options.messages;assert.equal(options.stream,true);return chunks();};
            require.cache[modulePath].exports=provider==='gemini'?{GoogleGenerativeAI:class { getGenerativeModel(options){providerInput=options.systemInstruction;return {startChat:()=>({sendMessageStream:async()=>({stream:chunks(true)})})};}}}:class { constructor(){this.chat={completions:{create:completion}};} };
            const controller=require.resolve('../controllers/aiController');delete require.cache[controller];
            const app=express();app.use(express.json());app.use('/ai',require(controller));
            const server=app.listen(0,'127.0.0.1');await once(server,'listening');
            try {
                const response=await fetch(`http://127.0.0.1:${server.address().port}/ai/generate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:'search on AWS',threadId:91,useMemory:true,requestId:`flow-test-${provider}`})});
                const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));
                assert.equal(result.result,'AWS is a cloud platform.');assert.equal(result.threadId,91);assert.equal(result.webSources.length,1);
                assert(JSON.stringify(providerInput).includes('VERIFIED AWS PAGE'));
                assert(saved.some(row=>row[2]==='user'&&row[3]==='search on AWS'));
                assert(saved.some(row=>row[2]==='assistant'&&row[3]==='AWS is a cloud platform.'));
                assert(!result.steps.some(step=>/reading.*chapter/i.test(step)));
            } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));require.cache[modulePath].exports=previous;delete require.cache[controller];}
        });
    }
});
