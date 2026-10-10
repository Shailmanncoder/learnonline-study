const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ent = require('../services/entitlements');

const read = p => fs.readFileSync(path.join(__dirname, p), 'utf8');
const aiCtl = read('../controllers/aiController.js');
const app = read('../../frontend/app.js');

test('the Companion starts at Plus, not below', () => {
    const t = ent.tiers();
    assert.equal(t.free.companion, false);
    assert.equal(t.starter.companion, false, 'Starter is ₹499 — the Companion is a ₹799 feature');
    assert.equal(t.plus.companion, true);
    assert.equal(t.pro.companion, true);
    assert.equal(t.max.companion, true);
    assert.equal(ent.companionTier().id, 'plus');
    // Once included it stays included, so upgrading never removes it.
    const ordered = Object.values(t).sort((a, b) => a.rank - b.rank);
    let seen = false;
    for (const tier of ordered) {
        if (tier.companion) seen = true;
        else assert.ok(!seen, `${tier.label} drops the Companion after a lower tier had it`);
    }
});

test('both routes into the Companion are gated', () => {
    // /ai/stream exists only for it.
    const stream = aiCtl.slice(aiCtl.indexOf("router.post('/stream'"));
    assert.match(stream.slice(0, 3000), /companion: true/);
    // And on /generate it is derived from the conversation thread, not from a
    // flag the client could leave out.
    assert.match(aiCtl, /companion: Boolean\(threadId\)/);
    assert.ok(!/companion: Boolean\(req\.body\.companion\)/.test(aiCtl),
        'the client must not get to declare this');
});

test('a locked Companion says which plan opens it', () => {
    const meter = aiCtl.slice(aiCtl.indexOf('async function meter('), aiCtl.indexOf("\nrouter."));
    assert.match(meter, /companion && !tier\.companion/);
    assert.match(meter, /COMPANION_LOCKED/);
    assert.match(meter, /ent\.companionTier\(\)/);
    // The screen says it before anything is typed, and stops the composer.
    assert.match(app, /function applyCompanionLock/);
    assert.match(app, /input\.disabled = !open/);
    assert.match(app, /send\.disabled = !open/);
    assert.match(app, /COMPANION_LOCKED/);
});

test('every account must confirm an email — the grace period is over', () => {
    const migration = read('../migrations/008_require_email_everywhere.js');
    assert.match(migration, /UPDATE users SET email_exempt = 0 WHERE email_exempt = 1/);
    // Repeatable: it does nothing once there is nothing left to clear.
    assert.match(migration, /if \(!n\) return;/);
    // The column stays, so a future grace period does not mean rebuilding it.
    assert.ok(!/DROP COLUMN/i.test(migration));
    assert.match(read('../server.js'), /migrations\/008_require_email_everywhere/);
});
