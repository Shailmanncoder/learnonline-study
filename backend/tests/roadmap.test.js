const {test}=require('node:test');const assert=require('node:assert/strict');
const {config,batch}=require('../services/roadmap');
const input={examName:'Build a useful web app',topics:'Beginner JavaScript, accessibility, testing, deployment and user feedback',days:62,startDate:'2026-09-30',hoursPerDay:1};
function fake(prompt){if(prompt.startsWith('Review candidate'))return {approved:true,issues:[]};if(prompt.startsWith('Design a global'))return {phases:[{startDay:1,endDay:62,focus:'Develop skills and a practical application progressively'}]};const [,start,end]=prompt.match(/Create days (\d+) through (\d+)/);return {plan:Array.from({length:Number(end)-Number(start)+1},(_,i)=>({day:Number(start)+i,focus:'Build and test feature number '+(Number(start)+i),tasks:[{action:'Implement and document the planned feature',minutes:40},{action:'Test the feature with example users',minutes:20}],lesson:'A function groups a sequence of instructions so that the program can reuse it. Parameters supply the inputs, and the return statement supplies the result. Test with multiple input pairs to establish correct behavior.',workedExample:'Define add(a,b) to return a+b. With a=2 and b=3 the expression becomes 2+3, so the expected return value is 5. Test zero and negative inputs as well.',outcome:'A working feature with documented test results',check:'All three acceptance checks pass independently',practice:[{prompt:'Write a function that returns the sum of two numbers.',answer:'Use return a + b; verify inputs 2 and 3 return 5.'}]}))};}
test('62 days means exactly 62 consecutive calendar days, including short final batch',async()=>{let days=[];while(days.length<62){const r=await batch({...input,nextDay:days.length+1,previous:days.slice(-7)},async p=>fake(p));days.push(...r.plan);assert.equal(r.complete,days.length===62);}assert.deepEqual(days.map(d=>d.day),Array.from({length:62},(_,i)=>i+1));assert.equal(days[0].date,'2026-09-30');assert.equal(days[61].date,'2026-11-30');});
test('no old 120-day ceiling and correct leap-year date calculation',()=>{assert.equal(config({...input,days:1000}).daysUntil,1000);assert.equal(config({...input,days:undefined,startDate:'2028-02-28',examDate:'2028-03-01'}).daysUntil,2);});
test('shortened, duplicate and unrealistic AI output cannot be marked complete',async()=>{for(const mode of ['short','duplicate','material']){let calls=0;await assert.rejects(batch({...input,outline:[{startDay:1,endDay:62,focus:'A complete learning progression'}]},async p=>{calls++;const r=fake(p);if(mode==='short')r.plan.pop();if(mode==='duplicate')r.plan[1].day=1;if(mode==='material')r.plan[0].practice=[];return r;}),/could not be completed/);assert.equal(calls,2);}});
test('invalid dates, duration and daily budget are rejected before AI use',()=>{for(const change of [{days:0},{days:1.5},{startDate:'2026-02-30'},{hoursPerDay:25}])assert.throws(()=>config({...input,...change}));});

test('global outline must cover the whole duration without gaps or overlaps',()=>{
 const {validOutline}=require('../services/roadmap');
 assert.equal(validOutline([{startDay:1,endDay:30,focus:'Develop all core fundamentals'},{startDay:31,endDay:62,focus:'Build, test and refine a practical project'}],62),true);
 assert.equal(validOutline([{startDay:1,endDay:20,focus:'Develop all core fundamentals'},{startDay:22,endDay:62,focus:'Build a practical project'}],62),false);
});


test('roadmap rejects invented chapters, phantom resources and unmarked repetition',()=>{
 const {qualityIssues}=require('../services/roadmap');
 const day=fake('Create days 1 through 1').plan[0];
 const c={curriculum:''};
 assert.ok(qualityIssues([{...day,focus:'Chapter 3 assessment'}],c).some(x=>x.includes('chapter 3')));
 assert.ok(qualityIssues([{...day,practice:[]}],c).some(x=>x.includes('practice prompts')));
 assert.ok(qualityIssues([{...day,day:2}],c,[day]).some(x=>x.includes('repeated focus')));
 assert.equal(qualityIssues([{...day,day:2,reviewOf:1}],c,[day]).length,0);
 assert.ok(qualityIssues([{...day,check:'Check against the answer key.'}],c).some(x=>x.includes('unavailable resource')));
 assert.equal(qualityIssues([{...day,focus:'Chapter 3 assessment'}],{curriculum:'Chapter 3: Web app design'}).length,0);
});

test('AI-supplied time estimates cannot overrun the server daily budget',async()=>{
 const r=await batch({...input,outline:[{startDay:1,endDay:62,focus:'A complete learning progression'}]},async p=>{const r=fake(p);if(r.plan)r.plan[0].tasks[0].minutes=999;return r;});
 assert.ok(r.plan.every(d=>d.tasks.reduce((n,t)=>n+t.minutes,0)===60));
});
test('failed content review never publishes a mathematically wrong draft',async()=>{
 await assert.rejects(batch({...input,outline:[{startDay:1,endDay:62,focus:'A complete learning progression'}]},async p=>p.startsWith('Review candidate')?{approved:false,issues:['Worked example is incorrect.']}:fake(p)),/could not be completed/);
});


test('123-day learner plan keeps all days and daily material through the last batch',async()=>{
 let plan=[],outline=[{startDay:1,endDay:123,focus:'Develop mathematical understanding, practice and review'}];
 while(plan.length<123){
  const r=await batch({...input,examName:'Class 9 maths',days:123,hoursPerDay:1.5,nextDay:plan.length+1,previous:plan.slice(-42),outline},async p=>fake(p));
  plan.push(...r.plan);assert.equal(r.complete,plan.length===123);
 }
 assert.deepEqual(plan.map(d=>d.day),Array.from({length:123},(_,i)=>i+1));
 assert.ok(plan.every(d=>d.lesson && d.workedExample && d.practice.length && d.tasks.reduce((n,t)=>n+t.minutes,0)===90));
 assert.equal(plan[122].date,'2027-01-30');
});
