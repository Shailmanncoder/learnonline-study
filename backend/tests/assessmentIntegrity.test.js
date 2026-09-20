// Answer keys, submission rules, and what happens when the same submission
// arrives twice. Every case is an HTTP request, because that is what a browser
// can actually send.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers/server');

const WORKSHEET = {
    questions: [
        { id: 'q1', type: 'mcq', question: 'Capital of France?', options: ['Paris', 'Rome', 'Madrid'], correct_answer: 'Paris', explanation: 'It is Paris.', marks: 2 },
        { id: 'q2', type: 'true_false', question: 'Water boils at 100C at sea level.', correct_answer: 'True', marks: 1 },
        { id: 'q3', type: 'mcq', question: '2 + 2?', options: ['3', '4'], correct_answer: '4', marks: 3 }
    ]
};

test('assessments keep their answers, and submissions are authorised and idempotent', { timeout: 45000 }, async (t) => {
    const api = await startServer(t);
    const teacher = await api.account('assess-teacher', 'teacher');
    const student = await api.account('assess-student');
    const outsider = await api.account('assess-outsider');

    const cls = (await api.post('/api/teacher/classes', { name: 'Geo', section: 'B' }, { token: teacher.token })).body.classroom;
    await api.post('/api/classroom/join', { classCode: cls.class_code }, { token: student.token });

    const published = await api.post('/api/teacher/worksheets/publish', {
        classId: cls.id, title: 'Quiz 1', subject: 'General',
        worksheet_data: WORKSHEET, total_marks: 999, duration: 15
    }, { token: teacher.token });
    assert.equal(published.status, 200);
    const wsId = published.body.worksheet.id;

    await t.test('the total comes from the questions, not from the request', async () => {
        assert.equal(published.body.worksheet.total_marks, 6, '2 + 1 + 3, not the 999 that was posted');
    });

    await t.test('a malformed worksheet is refused with reasons', async () => {
        const bad = await api.post('/api/teacher/worksheets/publish', {
            classId: cls.id, title: 'Broken', worksheet_data: {
                questions: [
                    { id: 'x', type: 'mcq', question: 'Pick', options: ['a'], correct_answer: 'zzz', marks: 1 },
                    { id: 'x', type: 'mcq', question: 'Dup id', options: ['a', 'b'], correct_answer: 'a', marks: 1 },
                    { id: 'y', type: 'telepathy', question: 'Guess', marks: -4 }
                ]
            }
        }, { token: teacher.token });
        assert.equal(bad.status, 400);
        assert.equal(bad.body.error.code, 'INVALID_WORKSHEET');
        assert.ok(bad.body.error.details.length >= 3, 'each problem should be named');

        const empty = await api.post('/api/teacher/worksheets/publish', {
            classId: cls.id, title: 'Empty', worksheet_data: { questions: [] }
        }, { token: teacher.token });
        assert.equal(empty.status, 400);
    });

    await t.test('no student response carries the answer key', async () => {
        const feed = await api.get(`/api/classroom/${cls.id}/feed`, { token: student.token });
        assert.equal(feed.status, 200);
        const list = await api.get(`/api/classroom/${cls.id}/worksheets`, { token: student.token });
        assert.equal(list.status, 200);
        const start = await api.get(`/api/classroom/worksheets/${wsId}/start`, { token: student.token });
        assert.equal(start.status, 200);

        for (const [name, payload] of [['feed', feed.body], ['list', list.body], ['start', start.body]]) {
            const text = JSON.stringify(payload);
            assert.ok(!text.includes('worksheet_data'), `${name} still carries worksheet_data`);
            assert.ok(!text.includes('correct_answer'), `${name} still carries correct_answer`);
            assert.ok(!text.includes('It is Paris'), `${name} still carries the explanation`);
        }
        // It still carries what a student needs to answer.
        assert.equal(start.body.questions.length, 3);
        assert.deepEqual(start.body.questions[0].options, ['Paris', 'Rome', 'Madrid']);
        assert.equal(start.body.totalMarks, 6);
    });

    await t.test('an outsider cannot open or submit the worksheet', async () => {
        const start = await api.get(`/api/classroom/worksheets/${wsId}/start`, { token: outsider.token });
        assert.equal(start.status, 403);
        const submit = await api.post(`/api/classroom/worksheets/${wsId}/submit`, {
            answers: [{ id: 'q1', answer: 'Paris' }]
        }, { token: outsider.token });
        assert.equal(submit.status, 403, 'submitting used to need no enrolment at all');
        assert.equal(submit.body.error.code, 'NOT_ENROLLED');
    });

    await t.test('grading uses the stored key, not anything the browser sends', async () => {
        const res = await api.post(`/api/classroom/worksheets/${wsId}/submit`, {
            submissionKey: 'attempt-0000001',
            // A crafted payload claiming its own marks and correctness.
            answers: [
                { id: 'q1', answer: 'Rome', marks: 100, correct: true, awarded: 100 },
                { id: 'q2', answer: 'True' },
                { id: 'q3', answer: '4' }
            ]
        }, { token: student.token });
        assert.equal(res.status, 200);
        assert.equal(res.body.score, 4, 'q1 wrong (2) + q2 right (1) + q3 right (3) = 4');
        assert.equal(res.body.totalPossible, 6);
    });

    await t.test('answers for questions that are not on the worksheet are refused', async () => {
        const res = await api.post(`/api/classroom/worksheets/${wsId}/submit`, {
            submissionKey: 'attempt-0000002',
            answers: [{ id: 'q1', answer: 'Paris' }, { id: 'ghost', answer: 'x' }]
        }, { token: student.token });
        assert.equal(res.status, 400);
        assert.equal(res.body.error.code, 'UNKNOWN_QUESTIONS');
    });

    await t.test('a retried submission returns the first result and pays once', async () => {
        const before = await api.get('/api/user/profile', { token: student.token });
        const xpBefore = before.body.xp ?? before.body.user?.xp;

        const again = await api.post(`/api/classroom/worksheets/${wsId}/submit`, {
            submissionKey: 'attempt-0000001',
            answers: [{ id: 'q1', answer: 'Paris' }, { id: 'q2', answer: 'True' }, { id: 'q3', answer: '4' }]
        }, { token: student.token });
        assert.equal(again.status, 200);
        assert.equal(again.body.replayed, true);
        assert.equal(again.body.score, 4, 'the retry must not be re-graded against new answers');

        const after = await api.get('/api/user/profile', { token: student.token });
        const xpAfter = after.body.xp ?? after.body.user?.xp;
        assert.equal(xpAfter, xpBefore, 'a retry must not pay again');
    });

    await t.test('two concurrent submissions of the same key produce one attempt', async () => {
        const send = () => api.post(`/api/classroom/worksheets/${wsId}/submit`, {
            submissionKey: 'race-000000001',
            answers: [{ id: 'q1', answer: 'Paris' }, { id: 'q2', answer: 'True' }, { id: 'q3', answer: '4' }]
        }, { token: student.token });
        const [a, b] = await Promise.all([send(), send()]);
        assert.equal(a.status, 200);
        assert.equal(b.status, 200);
        assert.equal(a.body.attemptId ?? a.body.score, b.body.attemptId ?? b.body.score);

        const result = await api.get(`/api/classroom/worksheets/${wsId}/my-result`, { token: student.token });
        assert.equal(result.status, 200);
        // attempt-0000001 and race-000000001: two deliberate attempts, not four.
        assert.equal(result.body.attemptsMade, 2);
    });

    await t.test('a second XP payment is never made for the same worksheet', async () => {
        const profile = await api.get('/api/user/profile', { token: student.token });
        const xp = profile.body.xp ?? profile.body.user?.xp;
        const fresh = await api.post(`/api/classroom/worksheets/${wsId}/submit`, {
            submissionKey: 'attempt-0000003',
            answers: [{ id: 'q1', answer: 'Paris' }, { id: 'q2', answer: 'True' }, { id: 'q3', answer: '4' }]
        }, { token: student.token });
        assert.equal(fresh.status, 200);
        assert.equal(fresh.body.xpEarned, 0, 'a new attempt is allowed; a second payment is not');
        const after = await api.get('/api/user/profile', { token: student.token });
        assert.equal(after.body.xp ?? after.body.user?.xp, xp);
    });

    await t.test('the student result names which attempt it is showing', async () => {
        const latest = await api.get(`/api/classroom/worksheets/${wsId}/my-result`, { token: student.token });
        assert.equal(latest.body.showing, 'latest');
        const best = await api.get(`/api/classroom/worksheets/${wsId}/my-result?attempt=best`, { token: student.token });
        assert.equal(best.body.showing, 'best');
        assert.ok(best.body.score >= latest.body.score);
    });

    await t.test('the student\'s screen and the teacher\'s report describe the same attempt', async () => {
        const mine = await api.get(`/api/classroom/worksheets/${wsId}/my-result`, { token: student.token });
        const report = await api.get(`/api/teacher/worksheets/${wsId}/analysis`, { token: teacher.token });
        assert.equal(report.status, 200);

        // Both sides name which attempt they are showing, and both mean the
        // latest one — this used to be "best" on one screen and "most recent"
        // on the other, with nothing saying so.
        assert.equal(mine.body.showing, 'latest');
        assert.match(report.body.summary.showing, /latest/);

        const row = report.body.students.find(r => r.id === student.id);
        assert.ok(row, 'the student should appear in the report');
        assert.equal(row.score, mine.body.score, 'the two screens must not disagree about the score');
        assert.equal(row.total, mine.body.totalPossible);

        // And the denominator is stated rather than implied.
        assert.equal(report.body.summary.classSize, 1);
        assert.equal(report.body.summary.submissions, 1);
    });

    await t.test('a removed student keeps their history but cannot submit again', async () => {
        await api.post(`/api/teacher/classes/${cls.id}/students/remove`, { studentId: student.id }, { token: teacher.token });
        const res = await api.post(`/api/classroom/worksheets/${wsId}/submit`, {
            submissionKey: 'after-removal-1',
            answers: [{ id: 'q1', answer: 'Paris' }]
        }, { token: student.token });
        assert.equal(res.status, 403);

        const attempts = await api.get(`/api/teacher/worksheets/${wsId}/attempts`, { token: teacher.token });
        assert.equal(attempts.status, 200);
        assert.ok(attempts.body.attempts.length >= 2, 'their earlier work is still there for the teacher');
    });
});

