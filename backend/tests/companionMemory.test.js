const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const memory = fs.readFileSync(path.join(__dirname, '../services/studyMemory.js'), 'utf8');
const ncert = fs.readFileSync(path.join(__dirname, '../services/ncertContext.js'), 'utf8');

test('board, class and subject never age out of the tutor’s memory', () => {
    // getFacts returned the most recent MAX_FACTS rows and nothing else, so a
    // student with a dozen ordinary preferences pushed their own class or
    // subject out of the window. The tutor then stopped grounding answers in
    // the right syllabus, with nothing on screen to say why.
    assert.match(memory, /mem_key IN \('board', 'class', 'subject'\)/,
        'the syllabus keys must be fetched regardless of recency');
    assert.match(memory, /ORDER BY updated_at DESC, id DESC/,
        'rows saved in the same second need a tie-break, or which facts survive is arbitrary');
    assert.match(memory, /MAX_STORED_FACTS/,
        'a distinct key always inserted, so the table could grow without bound');
});

test('a locked chapter answers off-topic questions instead of refusing them', () => {
    // The lock is held against the account, not the thread, and was released
    // only by an explicit phrase or by naming another chapter. Everything else
    // -- in any conversation -- came back as "not mentioned in the provided
    // text", including questions the tutor knows perfectly well.
    assert.ok(!/They are the ONLY source you may use[\s\S]{0,400}Do NOT use general/.test(ncert),
        'the chapter must not be the only permitted source for an unrelated question');
    assert.match(ncert, /do not refuse it/i,
        'an off-topic question should be answered, not declined');
    assert.match(ncert, /Never present anything else as coming from this chapter/,
        'grounding still has to stop invented chapter content');
    assert.match(ncert, /Cite the page you used/,
        'on-topic answers must still cite the chapter');
});
