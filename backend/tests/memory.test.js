const test = require('node:test');
const assert = require('node:assert/strict');
const { isPdf, normaliseClass, gradeIn, MAX_MB } = require('../services/memoryDocs');
const progress = require('../services/progress');

test('only real PDF bytes are accepted, whatever the client claims', () => {
    assert.equal(isPdf(Buffer.from('%PDF-1.7\n...')), true);
    assert.equal(isPdf(Buffer.from('hello not a pdf')), false);
    assert.equal(isPdf(Buffer.from('<html>%PDF-</html>'.padStart(2000, ' '))), false); // marker too far in
    assert.equal(isPdf(Buffer.alloc(0)), false);
});
test('the upload cap stays within the 1-60 MB range', () => {
    assert.ok(MAX_MB >= 1 && MAX_MB <= 60);
});
test('class labels normalise however they are typed', () => {
    for (const v of ['9', 'class 9', 'Class 9', 'CLASS IX', 'ix', 'Grade 9']) {
        assert.equal(normaliseClass(v), 'Class 9', `for "${v}"`);
    }
    assert.equal(normaliseClass('13'), '');
    assert.equal(normaliseClass(''), '');
});
test('a class named in a question is read in digits or Roman numerals', () => {
    assert.equal(gradeIn('In class 9 River Notes, what is chapter 1'), 'Class 9');
    assert.equal(gradeIn('class ix kaveri'), 'Class 9');
    assert.equal(gradeIn('kaksha 10 ka path'), 'Class 10');
    assert.equal(gradeIn('why do things fall down'), '');
});

// --- live progress ----------------------------------------------------
test('progress steps are readable only by the user who started the request', () => {
    const rid = 'test-rid-' + Date.now();
    progress.start(rid, 7);
    progress.step(rid, 'Checked your memory');
    progress.step(rid, 'Writing the answer');
    assert.deepEqual(progress.read(rid, 7).steps, ['Checked your memory', 'Writing the answer']);
    assert.equal(progress.read(rid, 8), null);            // someone else's id reads as unknown
    progress.finish(rid);
    assert.equal(progress.read(rid, 7).done, true);
});
test('malformed request ids are refused rather than stored', () => {
    assert.equal(progress.start('../../etc', 1), null);
    assert.equal(progress.start('x', 1), null);
    assert.equal(progress.start('a'.repeat(200), 1), null);
    // and stepping an unknown id is a harmless no-op
    assert.doesNotThrow(() => progress.step('never-started-id', 'x'));
});

// --- model fallback ---------------------------------------------------
// Each Groq model has its own per-minute quota, so a busy model must fall
// through to the next instead of failing the question.
const { modelChain, isRetryable } = require('../services/ai');

test('text requests fall through every available model, primary first', () => {
    assert.deepEqual(modelChain('openai/gpt-oss-120b'),
        ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b']);
    // no duplicates when the primary is already in the pool
    assert.equal(new Set(modelChain('openai/gpt-oss-20b')).size, modelChain('openai/gpt-oss-20b').length);
});
test('image requests never fall back to a model that cannot see images', () => {
    assert.deepEqual(modelChain('qwen/qwen3.8-27b', { hasImages: true }), ['qwen/qwen3.8-27b']);
});
test('quota, retired models and outages are retryable; real mistakes are not', () => {
    for (const status of [404, 413, 429, 500, 503]) assert.equal(isRetryable({ status }), true, `status ${status}`);
    assert.equal(isRetryable({ message: 'The model `qwen/qwen3.6-27b` does not exist' }), true);
    assert.equal(isRetryable({ status: 400, message: 'response_format json_object is not supported' }), true);
    // A malformed request fails the same way on every model — do not burn the chain on it.
    assert.equal(isRetryable({ status: 400, message: 'messages[0].content must be a string' }), false);
    assert.equal(isRetryable({ status: 401, message: 'Invalid API Key' }), false);
});
