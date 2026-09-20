// A half-written grade is worse than a failed one: the student sees a score
// nobody awarded, or XP for work that was never recorded. These check that a
// write which fails partway leaves nothing behind, and that one account's
// results are never reachable from another.
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../config/db');
const { grantOnce } = require('../services/rewards');
const { startServer } = require('./helpers/server');

test('a failure partway through a transaction leaves no partial grade or reward', async () => {
    await db.ready();
    const user = await db.run("INSERT INTO users (username, password, role) VALUES ('tx-user', 'x', 'student')");
    const userId = user.lastID;

    // Real parent rows: MySQL enforces the foreign key on worksheet_attempts
    // and SQLite (with foreign_keys off) does not, so a made-up worksheet id
    // would fail on one engine before reaching the failure being tested.
    const cls = await db.run(
        "INSERT INTO classrooms (name, section, class_code, created_by, status) VALUES ('Tx', 'A', 'TXCODE', ?, 'active')",
        [userId]
    );
    const ws = await db.run(
        "INSERT INTO class_worksheets (class_id, teacher_id, title, subject, worksheet_data, total_marks, status) VALUES (?, ?, 'Tx', 'General', '{\"questions\":[]}', 10, 'published')",
        [cls.lastID, userId]
    );
    const worksheetId = ws.lastID;

    const before = await db.get('SELECT xp FROM users WHERE id = ?', [userId]);

    await assert.rejects(db.transaction(async () => {
        await db.run(
            `INSERT INTO worksheet_attempts (worksheet_id, student_id, answers, score, total_marks, status, grading_status)
             VALUES (?, ?, ?, ?, ?, 'completed', 'graded')`,
            [worksheetId, userId, '[]', 9, 10]
        );
        await grantOnce(userId, `worksheet:${worksheetId}`, 45, 'should not survive');
        // Whatever goes wrong after the score is written — a constraint, a
        // dropped connection, a bug — must take the whole thing with it.
        throw new Error('write failed halfway');
    }), /write failed halfway/);

    const attempt = await db.get('SELECT * FROM worksheet_attempts WHERE worksheet_id = ? AND student_id = ?', [worksheetId, userId]);
    assert.equal(attempt, undefined, 'the attempt must not survive a failed write');

    const grant = await db.get('SELECT * FROM reward_grants WHERE user_id = ? AND reward_key = ?', [userId, `worksheet:${worksheetId}`]);
    assert.equal(grant, undefined, 'the reward row must not survive');

    const after = await db.get('SELECT xp FROM users WHERE id = ?', [userId]);
    assert.equal(after.xp, before.xp, 'XP must not have moved');
});

test('an unrelated write is not swallowed by another request\'s rollback', async () => {
    await db.ready();
    const a = await db.run("INSERT INTO users (username, password, role) VALUES ('tx-a', 'x', 'student')");
    const b = await db.run("INSERT INTO users (username, password, role) VALUES ('tx-b', 'x', 'student')");

    // On SQLite there is one connection, so without serialization this INSERT
    // could land inside the other transaction and be rolled back with it.
    const doomed = db.transaction(async () => {
        await grantOnce(a.lastID, 'doomed:1', 10, 'rolled back');
        await new Promise(r => setTimeout(r, 40));
        throw new Error('rollback');
    }).catch(() => 'rolled back');

    const innocent = (async () => {
        await new Promise(r => setTimeout(r, 10));
        return grantOnce(b.lastID, 'innocent:1', 7, 'must survive');
    })();

    await Promise.all([doomed, innocent]);

    const gone = await db.get('SELECT * FROM reward_grants WHERE user_id = ? AND reward_key = ?', [a.lastID, 'doomed:1']);
    assert.equal(gone, undefined, 'the failed transaction rolled back');

    const kept = await db.get('SELECT * FROM reward_grants WHERE user_id = ? AND reward_key = ?', [b.lastID, 'innocent:1']);
    assert.ok(kept, 'the unrelated write must survive the other request failing');
    assert.equal(kept.xp, 7);
});

test('one account cannot read another account\'s results or drafts', { timeout: 40000 }, async (t) => {
    const api = await startServer(t);
    const teacher = await api.account('iso-teacher', 'teacher');
    const alice = await api.account('iso-alice');
    const mallory = await api.account('iso-mallory');

    const cls = (await api.post('/api/teacher/classes', { name: 'Iso', section: 'A' }, { token: teacher.token })).body.classroom;
    await api.post('/api/classroom/join', { classCode: cls.class_code }, { token: alice.token });
    await api.post('/api/classroom/join', { classCode: cls.class_code }, { token: mallory.token });

    const ws = (await api.post('/api/teacher/worksheets/publish', {
        classId: cls.id, title: 'Shared', subject: 'General',
        worksheet_data: { questions: [{ id: 'q1', type: 'mcq', question: '1+1?', options: ['1', '2'], correct_answer: '2', marks: 5 }] }
    }, { token: teacher.token })).body.worksheet;

    await api.post(`/api/classroom/worksheets/${ws.id}/submit`, {
        submissionKey: 'alice-attempt-1', answers: [{ id: 'q1', answer: '2' }]
    }, { token: alice.token });

    await t.test('the other student sees their own absence, not Alice\'s score', async () => {
        const mine = await api.get(`/api/classroom/worksheets/${ws.id}/my-result`, { token: mallory.token });
        assert.equal(mine.status, 404);
        assert.equal(mine.body.error.code, 'NO_ATTEMPT');
    });

    await t.test('Alice\'s own result is hers and is correct', async () => {
        const mine = await api.get(`/api/classroom/worksheets/${ws.id}/my-result`, { token: alice.token });
        assert.equal(mine.status, 200);
        assert.equal(mine.body.score, 5);
    });

    await t.test('the other student cannot replay Alice\'s submission key', async () => {
        // Same key, different account: this must be a new attempt of Mallory's,
        // never a read of Alice's recorded result.
        const res = await api.post(`/api/classroom/worksheets/${ws.id}/submit`, {
            submissionKey: 'alice-attempt-1', answers: [{ id: 'q1', answer: '1' }]
        }, { token: mallory.token });
        assert.equal(res.status, 200);
        assert.equal(res.body.replayed, undefined, 'must not replay another account\'s attempt');
        assert.equal(res.body.score, 0, 'graded on Mallory\'s own wrong answer');

        const alices = await api.get(`/api/classroom/worksheets/${ws.id}/my-result`, { token: alice.token });
        assert.equal(alices.body.score, 5, 'Alice\'s result is untouched');
    });

    await t.test('a student cannot request a review of someone else\'s attempt', async () => {
        const res = await api.post(`/api/classroom/worksheets/${ws.id}/request-review`, { reason: 'not my attempt' }, { token: mallory.token });
        // It is accepted, but against Mallory's own attempt — never Alice's.
        assert.equal(res.status, 200);
        const queue = await api.get('/api/teacher/reviews/queue', { token: teacher.token });
        const opened = queue.body.requests.filter(r => r.student_name === 'iso-mallory');
        assert.equal(opened.length, 1);
        assert.equal(Number(opened[0].previous_score), 0, 'it references Mallory\'s own score');
    });
});
