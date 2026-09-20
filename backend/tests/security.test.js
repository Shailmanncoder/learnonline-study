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
// The token says which account is calling. What that account *is* — whether it
// still exists, and what role it holds — is read from the account row, because
// a token stays valid for five days after the answer to either may have changed.
const db = require('../config/db');
// Settles on whichever the middleware actually does — call next(), or answer
// with json() — rather than on a guess about how many ticks the lookup takes.
const run = (token) => new Promise((resolve) => {
    const req = { header: () => token === null ? undefined : `Bearer ${token}` };
    let status = null;
    auth(req, {
        status(code) { status = code; return this; },
        json() { resolve({ passed: false, status, req }); }
    }, () => resolve({ passed: true, status: null, req }));
});

test('authentication rejects forged, expired and malformed identities', async () => {
    const secret = getJwtSecret();
    for (const token of [
        null,
        jwt.sign({ user: { id: 1 } }, 'attacker-key'),
        jwt.sign({ user: { id: 1 } }, secret, { expiresIn: -1 }),
        jwt.sign({ user: { id: '1' } }, secret),
        jwt.sign({ user: { id: 1 } }, secret, { algorithm: 'HS384' }),
    ]) {
        const { passed, status } = await run(token);
        assert.equal(passed, false);
        assert.equal(status, 401);
    }
});

test('a perfectly signed token for a deleted account is rejected, and the role comes from the account', async () => {
    await db.ready();
    const secret = getJwtSecret();

    // Correctly signed, never tampered with — and the account is gone.
    const orphan = await run(jwt.sign({ user: { id: 987654, role: 'teacher' } }, secret));
    assert.equal(orphan.passed, false, 'a token outliving its account must not authenticate');
    assert.equal(orphan.status, 401);

    const created = await db.run("INSERT INTO users (username, password, role) VALUES ('auth-fixture', 'x', 'student')");
    // The token claims teacher. The account row says student.
    const claimed = await run(jwt.sign({ user: { id: created.lastID, role: 'teacher' } }, secret));
    assert.equal(claimed.passed, true);
    assert.equal(claimed.req.user.id, created.lastID);
    assert.equal(claimed.req.user.role, 'student', 'the token must not be able to promote its own account');
});
