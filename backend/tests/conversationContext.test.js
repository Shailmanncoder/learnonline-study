const {test}=require('node:test');const assert=require('node:assert/strict');
const {preferences}=require('../services/conversationContext');
test('preferences use latest explicit user statements, excluding assistant guesses',()=>{
 assert.deepEqual(preferences([{role:'user',content:'I am in class 9. Reply in Hindi'},{role:'assistant',content:'Reply in English'},{role:'user',content:'Reply in English'}]),['I am in class 9','Reply in English']);
});
test('reset clears previous preferences and unrelated text does not become memory',()=>{
 assert.deepEqual(preferences([{role:'user',content:'Reply in Hindi'},{role:'user',content:'forget my preferences'},{role:'user',content:'What is acceleration?'}]),[]);
});
