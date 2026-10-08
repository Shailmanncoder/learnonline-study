const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ent = require('../services/entitlements');
const { plans } = require('../payments/config');

const aiCtl = fs.readFileSync(path.join(__dirname, '../controllers/aiController.js'), 'utf8');

test('the four tiers are priced and ordered as agreed', () => {
    assert.deepEqual(Object.keys(plans), ['starter', 'plus', 'pro', 'max']);
    assert.equal(plans.starter.amount, 49900);
    assert.equal(plans.plus.amount, 79900);
    assert.equal(plans.pro.amount, 99900);
    assert.equal(plans.max.amount, 149900);
    for (const p of Object.values(plans)) assert.equal(p.currency, 'INR');
});

test('each tier opens the number of tools it advertises', () => {
    const t = ent.tiers();
    assert.equal(ent.toolsFor(t.free).length, 3);
    assert.equal(ent.toolsFor(t.starter).length, 10);
    assert.equal(ent.toolsFor(t.plus).length, 25);
    assert.equal(ent.toolsFor(t.pro).length, ent.TOOL_ORDER.length);
    assert.equal(ent.toolsFor(t.max).length, ent.TOOL_ORDER.length);
    // Each tier is a superset of the one below, so upgrading never takes a
    // tool away.
    const order = [t.free, t.starter, t.plus, t.pro, t.max];
    for (let i = 1; i < order.length; i++) {
        for (const id of ent.toolsFor(order[i - 1])) {
            assert.ok(ent.toolAllowed(order[i], id), `${order[i].label} should still include ${id}`);
        }
    }
});

test('usage multiplies as the plans claim', () => {
    const t = ent.tiers();
    // "10x more usage" at Plus and "20x" at Pro, measured against Starter.
    assert.equal(t.plus.credits, t.starter.credits * 10);
    assert.equal(t.pro.credits, t.starter.credits * 20);
    assert.ok(t.max.credits > t.pro.credits);
    assert.ok(t.max.priority && !t.pro.priority, 'only Max is priority');
});

test('an unknown tool is premium, not free', () => {
    // Failing open would hand every tier the whole catalogue again, which is
    // exactly the state this replaced.
    assert.equal(ent.toolAllowed(ent.tiers().free, 'something-new'), false);
    assert.equal(ent.toolAllowed(ent.tiers().starter, 'something-new'), false);
    assert.equal(ent.toolAllowed(ent.tiers().pro, 'something-new'), true);
});

test('a plan sold before the tiers existed still resolves', () => {
    // One order was created against 'student'. It must not throw.
    assert.equal(ent.tierOf('student').id, 'pro');
    assert.equal(ent.tierOf('developer').id, 'pro');
    assert.equal(ent.tierOf(null).id, 'free');
    assert.equal(ent.tierOf('nonsense').id, 'free');
});

test('cost follows the token budget, not the request count', () => {
    // A one-line answer and a forty-day roadmap are not the same purchase.
    assert.ok(ent.costOf(null, 'brief') < ent.costOf(null, 'normal'));
    assert.ok(ent.costOf(null, 'normal') < ent.costOf(null, 'deep'));
    assert.ok(ent.costOf('image') > ent.costOf(null, 'deep'));
    assert.ok(ent.costOf('roadmap') > ent.costOf('image'));
});

test('every generating endpoint is metered', () => {
    // An unmetered AI route is an open tab: it was the whole problem before.
    assert.match(aiCtl, /async function meter\(/);
    // Bounded at the next route, not by a character count: the meter call
    // sits well inside the handler.
    const from = aiCtl.indexOf("router.post('/generate'");
    const generate = aiCtl.slice(from, aiCtl.indexOf("router.post('/", from + 10));
    assert.match(generate, /await meter\(req, res, \{[\s\S]{0,120}toolId/,
        '/generate must check the plan and charge');
    assert.match(aiCtl, /meter\(req, res, \{ kind: 'image' \}\)/);
    assert.match(aiCtl, /meter\(req, res, \{ kind: 'speech' \}\)/);
    // Charged before the model runs: the tokens are spent either way.
    const fn = aiCtl.slice(aiCtl.indexOf('async function meter('), aiCtl.indexOf('async function meter(') + 1400);
    assert.match(fn, /usage\.charge/);
    assert.match(fn, /TOOL_LOCKED/);
    assert.match(fn, /QUOTA_EXCEEDED/);
});

test('the plan is read from the entitlement, never from the client', () => {
    const usageSrc = fs.readFileSync(path.join(__dirname, '../services/usage.js'), 'utf8');
    assert.match(usageSrc, /FROM payment_entitlements WHERE user_id=\? AND mode=\? AND revoked=0/);
    assert.ok(!/req\.body/.test(usageSrc), 'nothing about the plan may come from the request');
});
