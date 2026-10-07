const test = require('node:test');
const assert = require('node:assert/strict');
const { getJwtSecret } = require('../config/security');
const { getDatabaseMode, initializeDatabase } = require('../config/databaseMode');
const jwt = require('jsonwebtoken');
const auth = require('../middleware/auth');

test('authentication refuses absent, short and known fallback secrets', () => {
    for (const JWT_SECRET of ['', 'short', 'fallback_secret_for_local_dev', 'super_secret_jwt_key_for_studyhub_local_dev']) {
        assert.throws(() => getJwtSecret({ JWT_SECRET }), /JWT_SECRET/);
    }
    assert.equal(getJwtSecret({ JWT_SECRET: 'a'.repeat(64) }), 'a'.repeat(64));
});
test('database selection is explicit and a MySQL failure never opens SQLite', async () => {
    assert.equal(getDatabaseMode({}), 'mysql');
    assert.equal(getDatabaseMode({ DB_DRIVER: 'sqlite' }), 'sqlite');
    assert.throws(() => getDatabaseMode({ DB_DRIVER: 'typo' }));
    let sqliteCalls = 0;
    await assert.rejects(initializeDatabase('mysql', {
        mysql: async () => { throw new Error('unreachable'); },
        sqlite: async () => { sqliteCalls++; },
    }), /unreachable/);
    assert.equal(sqliteCalls, 0);
    await initializeDatabase('sqlite', { sqlite: async () => { sqliteCalls++; } });
    assert.equal(sqliteCalls, 1);
});
test('authentication rejects forged, expired and malformed identities', async () => {
    const secret = getJwtSecret();
    const tokens = [
        jwt.sign({ user: { id: 1 } }, 'attacker-key'),
        jwt.sign({ user: { id: 1 } }, secret, { expiresIn: -1 }),
        jwt.sign({ user: { id: '1' } }, secret),
        jwt.sign({ user: { id: 1 } }, secret, { algorithm: 'HS384' }),
    ];
    for (const token of tokens) {
        let status, nextCalled = false;
        await auth({ header: () => `Bearer ${token}` }, {
            status(code) { status = code; return this; }, json() {},
        }, () => { nextCalled = true; });
        assert.equal(status, 401);
        assert.equal(nextCalled, false);
    }
    const db=require('../config/db');await db.ready();
    await db.run("INSERT INTO users (id,username,password,role) VALUES (7,'auth-test','unused','student')");
    const req = { header: () => `Bearer ${jwt.sign({ user: { id: 7, role: 'student' } }, secret)}` };
    let passed = false;
    await auth(req, {}, () => { passed = true; });
    assert.ok(passed);
    assert.equal(req.user.id, 7);
    await db.run('DELETE FROM users WHERE id=7');
    let deletedStatus;await auth(req,{status(s){deletedStatus=s;return this;},json(){}},()=>assert.fail('Deleted account was authenticated'));
    assert.equal(deletedStatus,401);
});

// ── Added with the security audit ─────────────────────────────────
const fs = require('node:fs');
const path = require('node:path');
const read = p => fs.readFileSync(path.join(__dirname, p), 'utf8');
const authCtl = read('../controllers/authController.js');
const server = read('../server.js');
const limiter = read('../middleware/rateLimit.js');
const aiCtl = read('../controllers/aiController.js');

test('sign-in and sign-up are rate limited', () => {
    // There was no limit at all: twelve wrong passwords in a row each came
    // back immediately, so an account could be guessed at network speed.
    assert.match(authCtl, /name: 'auth-login'/, 'login needs its own bucket');
    assert.match(authCtl, /name: 'auth-register'/, 'register needs its own bucket');
    assert.match(authCtl, /router\.post\('\/login', loginLimit/, 'the limiter must be ON the route');
    assert.match(authCtl, /router\.post\('\/register', registerLimit/);
    // A correct password must not count, or a heavy user locks themselves out.
    assert.match(authCtl, /refund\('auth-login', req\)/);
});

test('sign-in does not reveal whether an account exists', () => {
    // 404 "Account not found" vs 400 "Incorrect password" let anyone test an
    // email address against the site and learn if it is registered.
    assert.ok(!/Account not found with this username/.test(authCtl));
    assert.ok(!/notFound: true/.test(authCtl));
    assert.ok(!/Incorrect password\. Please try again\./.test(authCtl));
    assert.match(authCtl, /const SIGNIN_FAILED =/, 'one message for both halves');
    // Exactly one failure response, used for both cases.
    assert.equal((authCtl.match(/msg: SIGNIN_FAILED/g) || []).length, 1);
    assert.match(authCtl, /!user \|\| !isMatch/, 'both halves must share a branch');
    // And it must not answer faster for an unknown username.
    assert.match(authCtl, /bcrypt\.compare\(password, '\$2a\$10\$/,
        'an unknown username still needs a comparable amount of work');
});

test('passwords have a floor above trivial', () => {
    assert.ok(!/password\.length < 6/.test(authCtl));
    assert.match(authCtl, /password\.length < 8/);
});

test('the username is not written to the logs', () => {
    // The username is the person's email; it was logged on every attempt.
    assert.ok(!/console\.log\('\[AUTH\][^)]*\busername\b/.test(authCtl),
        'auth logging must not include the username');
});

test('security headers are set for every response', () => {
    assert.match(server, /app\.disable\('x-powered-by'\)/);
    for (const header of ['X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'Permissions-Policy']) {
        assert.match(server, new RegExp(`res\\.set\\('${header}'`), `${header} is not set`);
    }
    // HSTS is only honest over TLS, so it is conditional -- but it must exist.
    assert.match(server, /req\.secure.*Strict-Transport-Security/);
    // It has to be app-wide middleware, not per-route as X-Frame-Options was.
    const block = server.slice(server.indexOf("app.disable('x-powered-by')"), server.indexOf('// ── CORS'));
    assert.match(block, /app\.use\(\(req, res, next\)/, 'headers must apply to every route');
});

test('CORS is not open to every origin', () => {
    assert.ok(!/app\.use\(cors\(\)\)/.test(server),
        'a bare cors() answers every origin with Access-Control-Allow-Origin: *');
    assert.match(server, /ALLOWED_ORIGINS/);
    assert.match(server, /credentials: false/);
});

test('the image proxy is not open to the internet', () => {
    // Unauthenticated and unlimited: anyone could drive upstream generation
    // on this server's bill, from this server's address.
    assert.match(aiCtl, /router\.get\('\/image', auth, rateLimit\(/);
});

test('the rate limiter sees the real client, not the proxy', () => {
    // It read X-Forwarded-For only when TRUST_PROXY === 'true', which is set
    // nowhere -- so behind nginx every visitor shared one bucket and the
    // payment limiters throttled unrelated people together.
    // Compare CODE only -- the comment there explains what TRUST_PROXY was.
    const code = limiter.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/TRUST_PROXY/.test(code), 'the unset env var must not gate this');
    assert.match(limiter, /req\.ip/, 'use Express’s trust-proxy-aware address');
    assert.match(server, /app\.set\('trust proxy', 1\)/, 'req.ip is only correct with this set');
});
