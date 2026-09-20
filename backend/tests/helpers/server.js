const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');

// Boots the real server on a random port and talks to it over HTTP, so these
// tests exercise the same middleware chain and status codes a browser gets.
async function startServer(t) {
    const child = spawn(process.execPath, [path.resolve(__dirname, '../../server.js')], {
        cwd: path.dirname(process.env.SQLITE_PATH),
        env: { ...process.env, PORT: '0', HOST: '127.0.0.1' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stderr.on('data', d => { output += d; });
    t.after(async () => {
        if (child.exitCode === null) {
            const exited = once(child, 'exit');
            child.kill();
            await exited;
        }
    });
    const port = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Startup timed out: ${output}`)), 15000);
        child.stdout.on('data', d => {
            output += d;
            const match = output.match(/Server running on port (\d+)/);
            if (match) { clearTimeout(timer); resolve(match[1]); }
        });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Startup exited ${code}: ${output}`)); });
    });

    const base = `http://127.0.0.1:${port}`;
    const call = async (method, url, { token, body } = {}) => {
        const res = await fetch(base + url, {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {})
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
        let payload = null;
        try { payload = await res.json(); } catch { payload = null; }
        return { status: res.status, body: payload };
    };

    return {
        base,
        get: (url, opts) => call('GET', url, opts),
        post: (url, body, opts) => call('POST', url, { ...opts, body }),
        // Registers an account and returns its token. `role` is what the
        // browser asks for; the server decides what it actually gets.
        async account(username, role = 'student') {
            const res = await call('POST', '/api/auth/register', {
                body: { username, password: 'TestPassword42', role }
            });
            if (res.status !== 200 || !res.body || !res.body.token) {
                throw new Error(`Could not register ${username}: ${res.status} ${JSON.stringify(res.body)}`);
            }
            return { token: res.body.token, id: res.body.user.id, role: res.body.user.role, username };
        }
    };
}

module.exports = { startServer };