test('practice quizzes are graded against the stored key', { timeout: 30000 }, async (t) => {
    const api = await startServer(t);
    const student = await api.account('quiz-student');
    const db = require('../config/db');
    await db.ready();

    // No provider is configured in tests, so the quiz is seeded directly — the
    // point under test is submission, not generation.
    const quizId = 'test-quiz-0001';
    await db.run(
        'INSERT INTO study_quizzes (id, user_id, topic, questions, total) VALUES (?, ?, ?, ?, ?)',
        [quizId, student.id, 'Space', JSON.stringify([
            { question: 'Largest planet?', options: ['Earth', 'Jupiter'], correctIndex: 1, explanation: 'Jupiter.' },
            { question: 'Our star?', options: ['Sun', 'Sirius'], correctIndex: 0, explanation: 'The Sun.' }
        ]), 2]
    );

    await t.test('a browser-supplied answer key is ignored', async () => {
        const res = await api.post('/api/study/quiz/submit', {
            quizId,
            answers: [0, 1],
            // What the old endpoint would have graded against.
            questions: [
                { question: 'x', options: ['a'], correctIndex: 0 },
                { question: 'y', options: ['a'], correctIndex: 1 }
            ],
            score: 2, total: 2
        }, { token: student.token });
        assert.equal(res.status, 200);
        assert.equal(res.body.score, 0, 'both answers are wrong against the stored key');
        assert.equal(res.body.total, 2);
    });

    await t.test('another account cannot submit against this quiz', async () => {
        const other = await api.account('quiz-thief');
        const res = await api.post('/api/study/quiz/submit', { quizId, answers: [1, 0] }, { token: other.token });
        assert.equal(res.status, 404);
    });

    await t.test('resubmitting the same quiz does not pay twice', async () => {
        const first = await api.post('/api/study/quiz/submit', { quizId, answers: [1, 0] }, { token: student.token });
        assert.equal(first.body.score, 2);
        const second = await api.post('/api/study/quiz/submit', { quizId, answers: [1, 0] }, { token: student.token });
        assert.equal(second.body.xpEarned, 0);
    });
});
