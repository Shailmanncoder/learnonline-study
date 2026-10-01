// ================================================================
// Live request progress
// ----------------------------------------------------------------
// The steps the tutor actually takes for a question — "checked your
// memory", "found kaveri.pdf", "read pages 3, 7" — recorded as they
// happen so the chat can show them while the student waits. These are
// real events from the request, never a scripted animation.
// ================================================================
const TTL_MS = 3 * 60 * 1000;
const MAX_STEPS = 40;
const runs = new Map();
const active = new Map();
const { randomUUID } = require('node:crypto');

function sweep() {
    const now = Date.now();
    for (const [id, r] of runs) if (now - r.at > TTL_MS) {runs.delete(id);if(active.get(r.key)===id)active.delete(r.key);}
}

// The id comes from the client; accept only a conservative shape so it can
// never be used to probe or grow the map with arbitrary keys.
const ID = /^[A-Za-z0-9_-]{8,64}$/;

function start(requestId, userId) {
    if (!ID.test(String(requestId || ''))) return null;
    sweep();
    if(runs.size>=1000)return null;
    const handle=randomUUID(), key=String(userId)+':'+requestId;
    runs.set(handle, { key, userId: String(userId), at: Date.now(), steps: [], done: false });
    active.set(key,handle);
    return handle;
}

function step(requestId, text) {
    const r = requestId && runs.get(requestId);
    if (!r || r.steps.length >= MAX_STEPS) return;
    r.steps.push({ text: String(text).slice(0, 200), at: Date.now() });
    r.at = Date.now();
}

function finish(requestId) {
    const r = requestId && runs.get(requestId);
    if (r) { r.done = true; r.at = Date.now(); }
}

function read(requestId, userId) {
    sweep();
    const r = runs.get(active.get(String(userId)+':'+requestId));
    // Another user's request id reads as unknown rather than forbidden.
    if (!r || r.userId !== String(userId)) return null;
    return { steps: r.steps.map(s => s.text), done: r.done, answer: r.answer || "" };
}

function stepsOf(requestId) {
    const r = requestId && runs.get(requestId);
    return r ? r.steps.map(s => s.text) : [];
}

function answer(requestId, text) {
    const r = runs.get(requestId);
    if (r) { r.answer = String(text).slice(0, 80000); r.at = Date.now(); }
}
module.exports = { start, step, finish, read, stepsOf, answer };
