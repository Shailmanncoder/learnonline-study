const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = p => fs.readFileSync(path.join(__dirname, p), 'utf8');
const aiCtl = read('../controllers/aiController.js');
const api = read('../../frontend/api.js');
const app = read('../../frontend/app.js');

const streamRoute = () => {
    const from = aiCtl.indexOf("router.post('/stream'");
    return aiCtl.slice(from);
};

test('streaming is charged and gated like every other generation', () => {
    // A cheaper code path must not become a cheaper price, or the quota is
    // trivially avoided by using the faster route.
    const route = streamRoute();
    // The call now also carries toolId -- see metering.test.js, where the gate
    // itself is pinned.
    assert.match(route, /await meter\(req, res, \{[\s\S]{0,160}depth: brainDepth\s*\}\) === false/);
});

test('the stream carries the same context the rest of the app uses', () => {
    const route = streamRoute();
    assert.match(route, /getFacts\(req\.user\.id\)/, 'the student profile and saved facts');
    assert.match(route, /getWeakTopics/, 'what they keep getting wrong');
    assert.match(route, /buildMessages\(prompt, systemMessage, null, brainCtx\)/);
    // And the conversation itself, in the order it happened.
    assert.match(route, /FROM chat_messages WHERE thread_id = \? ORDER BY id DESC LIMIT \?/);
    assert.match(route, /apiMessages\.push\(\.\.\.system, \.\.\.past\.map/);
    assert.match(route, /appendTurn\(thread, req\.user\.id, prompt, answer\)/, 'the turn must be saved');
});

test('a proxy cannot buffer the stream into a single lump', () => {
    // nginx buffers proxied responses by default, which would hold every token
    // until the end and undo the entire point of the route.
    assert.match(streamRoute(), /'X-Accel-Buffering': 'no'/);
    assert.match(streamRoute(), /text\/event-stream/);
});

test('a disconnect is distinguished from a finished request', () => {
    // req's 'close' also fires when the request body has merely finished being
    // read, which silently dropped work that ran after the answer.
    const route = streamRoute();
    assert.match(route, /res\.on\('close', \(\) => \{ if \(!res\.writableEnded\) closed = true; \}\)/);
    assert.ok(!/req\.on\('close'/.test(route), 'req close is not a disconnect signal here');
});

test('follow-up suggestions get enough tokens to actually answer', () => {
    // These models spend tokens on hidden reasoning first. At 160 the budget
    // was sometimes gone before any content was written, so suggestions
    // appeared about half the time with no error anywhere.
    const route = streamRoute();
    assert.match(route, /max_tokens: 600/);
    // They come after 'done', so they can never delay the answer itself.
    assert.ok(route.indexOf("send('done'") < route.indexOf("send('suggestions'"));
});

test('the client falls back whenever streaming cannot serve', () => {
    assert.match(api, /streamAI: async \(token/);
    // Rejects only while nothing has been shown; once words are on screen,
    // restarting the answer would be worse than finishing with what arrived.
    assert.match(api, /if \(failedEarly && !answer\) throw/);
    assert.match(app, /catch \(streamErr\) \{\s*\n?\s*res = null;/);
    assert.match(app, /if \(!res\) \{\s*\n?\s*res = await api\.generateAI/);
    // Tool routing, research and maths keep the whole-answer path.
    assert.match(app, /const canStream = !isSearchCmd && !isStemQuery && tutorMode !== 'research'/);
});

test('partial markdown is not rendered as markup while it streams', () => {
    // Half-written markdown renders as broken markup; it is parsed once at the
    // end instead.
    assert.match(app, /body\.textContent = whole/);
    assert.ok(!/stream-body.*innerHTML/.test(app));
});
