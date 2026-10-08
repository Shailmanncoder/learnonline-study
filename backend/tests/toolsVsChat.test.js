const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const hints = require('../services/toolHints');
const ent = require('../services/entitlements');

const read = p => fs.readFileSync(path.join(__dirname, p), 'utf8');
const aiCtl = read('../controllers/aiController.js');
const userCtl = read('../controllers/userController.js');
const app = read('../../frontend/app.js');

test('the Companion still answers a locked tool’s question', () => {
    // Gating knowledge in a chat is neither possible -- a student rephrases --
    // nor kind. What a plan sells is the packaged workflow, so the answer is
    // given and the tool is offered.
    const route = aiCtl.slice(aiCtl.indexOf("router.post('/stream'"));
    const hintBlock = route.slice(route.indexOf('let hint = null;'), route.indexOf("send('done'"));
    assert.ok(!/return|res\.status\(40/.test(hintBlock), 'the hint must never refuse the answer');
    assert.match(hintBlock, /ent\.toolAllowed\(tier, toolId\)/);
    assert.match(hintBlock, /catch \{/, 'a hint is never worth failing an answer for');
});

test('a hint fires only on a locked tool’s own territory', () => {
    assert.equal(hints.match('write a query to list students above 90'), 'sql-gen');
    assert.equal(hints.match('build a regex for an email address'), 'regex-builder');
    // Ordinary questions must not be nagged at.
    assert.equal(hints.match('what is photosynthesis'), null);
    assert.equal(hints.match('explain newtons third law'), null);
    assert.equal(hints.match('hi'), null);
    // Every cue names a real tool, and every hinted tool says what it adds.
    for (const id of Object.keys(hints.CUES)) {
        assert.ok(ent.TOOL_ORDER.includes(id), `${id} is not a real tool`);
        assert.ok(hints.ADDS[id], `${id} must say what it adds over chat`);
    }
});

test('a tool run is kept, which is what a conversation does not give', () => {
    // A run used to leave nothing behind, so chat -- with threads, memory and
    // history -- was strictly the more capable product, and paying for tools
    // bought a form in front of the same model.
    assert.match(aiCtl, /INSERT INTO tool_runs \(id, user_id, tool_id, inputs, output, created_at\)/);
    assert.match(aiCtl, /const saveToolRun = async \(output\)/);
    // Saved after the answer and never allowed to break it.
    const save = aiCtl.slice(aiCtl.indexOf('const saveToolRun'), aiCtl.indexOf('const saveToolRun') + 1600);
    assert.match(save, /catch \(err\) \{[\s\S]{0,120}could not save the tool run/);
    // Bounded, or the table grows forever.
    assert.match(save, /LIMIT 20/);
});

test('past runs belong to the account that made them', () => {
    const route = userCtl.slice(userCtl.indexOf("router.get('/tool-runs'"));
    assert.match(route, /WHERE user_id = \? AND tool_id = \?/);
    assert.match(route, /DELETE FROM tool_runs WHERE id = \? AND user_id = \?/,
        'another account’s run id must be a 404, not a delete');
});

test('a saved run can be reopened and repeated', () => {
    // The inputs beside the output is the whole point: no retyping.
    assert.match(app, /function applyRunInputs/);
    assert.match(app, /async function loadToolRuns/);
    assert.match(app, /toolInputs: lastToolInputs/, 'the form values must be sent with the run');
    // A file input cannot be refilled from saved text and throws if you try.
    assert.match(app, /el\.type !== 'file'/);
    // History must never break the tool itself.
    const fn = app.slice(app.indexOf('async function loadToolRuns'), app.indexOf('function applyRunInputs'));
    assert.match(fn, /catch \{[\s\S]{0,120}box\.hidden = true/);
    // And a slow response must not land on a tool the person has since left.
    assert.match(fn, /currentActiveTool\.id !== toolId/);
});

test('a locked tool says so, and says it before the form is filled in', () => {
    // Every account is on Free, so 47 of the 50 tools answered "Error
    // connecting to AI service" — the gate worked, the message was nonsense,
    // and it only appeared after someone had typed everything and pressed
    // Generate.
    const feApp = read('../../frontend/app.js');

    // The real reason reaches the screen.
    assert.match(read('../../frontend/api.js'), /err\.code = e\.code/);
    assert.match(feApp, /err\.code === 'TOOL_LOCKED' \|\| err\.code === 'QUOTA_EXCEEDED'/);
    assert.ok(!/: 'Error connecting to AI service\.';\s*\n\s*\}\s*\n\s*\}\);/.test(feApp),
        'the generic message must no longer be the only outcome');

    // And the lock is shown up front, on the tool and on its card.
    assert.match(feApp, /function applyToolLock/);
    assert.match(feApp, /function toolLockedBy/);
    assert.match(feApp, /run\.disabled = Boolean\(needsPlan\)/, 'Generate must be disabled');
    assert.match(feApp, /tool-lock-badge/, 'the list needs a badge too');
    // Re-applied when the plan is re-read, so buying one opens the tool in place.
    assert.match(feApp, /if \(currentActiveTool\) applyToolLock\(currentActiveTool\)/);

    // Which plan opens each tool comes from the server, so a badge cannot
    // disagree with the gate.
    assert.match(userCtl, /if \(!ent\.toolAllowed\(tier, id\)\) unlocks\[id\] = ent\.requiredTierFor\(id\)\.label/);
});
