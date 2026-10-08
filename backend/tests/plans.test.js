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

test('a question costs the same whatever its length', () => {
    // Pricing by answer length tracked the bill more closely but meant nobody
    // could tell what a question would cost before asking it. A flat price is
    // worth more to a student than a precise one.
    assert.equal(ent.costOf(null, 'brief'), 10);
    assert.equal(ent.costOf(null, 'normal'), 10);
    assert.equal(ent.costOf(null, 'deep'), 10);
    assert.equal(ent.costOf('question'), 10);
    // The free allowance is therefore a plain number of questions.
    assert.equal(ent.tiers().free.credits / ent.costOf('question'), 35);
});

test('heavier work still costs more than a question', () => {
    // A one-line answer and a forty-day roadmap are not the same purchase.
    const q = ent.costOf('question');
    assert.ok(ent.costOf('json') > q, 'a generated document');
    assert.ok(ent.costOf('image') > ent.costOf('json'), 'the most expensive single action');
    assert.ok(ent.costOf('roadmap') > ent.costOf('image'), 'many calls behind one button');
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

const fe = p => fs.readFileSync(path.join(__dirname, '../../frontend', p), 'utf8');

test('the checkout hand-off reports real steps, not a loading animation', () => {
    const app = fe('app.js');
    const handoff = app.slice(app.indexOf('function startCheckoutHandoff'), app.indexOf('async function loadUsageMeter'));
    // The price is re-read from the server before anything is charged, so the
    // card on screen -- which may be minutes old -- cannot set the amount.
    assert.match(handoff, /api\.getPaymentCatalog/);
    assert.match(handoff, /confirmed\.amount !== plan\.amount/);
    // Each failure stops the sequence instead of running on to "done".
    assert.match(handoff, /no longer available/);
    assert.match(handoff, /not enabled yet/);
    assert.match(handoff, /could not reach the payment service/);
    assert.match(handoff, /You have not been charged/);
    // Cancellable, and a cancel actually stops the redirect.
    assert.match(handoff, /cancelled = true/);
    assert.ok((handoff.match(/if \(cancelled\) return/g) || []).length >= 3);
    assert.ok(fe('index.html').includes('id="gateway-overlay"'));
});

test('the meter shows the same numbers the server enforces', () => {
    const app = fe('app.js');
    assert.match(app, /async function loadUsageMeter/);
    assert.match(app, /api\.getUsage\(authToken\)/);
    // A meter that cannot load must not take the page down with it.
    const meter = app.slice(app.indexOf('async function loadUsageMeter'), app.indexOf('async function loadPlusPlans'));
    assert.match(meter, /catch\s*\{[\s\S]{0,120}box\.hidden = true/);
});

test('the pricing page no longer claims nothing is locked', () => {
    // It said "nothing in the app is locked behind a plan". That was true when
    // written, is now false, and is the one line a buyer would feel misled by.
    const app = fe('app.js');
    assert.ok(!/nothing in the app is locked behind a plan/i.test(app));
    assert.ok(!/already available to\s*\n?\s*every account at no cost/i.test(app));
    assert.ok(!fe('index.html').includes('Two monthly plans'));
});

test('motion is optional', () => {
    assert.match(fe('plus.css'), /@media \(prefers-reduced-motion: reduce\)/);
});

test('Max actually gets the priority routing it is sold', () => {
    // The tier carried a `priority` flag that nothing read, so the strongest
    // model was advertised on a paid plan and never delivered.
    const { chooseModel } = require('../services/geminiModels');
    const normal = chooseModel({ prompt: 'what is 2+2' });
    const priority = chooseModel({ prompt: 'what is 2+2', priority: true });
    assert.notEqual(priority.id, normal.id, 'priority must change the model actually used');
    assert.equal(chooseModel({ prompt: 'x', task: 'reasoning' }).id, priority.id,
        'priority should land on the same model a deep question gets');
    // A deliberate routing decision about correctness still wins.
    assert.match(chooseModel({ prompt: 'x', hasImages: true, priority: true }).reason, /image/);
    // And it is read from the entitlement, not asked for by the client.
    const aiSrc = fs.readFileSync(path.join(__dirname, '../controllers/aiController.js'), 'utf8');
    assert.match(aiSrc, /ent\.tierOf\(await usage\.planOf\(req\.user\.id\)\)\.priority/);
});

test('credits are visible without going to the pricing page', () => {
    // The balance lived only on the plans screen, so it was invisible exactly
    // while it was being spent.
    const app = fe('app.js');
    assert.ok(fe('index.html').includes('id="credit-chip"'), 'the topbar needs the balance');
    assert.match(app, /async function refreshCredits/);
    // Refreshed after the things that actually cost credits, not only at load.
    assert.match(app, /refreshCredits\(\{ pulse: true \}\);\s*\n\s*const xpRes = await api\.addXp/, 'after a tool run');
    assert.match(app, /companionSending = false;\s*\n\s*refreshCredits\(\{ pulse: true \}\)/, 'after a chat turn');
    assert.ok((app.match(/refreshCredits\(\)/g) || []).length >= 2, 'and on sign-in');
    // A balance that cannot load must never take a page down with it.
    const fn = app.slice(app.indexOf('async function refreshCredits'), app.indexOf('safeOn(\'credit-chip\''));
    assert.match(fn, /catch \{[\s\S]{0,120}chip\.hidden = true/);
});

test('the catalogue states what each plan grants, not just its price', () => {
    // The credit figures existed only inside a feature sentence, so nothing on
    // screen could state them exactly or turn them into questions.
    const service = fs.readFileSync(path.join(__dirname, '../payments/service.js'), 'utf8');
    assert.match(service, /credits:tier\.credits/);
    assert.match(service, /questions:Math\.floor\(tier\.credits\/perQuestion\)/);
    assert.match(service, /freeCredits:ent\.tiers\(\)\.free\.credits/);
    // Derived from entitlements, so the advertised figure cannot drift from
    // the one that is enforced.
    assert.match(service, /require\('\.\.\/services\/entitlements'\)/);
    assert.match(fe('app.js'), /plan\.credits\.toLocaleString\(\)/);
});
