const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../../frontend/app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../../frontend/styles.css'), 'utf8');
const brain = require('../services/aiBrain');

test('every Developer Hub sidebar entry opens somewhere real', () => {
    // The sidebar listed seven destinations and only four panes existed.
    // Projects showed the dashboard with "Projects" still highlighted, and
    // Settings threw the developer out of the Hub into the student profile.
    const navTabs = [...html.matchAll(/data-dev-tab="([a-z]+)"/g)].map(m => m[1]);
    assert.ok(navTabs.length >= 6, 'expected the Hub sidebar entries');

    const mapped = app.slice(app.indexOf('const DEV_TABS = {'), app.indexOf('function switchDevTab'));
    for (const tab of navTabs) {
        assert.match(mapped, new RegExp(`\\b${tab}:\\s*\\{`), `sidebar entry "${tab}" has no entry in DEV_TABS`);
        const pane = new RegExp(`${tab}:\\s*\\{[^}]*pane: '([a-z-]+)'`).exec(mapped);
        assert.ok(pane, `"${tab}" declares no pane`);
        assert.ok(html.includes(`id="${pane[1]}"`), `"${tab}" points at ${pane[1]}, which is not in the page`);
    }
});

test('Projects is gone as a destination but still resolves', () => {
    // There was never a project: the grid held one button that opened AI Code
    // Review, and the stat card was already called "Code Reviews".
    assert.ok(!/data-dev-tab="projects"/.test(html), 'the duplicate Projects entry should be gone');
    assert.match(app, /DEV_TAB_ALIASES = \{ projects: 'review' \}/,
        'a bookmarked /developer/projects must still land somewhere');
});

test('the Hub says its data is on the account, not in the browser', () => {
    // Left over from before the Hub moved to the server; it told every
    // developer their work would not follow them to another device.
    assert.ok(!/Saved in this browser/.test(html));
});

test('saving a chat answer to Notes goes to the server', () => {
    // It wrote to localStorage under studyUserNotes, which nothing ever read
    // back, and toasted "Saved note to Smart Note Taker!" either way. The Note
    // Taker reads the notes table, so the note was gone the moment it was made.
    // The key still appears in the sign-out clear list, which is right: it
    // wipes anything left from before. Nothing may WRITE to it.
    assert.ok(!/setItem\(\s*'studyUserNotes'/.test(app),
        'the dead localStorage note store must not be written to again');
    const handler = app.slice(app.indexOf(".grok-savenote-btn'"), app.indexOf(".grok-quizme-btn'"));
    assert.match(handler, /api\.saveNote\(/, 'the chat note must be saved through the API');
    assert.match(handler, /catch[\s\S]*showToast\([^)]*'error'\)/, 'a failed save has to say so');
});

test('a tool asking for a multi-section document is not told to answer briefly', () => {
    // The Hub's AI Notes and Code Review both ask for four or five headed
    // sections including a refactored code example. Neither contains a
    // WANTS_DEPTH verb, so both classified as 'normal': 2000 tokens and
    // "Answer in a few sentences". The output was cut off every time.
    const notes = 'Write an authoritative, comprehensive technical study guide on X\n1. Architecture\n2. Patterns\n3. Interview questions\n4. Pitfalls';
    const review = 'Perform an exhaustive code review\n1. Score\n2. Security\n3. Complexity\n4. Clean code\n5. Refactored example';
    assert.equal(brain.depthOf(notes), 'deep');
    assert.equal(brain.depthOf(review), 'deep');
    assert.ok(brain.BUDGET.deep > brain.BUDGET.normal);

    // Without breaking the behaviour the depth rule exists for.
    assert.equal(brain.depthOf('what is the capital of France'), 'brief');
    assert.equal(brain.depthOf('briefly give me a comprehensive guide'), 'brief',
        'an explicit request for brevity still wins');

    // And a caller that knows its own shape can say so outright.
    const controller = fs.readFileSync(path.join(__dirname, '../controllers/aiController.js'), 'utf8');
    assert.match(controller, /\['brief', 'normal', 'deep'\]\.includes\(depth\)/,
        'the depth parameter must be validated against a fixed list');
    assert.match(app, /depth: 'deep'/, 'the Hub tools should declare the shape they need');
});

test('the Hub is themed, not painted light', () => {
    // .devhub-portal-wrapper hardcoded #F8FAFD next to color: var(--text-primary),
    // so in dark mode the whole Developer Hub was light text on a near-white
    // page -- the headings measured 1.05:1.
    const wrapper = css.slice(css.indexOf('.devhub-portal-wrapper {'));
    const block = wrapper.slice(0, wrapper.indexOf('}')).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/background[^;]*#F8FAFD/i.test(block), 'the Hub background must not be a fixed light colour');
    assert.match(block, /background-color: var\(--bg-color\)/);

    // And its main action buttons need to actually look like buttons.
    assert.match(css, /\.devhub-btn-primary \{/, '.devhub-btn-primary had no rule at all');
});
