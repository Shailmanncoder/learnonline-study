const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = p => fs.readFileSync(path.join(__dirname, p), 'utf8');
const aiCtl = read('../controllers/aiController.js');
const authCtl = read('../controllers/authController.js');
const mailer = read('../services/mailer.js');
const app = read('../../frontend/app.js');
const api = read('../../frontend/api.js');
const html = read('../../frontend/index.html');

test('codes come from the support address', () => {
    assert.match(mailer, /\|\| 'support@shailmanntech\.com'/);
    // A defaulted From must not make an unconfigured server look ready to
    // send — only a real provider can.
    assert.match(mailer, /Boolean\(\(s\.resendKey \|\| s\.host\) && s\.from\)/);
});

test('Resend is used when its key is set, SMTP otherwise', () => {
    const { isConfigured, describe, send } = require('../services/mailer');
    const before = { key: process.env.RESEND_API_KEY, host: process.env.SMTP_HOST };
    try {
        process.env.RESEND_API_KEY = ''; process.env.SMTP_HOST = '';
        assert.equal(isConfigured(), false, 'nothing set is not configured');
        assert.match(describe(), /not configured/);

        process.env.RESEND_API_KEY = 're_key';
        assert.equal(isConfigured(), true);
        assert.match(describe(), /^Resend API/, 'the key takes precedence');

        process.env.RESEND_API_KEY = ''; process.env.SMTP_HOST = 'smtp.example.com';
        assert.equal(isConfigured(), true);
        assert.match(describe(), /^SMTP /);
    } finally {
        process.env.RESEND_API_KEY = before.key || '';
        process.env.SMTP_HOST = before.host || '';
    }
    // Resend's own reason is passed through: an unverified sending domain is
    // the usual cause and a generic failure would hide it.
    assert.match(mailer, /Resend refused the message \(\$\{res\.status\}\)/);
    assert.match(mailer, /api\.resend\.com\/emails/);
    assert.match(mailer, /AbortSignal\.timeout/, 'a hung provider must not hang the request');
    assert.ok(typeof send === 'function');
});

test('the email requirement only applies when mail can actually be sent', () => {
    // Insisting on a code nobody can receive would lock every account out of
    // every tool with no way to satisfy it.
    const meter = aiCtl.slice(aiCtl.indexOf('async function meter('), aiCtl.indexOf('async function meter(') + 2200);
    // isWorking(), not isConfigured(): a present-but-wrong key must not gate.
    assert.match(meter, /require\('\.\.\/services\/mailer'\)\.isWorking\(\)/);
    assert.match(meter, /EMAIL_REQUIRED/);
    assert.match(meter, /email_verified_at/, 'an unconfirmed address is not enough');
});

