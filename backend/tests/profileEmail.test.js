const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = p => fs.readFileSync(path.join(__dirname, p), 'utf8');
const stripComments = t => t.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const userCtl = read('../controllers/userController.js');
const app = read('../../frontend/app.js');
const api = read('../../frontend/api.js');
const html = read('../../frontend/index.html');

const profileRoute = () => {
    const src = stripComments(userCtl);
    const from = src.indexOf("router.post('/profile'");
    return src.slice(from, src.indexOf("router.post('/email'", from));
};
// Email moved out of the profile save into its own verified flow.
const emailRoute = () => {
    const src = stripComments(userCtl);
    const from = src.indexOf("router.post('/email'");
    return src.slice(from, src.indexOf("router.post('/xp'", from));
};

test('a recovery email must be unique against every username AND email', () => {
    const route = emailRoute();
    // A reset looks an account up by "username = ? OR email = ?". If two
    // accounts could hold the same address -- or if one account's email
    // matched another's username -- which account a reset code belonged to
    // would depend on row order. That is a way to take over someone else's
    // recovery, so both collisions are refused.
    assert.match(route, /SELECT id FROM users WHERE \(email = \? OR username = \?\) AND id <> \?/,
        'the check must cover both columns, and exclude the caller');
    assert.match(route, /already in use on another account/);
});

test('an email is validated and normalised before it is stored', () => {
    const route = emailRoute();
    assert.match(userCtl, /const EMAIL_RE =/);
    assert.match(route, /\.toLowerCase\(\)/, 'addresses are case-insensitive in practice');
    assert.match(route, /EMAIL_RE\.test\(email\)/);
    assert.match(route, /email\.length > 254/);
    // Clearing it has to stay possible, and needs no code: removing an address
    // takes capability away rather than granting it.
    assert.match(route, /UPDATE users SET email = NULL, email_verified_at = NULL/);
});

test('saving one field does not blank the others', () => {
    // It used to write username, picture and bio on every call, so a client
    // sending only a bio passed username = undefined and the UPDATE failed
    // against NOT NULL. Only keys actually present are touched now.
    const route = profileRoute();
    assert.match(route, /'username' in body/);
    assert.match(route, /'bio' in body/);
    // 'email' is deliberately NOT here any more -- see emailVerification.test.js.
    assert.ok(!/'email' in body/.test(route));
    assert.ok(!/UPDATE users SET username = \?, profile_picture = \?, bio = \? WHERE/.test(userCtl));
    assert.match(route, /if \(!sets\.length\)/, 'an empty update should be refused, not run');
});

test('the username is validated on update, as it is on register', () => {
    const route = profileRoute();
    assert.match(route, /username\.length > 50/);
    assert.match(route, /SELECT id FROM users WHERE username = \? AND id <> \?/);
});

test('the profile returns the email so the screen can show it', () => {
    assert.match(userCtl, /SELECT id, username, email, email_verified_at, role, xp/);
    assert.ok(html.includes('id="settings-email"'), 'the field must exist in the page');
    assert.match(app, /getElementById\('settings-email'\)/);
    // And an account with no way back has to be told so.
    assert.match(app, /No recovery email set/);
    assert.match(app, /renderEmailState/);
});

test('the client sends named fields and shows the server’s reason', () => {
    // updateProfile took four positional arguments, so it could not express
    // "change only the email", and every failure read "Username might be taken"
    // whatever had actually gone wrong.
    assert.match(api, /updateProfile: async \(token, fields\)/);
    assert.ok(!/Error: Username might be taken/.test(app));
    const save = app.slice(app.indexOf("'save-profile-btn'"));
    assert.match(save.slice(0, 2600), /msg\.textContent = err\.message/);
});
