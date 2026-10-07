const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = p => fs.readFileSync(path.join(__dirname, p), 'utf8');
const strip = t => t.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const userCtl = read('../controllers/userController.js');
const authCtl = read('../controllers/authController.js');
const migration = read('../migrations/004_email_verification.js');
const server = read('../server.js');
const app = read('../../frontend/app.js');
const html = read('../../frontend/index.html');

test('a reset code only ever goes to a confirmed address', () => {
    // Anyone can type any address into their own profile. Honouring an
    // unconfirmed one would let them pull a stranger's account into the reset
    // flow, and send a code to an inbox that never asked for it.
    assert.match(authCtl, /email = \? AND email_verified_at IS NOT NULL/,
        'an unverified address must not identify an account');
    assert.match(authCtl, /if \(!user\.email \|\| !user\.email_verified_at\) return;/);
    // The old fallback to an email-shaped username is gone: registering with
    // an address is not proof of reading it.
    assert.ok(!/test\(user\.username\) \? user\.username : null/.test(authCtl));
});

test('a pending address is held apart from the live one', () => {
    // Starting a change must not disturb an address that already works: get
    // the new one wrong and the old one still receives codes.
    const route = strip(userCtl).slice(strip(userCtl).indexOf("router.post('/email'"));
    assert.match(route, /INSERT INTO email_verifications/);
    const send = route.slice(0, route.indexOf("router.post('/email/verify'"));
    assert.ok(!/UPDATE users SET email = \?, email_verified_at = \?/.test(send),
        'the address must not be written to users until it is confirmed');
    // It is written only on the confirm path.
    const confirm = route.slice(route.indexOf("router.post('/email/verify'"));
    assert.match(confirm, /UPDATE users SET email = \?, email_verified_at = \?/);
});

test('confirmation codes are hashed, limited and single use', () => {
    const route = strip(userCtl).slice(strip(userCtl).indexOf("router.post('/email'"));
    assert.match(route, /crypto\.randomInt/);
    assert.match(route, /bcrypt\.hash\(code, 10\)/);
    assert.match(userCtl, /VERIFY_TTL_MS = 15 \* 60_000/);
    assert.match(userCtl, /VERIFY_MAX_TRIES = 5/);
    const confirm = route.slice(route.indexOf("router.post('/email/verify'"));
    assert.ok(confirm.indexOf('attempts = attempts + 1') < confirm.indexOf('bcrypt.compare(code'),
        'count the guess before checking it');
    assert.match(confirm, /used_at = \?/);
    assert.match(userCtl, /emailSendLimit/);
    assert.match(userCtl, /emailCheckLimit/);
});

test('ownership is re-checked when the code comes back', () => {
    // Somebody else could claim the address while the code was in flight.
    const confirm = strip(userCtl).slice(strip(userCtl).indexOf("router.post('/email/verify'"));
    assert.match(confirm, /SELECT id FROM users WHERE \(email = \? OR username = \?\) AND id <> \?/);
    assert.match(confirm, /now in use on another account/);
});

test('an ordinary profile save cannot change the email', () => {
    // Otherwise a confirmed address could be swapped for a typo -- or for an
    // attacker's -- with no code at all.
    const profile = strip(userCtl);
    const route = profile.slice(profile.indexOf("router.post('/profile'"), profile.indexOf("router.post('/email'"));
    assert.ok(!/'email' in body/.test(route), 'the profile save must not accept an email');
    assert.ok(!/sets\.push\('email = \?'\)/.test(route));
    assert.ok(!/email: newEmail/.test(app), 'and the client must not send one');
});

test('the migration is additive, repeatable, and verifies nothing by itself', () => {
    assert.ok(!/DROP |TRUNCATE |DELETE FROM users/i.test(migration));
    assert.match(migration, /CREATE TABLE IF NOT EXISTS email_verifications/);
    assert.match(migration, /PRAGMA table_info|SHOW COLUMNS/);
    // Addresses copied from usernames by migration 003 stay unconfirmed.
    assert.ok(!/UPDATE users SET email_verified_at/.test(migration),
        'nothing may be marked verified without someone proving it');
    assert.match(server, /migrations\/004_email_verification/);
});

test('the screen says which of the three states the account is in', () => {
    for (const id of ['settings-email-badge', 'settings-email-send', 'settings-email-code', 'settings-email-confirm']) {
        assert.ok(html.includes(`id="${id}"`), `${id} is missing from the page`);
    }
    assert.match(app, /function renderEmailState/);
    assert.match(app, /No recovery email set/);
    assert.match(app, /has not been confirmed yet/);
    assert.match(app, /email-badge-verified/);
});
