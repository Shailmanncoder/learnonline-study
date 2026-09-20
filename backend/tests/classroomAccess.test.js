// Who may do what to a classroom. Every case here is a request a browser can
// make directly, so each one asserts the server's answer — not the UI's.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/server');

test('classroom permissions hold against direct API requests', { timeout: 40000 }, async (t) => {
    const api = await startServer(t);

    const owner = await api.account('owner-teacher', 'teacher');
    const other = await api.account('unrelated-teacher', 'teacher');
    const subject = await api.account('subject-teacher', 'teacher');
    const student = await api.account('student-one');
    const student2 = await api.account('student-two');
    const outsider = await api.account('outsider-student');

    assert.equal(student.role, 'student', 'signup must not hand out roles on request');

    // ── A class, made by someone who is actually a teacher ──────────
    const created = await api.post('/api/teacher/classes', { name: 'Physics', section: 'A', subject: 'Physics' }, { token: owner.token });
    assert.equal(created.status, 200);
    const classId = created.body.classroom.id;
    const classCode = created.body.classroom.class_code;
    assert.match(classCode, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);

    await t.test('a student cannot create a classroom', async () => {
        const res = await api.post('/api/teacher/classes', { name: 'Fake', section: 'Z' }, { token: student.token });
        assert.equal(res.status, 403);
        assert.equal(res.body.error.code, 'ROLE_REQUIRED');
    });

    await t.test('a student cannot join as a teacher, even with the real class code', async () => {
        const res = await api.post('/api/teacher/classes/join', { classCode, role: 'owner' }, { token: student.token });
        assert.equal(res.status, 403, 'the student class code must not open the teacher portal');
        const roster = await api.get(`/api/teacher/classes/${classId}/students`, { token: student.token });
        assert.equal(roster.status, 403);
    });

    await t.test('a teacher joining by code cannot choose their own role', async () => {
        const res = await api.post('/api/teacher/classes/join', { classCode, role: 'owner', subject: 'Maths' }, { token: subject.token });
        assert.equal(res.status, 200);
        assert.equal(res.body.status, 'pending', 'a code requests a seat; it does not grant one');

        // Pending is not membership: no reading the roster while waiting.
        const roster = await api.get(`/api/teacher/classes/${classId}/students`, { token: subject.token });
        assert.equal(roster.status, 403);
        assert.equal(roster.body.error.code, 'APPROVAL_PENDING');

        // And the owner is still the only owner.
        const requests = await api.get(`/api/teacher/classes/${classId}/teacher-requests`, { token: owner.token });
        assert.equal(requests.status, 200);
        assert.equal(requests.body.requests.length, 1);
        assert.equal(requests.body.requests[0].username, 'subject-teacher');
    });

    await t.test('only the owner approves teachers, and cannot approve them to owner', async () => {
        const byOutsider = await api.post(`/api/teacher/classes/${classId}/teacher-requests/${subject.id}`, { decision: 'approve' }, { token: other.token });
        assert.equal(byOutsider.status, 403);

        const approved = await api.post(
            `/api/teacher/classes/${classId}/teacher-requests/${subject.id}`,
            { decision: 'approve', role: 'owner' },
            { token: owner.token }
        );
        assert.equal(approved.status, 200);
        assert.match(approved.body.message, /subject teacher/, 'an unassignable role must fall back, not be honoured');

        const roster = await api.get(`/api/teacher/classes/${classId}/students`, { token: subject.token });
        assert.equal(roster.status, 200, 'an approved teacher can now work in the class');
    });

    await t.test('an unrelated teacher cannot reach the class at all', async () => {
        for (const [method, url] of [
            ['get', `/api/teacher/classes/${classId}`],
            ['get', `/api/teacher/classes/${classId}/students`]
        ]) {
            const res = await api[method](url, { token: other.token });
            assert.equal(res.status, 403, `${url} leaked to an unrelated teacher`);
        }
        const post = await api.post('/api/teacher/announcements', { classId, title: 'x', message: 'y' }, { token: other.token });
        assert.equal(post.status, 403);
    });

    await t.test('class-wide powers are the owner\'s, not every teacher\'s', async () => {
        // The subject teacher is legitimately in this class, and still cannot
        // archive it, regenerate its code, or remove its students.
        const archive = await api.post(`/api/teacher/classes/${classId}/archive`, {}, { token: subject.token });
        assert.equal(archive.status, 403);

        const code = await api.post(`/api/teacher/classes/${classId}/regenerate-code`, {}, { token: subject.token });
        assert.equal(code.status, 403);

        const remove = await api.post(`/api/teacher/classes/${classId}/students/remove`, { studentId: student.id }, { token: subject.token });
        assert.equal(remove.status, 403);
    });

    // ── Students join, are blocked, and are let back in ─────────────
    await t.test('blocking denies access and unblocking permits a deliberate rejoin', async () => {
        const joined = await api.post('/api/classroom/join', { classCode }, { token: student.token });
        assert.equal(joined.status, 200);
        await api.post('/api/classroom/join', { classCode }, { token: student2.token });

        const blocked = await api.post(`/api/teacher/classes/${classId}/students/block`, { studentId: student.id, reason: 'test' }, { token: owner.token });
        assert.equal(blocked.status, 200);

        const whileBlocked = await api.get(`/api/classroom/${classId}/feed`, { token: student.token });
        assert.equal(whileBlocked.status, 403, 'a blocked student must lose access');
        const rejoinBlocked = await api.post('/api/classroom/join', { classCode }, { token: student.token });
        assert.equal(rejoinBlocked.status, 403);

        const unblocked = await api.post(`/api/teacher/classes/${classId}/students/unblock`, { studentId: student.id }, { token: owner.token });
        assert.equal(unblocked.status, 200);

        // Unblocking lifts the restriction; it does not silently put them back.
        const stillOut = await api.get(`/api/classroom/${classId}/feed`, { token: student.token });
        assert.equal(stillOut.status, 403, 'unblocking must not re-enrol on its own');

        const rejoined = await api.post('/api/classroom/join', { classCode }, { token: student.token });
        assert.equal(rejoined.status, 200, 'after unblocking, the class code must work again');
        const back = await api.get(`/api/classroom/${classId}/feed`, { token: student.token });
        assert.equal(back.status, 200);
    });

    await t.test('a removed student loses access and an outsider never had it', async () => {
        const removed = await api.post(`/api/teacher/classes/${classId}/students/remove`, { studentId: student2.id }, { token: owner.token });
        assert.equal(removed.status, 200);
        const after = await api.get(`/api/classroom/${classId}/feed`, { token: student2.token });
        assert.equal(after.status, 403);

        const never = await api.get(`/api/classroom/${classId}/feed`, { token: outsider.token });
        assert.equal(never.status, 403);
    });

    await t.test('an archived class takes no new work', async () => {
        const archived = await api.post(`/api/teacher/classes/${classId}/archive`, {}, { token: owner.token });
        assert.equal(archived.status, 200);

        const post = await api.post('/api/teacher/announcements', { classId, title: 'after', message: 'archived' }, { token: owner.token });
        assert.equal(post.status, 409);
        assert.equal(post.body.error.code, 'CLASS_NOT_ACTIVE');

        const restored = await api.post(`/api/teacher/classes/${classId}/archive`, { restore: true }, { token: owner.token });
        assert.equal(restored.status, 200);
        const again = await api.post('/api/teacher/announcements', { classId, title: 'after', message: 'restored' }, { token: owner.token });
        assert.equal(again.status, 200);
    });
});
