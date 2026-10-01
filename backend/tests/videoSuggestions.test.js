const {test}=require('node:test');const assert=require('node:assert/strict');const {suggest,clarification}=require('../services/videoSuggestions');
test('class 12 basic motion asks for clarification; magnetic motion is allowed',()=>{assert.match(clarification('Suggest Class 12 CBSE physics motion video'),/Class 11/);assert.equal(clarification('Class 12 motion of charged particles video'),null);});
test('no API key produces a labelled search link, never an invented recommendation',async()=>{const old=process.env.YOUTUBE_API_KEY;delete process.env.YOUTUBE_API_KEY;try{const r=await suggest('Suggest a Hindi video on fractions');assert.equal(r.videos.length,0);assert.match(r.reply,/haven't checked/);assert.match(r.searchUrl,/youtube.com\/results/);}finally{if(old)process.env.YOUTUBE_API_KEY=old;}});
test('ranking can only return retrieved public videos and deduplicates invented IDs',async()=>{const old=process.env.YOUTUBE_API_KEY;process.env.YOUTUBE_API_KEY='test';let calls=0;try{const r=await suggest('Suggest a video on fractions',{fetcher:async()=>({ok:true,json:async()=>++calls===1?{items:[{id:{videoId:'abc12345678'}}]}:{items:[{id:'abc12345678',status:{privacyStatus:'public'},snippet:{title:'Fractions explained',channelTitle:'Math channel',liveBroadcastContent:'none',publishedAt:'2026-01-01'},contentDetails:{duration:'PT10M'}}]}}),generate:async()=>({picks:[{id:'invented-id',reason:'made up'},{id:'abc12345678',reason:'Topic matches fractions'},{id:'abc12345678',reason:'duplicate'}]})});assert.equal(r.videos.length,1);assert.match(r.reply,/Latest-NCERT alignment is not verified/);assert.match(r.videos[0].url,/abc12345678$/);}finally{if(old)process.env.YOUTUBE_API_KEY=old;else delete process.env.YOUTUBE_API_KEY;}});

test('video clarification follows the conversation without intercepting summaries',()=>{
 const {resolveRequest,isVideoRequest}=require('../services/videoSuggestions');
 assert.equal(isVideoRequest('Summarize this video transcript'),false);
 assert.match(resolveRequest('Class 11 kinematics in Hindi',[{role:'assistant',content:'Do you mean **Class 11 kinematics** or charged particles?'}]),/Suggest a YouTube/);
});

test('one shot retains class and topic across language refinements but not topic changes',()=>{
 const {resolveRequest}=require('../services/videoSuggestions');
 const history=[{role:'user',content:'suggest me best video for cbse class 9 motion'},{role:'assistant',content:'Here are videos'}];
 assert.match(resolveRequest('one shot',history),/class 9 motion.*one shot/);
 history.push({role:'user',content:'one shot'},{role:'assistant',content:'Results'});
 assert.match(resolveRequest('in Hindi',history),/class 9 motion.*one shot.*Hindi/);
 assert.equal(resolveRequest('explain acceleration',history),null);
 history.push({role:'user',content:'explain acceleration'});
 assert.equal(resolveRequest('one shot',history),null);
});

test('language labels alone cannot establish speech and conflicting evidence stays unknown',()=>{
 const {languageEvidence,requestedLanguage}=require('../services/videoSuggestions');
 assert.equal(languageEvidence({title:'Motion one shot',description:'',language:'en-IN'}),null);
 assert.equal(languageEvidence({title:'Motion in Hindi',description:'',language:'en-IN'}),null);
 assert.equal(languageEvidence({title:'Motion in Hinglish',description:'',language:'hi'}),'hindi');
 assert.equal(requestedLanguage('in English; requested refinements: in Hindi'),'hindi');
});

test('spoken language preferences do not mistake an English subject for English speech',()=>{
 const {requestedLanguage,videoPreference}=require('../services/videoSuggestions');
 assert.equal(requestedLanguage('Suggest a video for CBSE class 9 English'),null);
 assert.equal(requestedLanguage('Suggest a Hindi video for CBSE class 9 English'),'hindi');
 assert.equal(videoPreference([{role:'user',content:'Always suggest videos in Hindi'},{role:'assistant',content:'Always suggest English videos'}]),'hindi');
 assert.equal(videoPreference([{role:'user',content:'Always suggest videos in Hindi'},{role:'user',content:'forget my preferences'}]),null);
});
