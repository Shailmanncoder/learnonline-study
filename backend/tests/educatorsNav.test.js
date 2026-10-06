const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FE = path.join(__dirname, '../../frontend');
const html = fs.readFileSync(path.join(FE, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(FE, 'app.js'), 'utf8');
const landing = fs.readFileSync(path.join(FE, 'landing.css'), 'utf8');

test('"For educators" is hidden, not removed', () => {
    // Hidden in CSS on purpose, so it comes back by deleting one block.
    // The buttons, their handlers and the Teacher Hub all stay in place.
    assert.ok(html.includes('id="nav-teacher-login-btn"'), 'the desktop button must still exist');
    assert.ok(html.includes('id="mobile-teacher-login-btn"'), 'the mobile button must still exist');
    assert.match(app, /getElementById\('nav-teacher-login-btn'\)\?\.addEventListener/,
        'its click handler must still exist');

    assert.match(landing, /#landing-page #nav-teacher-login-btn,[\s\S]{0,400}display: none !important/,
        'the desktop entry should be hidden');
    assert.match(landing, /#mobile-teacher-login-btn,[\s\S]{0,200}display: none !important/,
        'the mobile entry should be hidden too');
    // Otherwise the row renders as "· For developers" with a stray dot.
    assert.match(landing, /#nav-teacher-login-btn \+ \.land-role-sep/,
        'the separator beside it has to go as well');
});

test('hiding the link does not lock teachers out of signing in', () => {
    // Those two buttons were the ONLY openers of the teacher sign-in modal,
    // and a signed-out visit to /teacher used to just show the landing page.
    assert.match(app, /function wantsTeacherSignIn\(/);
    assert.match(app, /function openTeacherSignIn\(/);

    // showAuth is the signed-out boot path; handleAppRouting is never reached
    // while signed out, so the check has to live in both.
    const showAuth = app.slice(app.indexOf('function showAuth()'), app.indexOf('function showApp()'));
    assert.match(showAuth, /wantsTeacherSignIn\(\)/, 'signed-out boot must honour /teacher');
    assert.match(showAuth, /if \(askedForTeacher\) openTeacherSignIn\(\)/);

    // The path must be read before anything rewrites it to "/".
    // The path must be read before anything rewrites it to "/". Compare the
    // CODE only -- the comments next to these calls name them too.
    const code = t => t.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const a = code(showAuth);
    assert.ok(a.indexOf('wantsTeacherSignIn()') < a.indexOf("syncUrl('/')"),
        'syncUrl erases the path, so the check must come first');
    const routing = code(app.slice(app.indexOf('function handleAppRouting'), app.indexOf('function handleAppRouting') + 1200));
    assert.ok(routing.indexOf('wantsTeacherSignIn()') < routing.indexOf('showLandingOnly()'),
        'showLandingOnly rewrites the path, so the check must come first');
});
