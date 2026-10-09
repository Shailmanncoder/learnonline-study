const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = p => fs.readFileSync(path.join(__dirname, p), 'utf8');
const authCtl = read('../controllers/authController.js');
const app = read('../../frontend/app.js');
const api = read('../../frontend/api.js');
const html = read('../../frontend/index.html');

const route = () => authCtl.slice(authCtl.indexOf("router.post('/google'"), authCtl.indexOf("router.get('/google/config'"));

test('identity comes from the signed token, never from the request', () => {
    // A body claiming an email would otherwise be a way to sign in as anyone.
    const r = route();
    assert.match(r, /verifyIdToken\(\{ idToken: credential, audience: clientId \}\)/,
        'the audience must be checked, or a token minted for any other app would work');
    assert.match(r, /ticket\.getPayload\(\)/);
    assert.match(r, /\['accounts\.google\.com', 'https:\/\/accounts\.google\.com'\]\.includes\(payload\.iss\)/);
    // Only the token's email is used. req.body is read once, for the credential.
    assert.equal((r.match(/req\.body/g) || []).length, 1);
    assert.ok(!/req\.body[^)]*email/.test(r), 'the client must not supply the address');
});

test('an address Google has not verified is refused', () => {
    // The whole flow rests on the address being proof of identity.
    assert.match(route(), /payload\.email_verified !== true/);
});

test('an existing account is linked, not duplicated', () => {
    const r = route();
    assert.match(r, /SELECT \* FROM users WHERE email = \? OR username = \?/);
    // What the person set here is theirs; only what is missing gets filled in.
    assert.match(r, /if \(!user\.profile_picture && picture\)/);
    assert.match(r, /user\.email_verified_at \|\| now/, 'an existing confirmation time is kept');
});

test('a Google account starts confirmed and without a usable password', () => {
    const r = route();
    assert.match(r, /email_verified_at, profile_picture\) VALUES/);
    // Google proved the address, so no code is needed — and no password is
    // set, because nobody chose one. "Forgot password" creates one later.
    assert.match(r, /crypto\.randomUUID\(\) \+ crypto\.randomUUID\(\)/);
    assert.match(r, /bcrypt\.hash/);
});

test('only Google can be the source of a remote avatar', () => {
    // profile_picture is settable by the account holder, so allowing any
    // https URL would let one be pointed at a tracker that fires whenever
    // another student loads the leaderboard.
    assert.match(app, /GOOGLE_PHOTO_HOST = \/\^https:\\\/\\\/\[a-z0-9-\]\+\\\.googleusercontent\\\.com\\\//);
    assert.match(app, /if \(GOOGLE_PHOTO_HOST\.test\(s\)\) return s;/);
    // The server stores only https, and bounds the length.
    assert.match(route(), /\/\^https:\\\/\\\/\/\.test\(payload\.picture\)/);
});

test('the button is hidden when Google is not set up', () => {
    // A button that cannot work is worse than no button.
    assert.ok(html.includes('id="google-signin"') && html.includes('hidden'));
    assert.match(app, /if \(!config\.enabled \|\| !config\.clientId\) \{ wrap\.hidden = true; return; \}/);
    assert.match(authCtl, /if \(!clientId\) return res\.status\(503\)/);
    assert.match(api, /googleSignIn: async \(credential\)/);
});

test('sign-in attempts are rate limited', () => {
    assert.match(authCtl, /name: 'auth-google'/);
    assert.match(route(), /refund\('auth-google', req\)/, 'a success is not an attempt');
});
