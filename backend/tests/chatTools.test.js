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

test('the 50-tool catalogue is readable, with a prompt for every tool', () => {
    const { CATALOG } = require('../services/chatTools');
    assert.ok(CATALOG.length >= 40, `only ${CATALOG.length} tools loaded`);
    assert.equal(CATALOG.filter(t => typeof t.promptTemplate !== 'function').length, 0);
    assert.ok(CATALOG.some(t => t.id === 'math-solver'));
});

test('a question to be answered never becomes a catalogue tool', async () => {
    const { runCatalogTool } = require('../services/chatTools');
    // These return before any model is consulted: no verb asking for work.
    assert.equal(await runCatalogTool('what is photosynthesis?', { facts: [] }), null);
    assert.equal(await runCatalogTool('why does the moon change shape', { facts: [] }), null);
    assert.equal(await runCatalogTool('who discovered the electron', { facts: [] }), null);
    assert.equal(await runCatalogTool('tell me about the Ganga chapter', { facts: [] }), null);
});

test('library options are split out only for real multiple-choice questions', () => {
    const { _splitOptions: split } = require('../services/chatTools');
    const mcq = split('Which of the following statements is not true? (a) When two positive integers are added, we get a positive integer. (b) When two negative integers are added we always get a negative integer. (c) Both. (d) Neither.', 'Multiple Choice Questions');
    assert.equal(mcq.options.length, 4);
    assert.match(mcq.stem, /^Which of the following/);
    // Parts of one question are not options.
    assert.equal(split('Write the following: (a) a positive integer whose sum is negative (b) a negative integer whose sum is positive', null), null);
    assert.equal(split('(a) Write a positive integer (b) Write a negative integer', 'Multiple Choice Questions'), null);
    assert.equal(split('Evaluate: (a) 3 × 4 (b) 5 × 6 (c) 7 × 8', null), null);
});
