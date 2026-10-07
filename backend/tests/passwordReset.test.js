const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = p => fs.readFileSync(path.join(__dirname, p), 'utf8');
const stripComments = t => t.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
// reset-password is defined ABOVE login in the file, so a slice to the end of
// the file would pick up login's jwt.sign and its own code.
const routeBody = (src, start, end) => {
    const from = src.indexOf(start);
    const to = end ? src.indexOf(end, from + 1) : src.length;
    return stripComments(src.slice(from, to === -1 ? src.length : to));
};
const authCtl = read('../controllers/authController.js');
const middleware = read('../middleware/auth.js');
const migration = read('../migrations/003_password_reset.js');
const server = read('../server.js');
const mailer = read('../services/mailer.js');

test('a reset request never says whether the account exists', () => {
    // The same reasoning as the sign-in fix: a reset form that answers "no such
    // account" is the same oracle by another route.
    assert.match(authCtl, /const RESET_SENT =/);
    // The reply is sent before the account is even looked at.
    const route = routeBody(authCtl, "router.post('/forgot-password'", "router.post('/reset-password'");
    assert.ok(route.indexOf('res.json({ msg: RESET_SENT') < route.indexOf('if (!user) return'),
        'the answer must not depend on whether the account was found');
    assert.match(route, /forgotLimit/, 'and it has to be rate limited');
});

test('codes are random, hashed, short-lived and single use', () => {
    assert.match(authCtl, /crypto\.randomInt/, 'Math.random is not good enough for a credential');
    assert.ok(!/Math\.random/.test(stripComments(authCtl)));
    assert.match(authCtl, /bcrypt\.hash\(code, 10\)/, 'the code must not be stored in the clear');
    assert.match(authCtl, /RESET_TTL_MS = 10 \* 60_000/);
    assert.match(authCtl, /RESET_MAX_TRIES = 5/);
    // The attempt is counted BEFORE the comparison, so a failure mid-check
    // cannot be replayed for unlimited guesses.
    const confirm = routeBody(authCtl, "router.post('/reset-password'", "router.post('/login'");
    assert.ok(confirm.indexOf('attempts = attempts + 1') < confirm.indexOf('bcrypt.compare(code'),
        'count the guess before checking it');
    assert.match(confirm, /used_at = \?/, 'a used code must be marked spent');
});

test('resetting a password ends the sessions opened with the old one', () => {
    // Otherwise whoever took the account keeps their token for its full five
    // days, and the reset achieves nothing against them.
    assert.match(authCtl, /password_changed_at = \?/);
    assert.match(middleware, /password_changed_at/);
    assert.match(middleware, /decoded\.iat \* 1000 < Number\(account\.password_changed_at\)/);
    // The column has to exist before the first request is served.
    assert.match(server, /migrations\/003_password_reset/);
});

test('a reset hands back no session of its own', () => {
    const confirm = routeBody(authCtl, "router.post('/reset-password'", "router.post('/login'");
    assert.ok(!/jwt\.sign/.test(confirm),
        'a stolen code alone must not produce a signed-in session');
});

test('the migration is additive and repeatable', () => {
    // The user's standing rule: never drop or rewrite, always re-runnable.
    assert.ok(!/DROP |TRUNCATE |DELETE FROM users/i.test(migration));
    assert.match(migration, /CREATE TABLE IF NOT EXISTS password_resets/);
    assert.match(migration, /PRAGMA table_info|SHOW COLUMNS/, 'adding a column must check first');
    // The backfill must never clobber an address somebody set themselves.
    assert.match(migration, /SET email = username\s*\n?\s*WHERE email IS NULL/);
});

test('email reuses the SMTP settings that already exist', () => {
    // Receipts already spoke SMTP; a second set of variables would mean
    // configuring the same mailbox twice.
    assert.match(mailer, /PAYMENTS_SMTP_HOST/);
    assert.match(mailer, /SMTP_HOST/);
    assert.match(mailer, /function isConfigured/);
    // Without a mail account the code must not be exposed in production.
    assert.match(authCtl, /process\.env\.NODE_ENV !== 'production'/,
        'the dev-only log must be gated');
});
