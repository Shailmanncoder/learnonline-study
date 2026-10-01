const {test}=require('node:test');
const assert=require('node:assert/strict');
const {intent,webConversation,publicAddress,readPage,research}=require('../services/companionWeb');
const progress=require('../services/progress');
test('AWS search bypasses stale chapter context and retains the query',()=>{
    assert.deepEqual(intent('search on AWS'),{active:true,url:null,query:'AWS'});
    const history=[{role:'user',content:'Explain chapter seven photosynthesis'},{role:'user',content:'search on AWS'},{role:'assistant',content:'Cloud services'},{role:'user',content:'Explain EC2'}];
    assert.equal(webConversation('and S3?',history),true);
    assert.equal(webConversation('back to my textbook',history),false);
    assert.equal(webConversation('Explain photosynthesis',[]),false);
    assert.equal(intent('read https://docs.aws.amazon.com/ec2/').url,'https://docs.aws.amazon.com/ec2/');
});
test('website reader rejects private and non-HTTPS targets',async()=>{
    for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','172.16.1.1','192.168.1.2','100.64.0.1','::1','::ffff:127.0.0.1','fc00::1']) assert.equal(publicAddress(ip),false,ip);
    assert.equal(publicAddress('8.8.8.8'),true);
    await assert.rejects(readPage('http://example.com'));
    await assert.rejects(readPage('https://127.0.0.1'));
    await assert.rejects(readPage('https://user:password@example.com'));
});
test('lookup reports exact fallback query and only retrieved sources',async()=>{
    const old=process.env.BRAVE_SEARCH_API_KEY; delete process.env.BRAVE_SEARCH_API_KEY;
    try {
        const steps=[];let query;
        const r=await research(intent('search on AWS'),s=>steps.push(s),{lookup:async q=>{query=q;return {title:'Amazon Web Services',url:'https://en.wikipedia.org/wiki/Amazon_Web_Services',extract:'cloud',source:'Wikipedia'};}});
        assert.equal(query,'Amazon Web Services');assert.equal(r.sources.length,1);
        assert(steps.includes('Searching Wikipedia for: Amazon Web Services'));
        assert(!steps.some(s=>/chapter|photosynthesis/i.test(s)));
    } finally {if(old!==undefined) process.env.BRAVE_SEARCH_API_KEY=old;}
});
test('failed page is reported without pretending it was read',async()=>{
    const steps=[];const r=await research(intent('https://example.com'),s=>steps.push(s),{readPage:async()=>{throw new Error('Page timed out');}});
    assert.equal(r.sources.length,0);assert(steps.some(s=>s.includes('timed out')));assert(!steps.some(s=>s.startsWith('Read page')));
});
test('streamed answers remain private to request owner',()=>{
    const handle=progress.start('companion-test-01',7);progress.answer(handle,'AWS is a cloud platform.');
    assert.equal(progress.read('companion-test-01',8),null);
    assert.equal(progress.read('companion-test-01',7).answer,'AWS is a cloud platform.');
});

test('reusing another user request id cannot receive their streamed answer',()=>{
 const progress=require('../services/progress');
 const first=progress.start('shared-request-id',7);
 const second=progress.start('shared-request-id',8);
 progress.answer(first,'Private answer for seven');progress.answer(second,'Answer for eight');
 assert.equal(progress.read('shared-request-id',7).answer,'Private answer for seven');
 assert.equal(progress.read('shared-request-id',8).answer,'Answer for eight');
});
