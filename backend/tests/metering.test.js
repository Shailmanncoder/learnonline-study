const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../config/db');
const usage = require('../services/usage');
const ent = require('../services/entitlements');

const usageSrc = fs.readFileSync(path.join(__dirname, '../services/usage.js'), 'utf8');
const aiCtl = fs.readFileSync(path.join(__dirname, '../controllers/aiController.js'), 'utf8');

async function freshUser(name) {
    await db.ready();
    await usage.ready();
    const r = await db.run('INSERT INTO users (username, password, role) VALUES (?,?,?)', [name, 'x', 'student']);
    return r.lastID;
}

test('an allowance is spent to the credit, never past it, under load', async () => {
    // charge() read the total and then wrote it, so requests sent together all
    // decided they fitted before any of them recorded. A free account reached
    // 370 against an allowance of 350.
    const id = await freshUser('meter-load-' + Date.now());
    const per = ent.costOf('question');
    const allowed = Math.floor(ent.tiers().free.credits / per);

    const results = await Promise.all(Array.from({ length: allowed + 15 }, () =>
        usage.charge(id, { depth: 'normal' }).then(() => 'ok', e => e.code === 'QUOTA_EXCEEDED' ? 'refused' : 'error')));

    const charged = results.filter(r => r === 'ok').length;
    assert.equal(results.filter(r => r === 'error').length, 0, 'no request should error');
    assert.equal(charged, allowed, 'exactly the allowance should get through');
    const { used, remaining } = await usage.balance(id, 'free');
    assert.equal(used, ent.tiers().free.credits);
    assert.equal(remaining, 0);
});

test('a question costs 10 and the free tier is 35 of them', async () => {
    const id = await freshUser('meter-price-' + Date.now());
    const before = (await usage.balance(id, 'free')).used;
    await usage.charge(id, { depth: 'brief' });
    const afterBrief = (await usage.balance(id, 'free')).used;
    await usage.charge(id, { depth: 'deep' });
    const afterDeep = (await usage.balance(id, 'free')).used;

    assert.equal(afterBrief - before, 10, 'a short question costs 10');
    assert.equal(afterDeep - afterBrief, 10, 'a long one costs the same');
    assert.equal(ent.tiers().free.credits, 350);
});

test('a refund puts back exactly what was taken, and never goes negative', async () => {
    const id = await freshUser('meter-refund-' + Date.now());
    await usage.charge(id, { depth: 'normal' });
    const charged = (await usage.balance(id, 'free')).used;
    await usage.refund(id, { depth: 'normal' });
    assert.equal((await usage.balance(id, 'free')).used, charged - 10);
    for (let i = 0; i < 4; i++) await usage.refund(id, { depth: 'normal' });
    assert.ok((await usage.balance(id, 'free')).used >= 0);
});

test('a failed stream does not charge for an answer the fallback charges again', () => {
    // The stream charges, fails before producing anything, and the client then
    // falls back to /generate — which charges a second time. One question cost
    // twice, and half of it bought nothing.
    const route = aiCtl.slice(aiCtl.indexOf("router.post('/stream'"));
    const earlyFailure = route.slice(route.indexOf('if (!answer) {'), route.indexOf('if (!answer) {') + 420);
    assert.match(earlyFailure, /usage\.refund\(req\.user\.id/, 'the charge must be given back');
    assert.match(earlyFailure, /send\('error', \{ retry: true/);
});

test('nothing is charged before the request is known to be servable', () => {
    // Metering ran before the thread was looked up, so an unknown thread id
    // took credits for work that was never attempted.
    const route = aiCtl.slice(aiCtl.indexOf("router.post('/stream'"));
    assert.ok(route.indexOf('Conversation not found') < route.indexOf('await meter(req, res'),
        'validation must come before the charge');
});

test('the streaming route enforces tool gating too', () => {
    // It accepted no toolId at all, so anything routed through it would have
    // skipped the gate entirely.
    const route = aiCtl.slice(aiCtl.indexOf("router.post('/stream'"));
    assert.match(route, /const \{ prompt, systemMessage, threadId, toolId/);
    assert.match(route, /toolId: typeof toolId === 'string' \? toolId : null/);
});

test('charging takes a turn per account rather than racing', () => {
    assert.match(usageSrc, /return db\.transaction\(async \(\) => \{/);
    assert.match(usageSrc, /SELECT id FROM users WHERE id = \?\$\{db\.dialect\(\) === 'mysql' \? ' FOR UPDATE' : ''\}/);
});