test('an email given at sign-up is stored unverified and sent a code', () => {
    assert.match(authCtl, /INSERT INTO users \(username, password, role, email\)/);
    assert.match(authCtl, /sendEmailCode\(result\.lastID, supplied\)/);
    // Unverified until the code returns — registering with an address proves
    // nothing about being able to read it.
    assert.ok(!/email_verified_at\s*=\s*\?[^;]*INSERT INTO users/.test(authCtl));
    // And it cannot collide with another account's address or username.
    assert.match(authCtl, /SELECT id FROM users WHERE email = \? OR username = \?/);
    // A mail failure must never fail the sign-up.
    assert.match(authCtl, /sendEmailCode\([\s\S]{0,80}\.catch\(/);
});

test('every AI call reports a refusal the screen can act on', () => {
    // Three of them threw a bare Error, so the same refusal opened a prompt
    // from the tool page and read as "Error communicating with AI" in chat.
    assert.match(api, /function aiError\(/);
    assert.ok(!/throw new Error\(e\.msg \|\| 'AI generation failed'\)/.test(api),
        'no AI call may drop the code');
    assert.match(api, /err\.code = e\.code/);
});

test('a refusal offers the next step instead of stopping', () => {
    assert.match(app, /function openEmailGate/);
    assert.ok(html.includes('id="email-gate-modal"'));
    // It retries what the person was doing, rather than making them start again.
    assert.match(app, /emailGateRetry/);
    assert.match(app, /openEmailGate\(err\.message, err\.email, \(\) => document\.getElementById\('run-tool-btn'\)/);
    assert.match(app, /openEmailGate\(err\.message, err\.email, \(\) => \{ grokChatInput\.value = text; sendGrokMessage\(\); \}\)/);
    // And the Companion stops calling a refusal a connection problem.
    assert.match(app, /err\.code === 'EMAIL_REQUIRED'[\s\S]{0,400}grok-blocked/);
});

test('sign-up asks for the email, sign-in does not', () => {
    assert.ok(html.includes('id="auth-email-group"'));
    assert.match(app, /emailGroup\.style\.display = window\.isLoginMode \? 'none' : ''/);
    assert.match(api, /register: async \(username, password, role = 'student', email = ''\)/);
});

test('a key that is present but wrong must not gate anything', async () => {
    // This happened: a placeholder key reached production, isConfigured() went
    // true, the AI-tool requirement switched on, and no code could ever be
    // delivered to satisfy it. Being configured and being able to deliver are
    // different things, and only the second may gate anything.
    const m = require('../services/mailer');
    assert.equal(typeof m.isWorking, 'function');
    assert.equal(typeof m.ready, 'function');

    // Nothing gates on isConfigured() any more.
    for (const file of ['../controllers/aiController.js', '../controllers/authController.js', '../controllers/userController.js']) {
        const src = read(file).replace(/\/\/[^\n]*/g, '');
        assert.ok(!/mailer\.isConfigured\(\)|require\('\.\.\/services\/mailer'\)\.isConfigured\(\)/.test(src),
            `${file} still decides on isConfigured()`);
    }
    assert.match(aiCtl, /require\('\.\.\/services\/mailer'\)\.isWorking\(\)/);

    // Unknown counts as unavailable, which is the safe direction.
    assert.match(mailer, /verified = false;\s*\n\s*return false;/);
    assert.match(mailer, /return isConfigured\(\) && verified === true/);
    // The provider is asked, rather than taken on trust.
    assert.match(mailer, /api\.resend\.com\/domains/);
    assert.match(mailer, /AbortSignal\.timeout\(8000\)/);
});

test('the email requirement applies to new accounts, not existing ones', async () => {
    // Everyone who already had an account signed up when a username alone was
    // enough, and 24 of the 26 have no address on file. Switching the rule on
    // for them would stop all of them at once, mid-use, over a rule that did
    // not exist when they joined.
    const migration = read('../migrations/007_email_exempt.js');

    // Stamped into the data, not compared against a date: a timestamp test
    // depends on the clock, the column format and an env var all staying right.
    assert.match(migration, /ALTER TABLE users ADD COLUMN email_exempt/);
    assert.match(migration, /UPDATE users SET email_exempt = 1/);
    // Only once. A second run must not exempt accounts made since.
    assert.match(migration, /if \(columns\.includes\('email_exempt'\)\) return;/);
    assert.ok(migration.indexOf("includes('email_exempt')) return") < migration.indexOf('UPDATE users SET email_exempt = 1'),
        'the stamp must be behind the already-run check');

    // And the gate honours it.
    assert.match(aiCtl, /!account\?\.email_exempt && !account\?\.email_verified_at/);
    assert.match(aiCtl, /SELECT email, email_verified_at, email_exempt FROM users/);

    // A fresh database has no legacy accounts, so the default is "subject to
    // the rule" rather than exempt.
    const schema = read('../config/db.js');
    assert.match(schema, /email_exempt INTEGER NOT NULL DEFAULT 0/);
    assert.match(schema, /email_exempt INT NOT NULL DEFAULT 0/);
});
