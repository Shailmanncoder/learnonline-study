// Chat tools: what counts as asking for a tool, and what must never be
// treated as one. A false positive here replaces a real answer with a
// worksheet, so the detector is deliberately narrow.
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectTool } = require('../services/chatTools');

const fact = (key, value) => ({ mem_key: key, mem_value: value });

test('a named tool is recognised, with its count and difficulty', () => {
    const w = detectTool('make me a worksheet on integers with 10 questions');
    assert.equal(w.tool, 'worksheet');
    assert.equal(w.count, 10);
    assert.match(w.topic, /integers/i);

    const q = detectTool('quiz me on photosynthesis, 5 hard questions');
    assert.equal(q.tool, 'quiz');
    assert.equal(q.count, 5);
    assert.equal(q.difficulty, 'Hard');

    assert.equal(detectTool('/flashcards trigonometry').tool, 'flashcards');
    assert.equal(detectTool('banao ek worksheet fractions ka').tool, 'worksheet');
});

test('an ordinary question is not a tool', () => {
    // "notes" and "summary" mean a tool only with a verb in front of them.
    assert.equal(detectTool('what are the notes of chapter 3 about?'), null);
    assert.equal(detectTool('explain photosynthesis in simple words'), null);
    assert.equal(detectTool('who wrote the poem Kaveri?'), null);
    assert.equal(detectTool('give me 10 questions from class 7 integers'), null, 'that is a library request');
    assert.equal(detectTool('make notes on the water cycle').tool, 'notes');
});

test('the count is clamped to what a tool can sensibly hold', () => {
    assert.equal(detectTool('worksheet with 90 questions').count, 20);
    assert.equal(detectTool('worksheet with 1 question').count, 3);
    assert.equal(detectTool('make a worksheet').count, 8, 'a sensible default');
});

test('"5 more" and "make it harder" continue the tool already on screen', () => {
    const facts = [fact('last_tool', JSON.stringify({ tool: 'quiz', topic: 'integers', count: 5, difficulty: 'Medium' }))];
    const lastTool = JSON.parse(facts[0].mem_value);

    const more = detectTool('5 more', { lastTool });
    assert.equal(more.tool, 'quiz');
    assert.equal(more.count, 5);
    assert.equal(more.topic, 'integers');
    assert.equal(more.followUp, true);

    assert.equal(detectTool('make it harder', { lastTool }).difficulty, 'Hard');
    assert.equal(detectTool('easier please', { lastTool }).difficulty, 'Easy');
    // With nothing on screen, "5 more" is not a tool request at all.
    assert.equal(detectTool('5 more'), null);
});

test('a tool with no topic follows the chapter the chat is on', () => {
    const { contextOf } = require('../services/chatTools');
    const ctx = contextOf([fact('class', 'Class 7'), fact('chapter_lock_label', 'Integers'), fact('subject', 'Mathematics')]);
    assert.equal(ctx.classLevel, '7');
    assert.equal(ctx.chapter, 'Integers');
    assert.equal(ctx.subject, 'Mathematics');
});
