const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');

test('signup, login and free tools work; every former billing endpoint is removed', { timeout: 20000 }, async (t) => {
    const child = spawn(process.execPath, [path.resolve(__dirname, '../server.js')], {
        cwd: path.dirname(process.env.SQLITE_PATH),
        env: { ...process.env, PORT: '0', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stderr.on('data', d => { output += d; });
    t.after(async () => {
        if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    });
    const port = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Startup timed out: ${output}`)), 10000);
        child.stdout.on('data', d => {
            output += d;
            const match = output.match(/Server running on port (\d+)/);
            if (match) { clearTimeout(timer); resolve(match[1]); }
        });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Startup exited ${code}: ${output}`)); });
    });
    const base = `http://127.0.0.1:${port}`;
    async function post(url, body, token) {
        return fetch(base + url, { method: 'POST', headers: {
            'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
        }, body: JSON.stringify(body) });
    }
    const credentials = { username: 'free-student', password: 'TestPassword42' };
    const registered = await post('/api/auth/register', { ...credentials, role: 'admin' });
    assert.equal(registered.status, 200);
    const account = await registered.json();
    assert.equal(account.user.role, 'student');
    assert.ok(account.token);
    const loggedIn = await post('/api/auth/login', credentials);
    assert.equal(loggedIn.status, 200);
    const { token } = await loggedIn.json();
    assert.equal((await post('/api/auth/login', { ...credentials, password: 'wrong' })).status, 400);
    assert.equal((await post('/api/auth/register', { username: {}, password: 123 })).status, 400);
    const profile = await fetch(base + '/api/user/profile', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(profile.status, 200);
    assert.equal((await profile.json()).username, credentials.username);
    assert.equal((await fetch(base + '/api/user/profile')).status, 401);
    for (const endpoint of ['config', 'plan']) {
        assert.equal((await fetch(`${base}/api/payment/${endpoint}`)).status, 404);
    }
    for (const endpoint of ['order', 'verify', 'tools']) {
        assert.equal((await post(`/api/payment/${endpoint}`, { plan: 'pro', demo: true }, token)).status, 404);
    }
    const html = await (await fetch(base + '/tool/ai-tutor')).text();
    assert.match(html, /active-tool/);
    assert.doesNotMatch(html, /checkout\.razorpay|plans-modal|upgrade-popup|data-section-gate/);
    const app = await (await fetch(base + '/app.js')).text();
    assert.doesNotMatch(app, /openPlansModal|isToolUnlocked|isSectionUnlocked|\/payment\//);
});
