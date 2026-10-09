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
    assert.match(meter, /require\('\.\.\/services\/mailer'\)\.isConfigured\(\)/);
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
