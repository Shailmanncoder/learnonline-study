const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../config/db');

test('leaderboard requires login, masks other emails and ranks only students consistently', async t => {
    await db.ready();
    const ids = [];
    for (let i = 0; i < 52; i++) {
        const result = await db.run('INSERT INTO users(username,password,role,xp) VALUES(?,?,?,?)', [`learner-${i}@example.test`, 'unused', i === 0 ? 'teacher' : 'student', 100]);
        ids.push(result.lastID);
    }
    const app = express(); app.use('/user', require('../controllers/userController'));
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const url = `http://127.0.0.1:${server.address().port}/user/leaderboard`;
    assert.equal((await fetch(url)).status, 401);
    const token = jwt.sign({ user: { id: ids[51], role: 'student' } }, process.env.JWT_SECRET);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.leaders.length, 50);
    assert.ok(data.leaders.every(user => !user.username.includes('@') && !user.bio && !user.profile_picture));
    assert.ok(data.leaders.every(user => user.id !== ids[0]));
    assert.equal(data.currentUserRank.rank, 51);
    assert.equal(data.currentUserRank.username, 'learner-51@example.test');
});
