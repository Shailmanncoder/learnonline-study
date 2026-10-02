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
