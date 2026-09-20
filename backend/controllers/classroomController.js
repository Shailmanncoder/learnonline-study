const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const db = require('../config/db');
const { generateJSON } = require('../services/ai');
const {
    validateWorksheet, normaliseAnswers, availability,
    studentWorksheetRow, studentQuestionView
} = require('../services/assessments');
const { grantOnce, alreadyGranted } = require('../services/rewards');

// ── Grading ────────────────────────────────────────────────────────
// Objective questions are matched exactly. Subjective answers used to
// score 70% for anything over 10 characters, which meant "asdf asdf asdf"
// passed — so they now go to the model against the expected answer, with a
// conservative keyword fallback if the model is unavailable.

function normalise(v) {
    return String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isObjective(type) {
    return type === 'mcq' || type === 'true_false' || type === 'fill_blank';
}

// Used only when the model can't be reached — overlap of meaningful words
// with the expected answer. Deliberately stingy: never awards full marks.
function heuristicScore(studentAns, expected, marks) {
    const ans = normalise(studentAns);
    if (ans.length < 3) return { awarded: 0, feedback: 'No answer given.' };
    const stop = new Set(['the','a','an','of','and','or','is','are','to','in','it','that','this','for','with','as','be','by','on']);
    const keyWords = normalise(expected).split(' ').filter(w => w.length > 3 && !stop.has(w));
    if (keyWords.length === 0) {
        return { awarded: Math.ceil(marks * 0.5), feedback: 'Awaiting teacher review.', needsReview: true };
    }
    const hits = keyWords.filter(w => ans.includes(w)).length;
    const ratio = hits / keyWords.length;
    const awarded = Math.min(Math.round(marks * ratio), Math.max(marks - 1, 0));
    return {
        awarded,
        feedback: `Matched ${hits} of ${keyWords.length} key points. Awaiting teacher review.`,
        needsReview: true
    };
}

async function gradeSubjective(items) {
    if (items.length === 0) return {};

    const prompt = `Grade these student answers. For each, award marks out of the stated maximum and give one short sentence of feedback addressed to the student.

Be a fair but rigorous marker:
- Award 0 if the answer is blank, gibberish, or unrelated to the question.
- Award partial marks for partially correct answers.
- Do not award marks for length alone.

${items.map(it => `---
ID: ${it.id}
Question: ${it.question}
Expected answer: ${it.expected || '(not supplied — judge on subject correctness)'}
Maximum marks: ${it.marks}
Student answer: ${it.answer || '(blank)'}`).join('\n')}

Respond ONLY with JSON: {"grades":[{"id":<id>,"awarded":<number>,"feedback":"<one sentence>"}]}`;

    const parsed = await generateJSON(
        prompt,
        'You are a strict, fair school examiner. Respond only with the requested JSON.',
        { task: 'reasoning' },
        null
    );

    const out = {};
    const grades = parsed && Array.isArray(parsed.grades) ? parsed.grades : [];
    grades.forEach(g => {
        const item = items.find(it => String(it.id) === String(g.id));
        if (!item) return;
        const awarded = Math.max(0, Math.min(Number(g.awarded) || 0, item.marks));
        out[String(g.id)] = { awarded, feedback: String(g.feedback || '').slice(0, 300), gradedBy: 'ai' };
    });
    return out;
}

// Merge the stored grading rows with the question text so the client can
// render a full result card without another round trip.
function buildStudentResults(questions, breakdown) {
    const rows = Array.isArray(breakdown) ? breakdown : [];
    return questions.map((q) => {
        const row = rows.find(b => String(b.id) === String(q.id)) || {};
        return {
            id: q.id,
            type: q.type,
            question: q.question,
            options: q.options || [],
            correct_answer: q.correct_answer,
            explanation: q.explanation || null,
            marks: q.marks || 1,
            answer: row.answer ?? null,
            awarded: row.awarded || 0,
            correct: row.correct === undefined ? null : row.correct,
            feedback: row.feedback || null,
            needsReview: !!row.needsReview
        };
    });
}

async function gradeAttempt(questions, answerMap, totalPossible) {
    const breakdown = [];
    const subjective = [];

    questions.forEach(q => {
        const marks = q.marks || 1;
        const studentAns = answerMap[q.id];
        if (isObjective(q.type)) {
            const correct = normalise(studentAns) === normalise(q.correct_answer);
            breakdown.push({
                id: q.id,
                type: q.type,
                marks,
                answer: studentAns ?? null,
                correct,
                awarded: correct ? marks : 0,
                gradedBy: 'auto'
            });
        } else {
            subjective.push({
                id: q.id,
                question: q.question,
                expected: q.correct_answer,
                marks,
                answer: studentAns
            });
            breakdown.push({
                id: q.id,
                type: q.type,
                marks,
                answer: studentAns ?? null,
                correct: null,
                awarded: 0,
                gradedBy: 'pending'
            });
        }
    });

    if (subjective.length > 0) {
        let graded = {};
        try {
            graded = await gradeSubjective(subjective);
        } catch (err) {
            console.warn('[GRADING] AI grading failed, using fallback:', err.message);
        }
        subjective.forEach(item => {
            const row = breakdown.find(b => String(b.id) === String(item.id));
            if (!row) return;
            const g = graded[String(item.id)];
            if (g) {
                row.awarded = g.awarded;
                row.feedback = g.feedback;
                row.gradedBy = 'ai';
            } else {
                const h = heuristicScore(item.answer, item.expected, item.marks);
                row.awarded = h.awarded;
                row.feedback = h.feedback;
                row.gradedBy = 'heuristic';
                row.needsReview = true;
            }
            // Treat a pass mark as "correct" for item-analysis purposes.
            row.correct = row.awarded >= item.marks * 0.5;
        });
    }

    const score = Math.min(
        breakdown.reduce((sum, b) => sum + (b.awarded || 0), 0),
        totalPossible
    );
    return { breakdown, score };
}

// --- Helper: Audit Logging ---
async function logAudit(actorId, action, entityType, entityId, metadata = {}) {
    try {
        await db.run(
            'INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata) VALUES (?, ?, ?, ?, ?)',
            [actorId, action, entityType, entityId, JSON.stringify(metadata)]
        );
    } catch (err) {
        console.warn('[AUDIT LOG ERROR]', err.message);
    }
}

// --- Authorization Middleware: Ensure user is enrolled or teacher of class ---
async function requireEnrolledOrTeacher(req, res, next) {
    try {
        const classId = req.params.id || req.body.classId || req.params.classId;
        if (!classId) return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Class ID required' } });

        // A deleted class is gone from every screen that reaches this point:
        // listing, details, feed, homework, worksheets and notes all share it.
        const classroom = await db.get('SELECT id, status FROM classrooms WHERE id = ?', [classId]);
        if (!classroom || classroom.status === 'deleted') {
            return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Classroom not found' } });
        }
        req.classroomStatus = classroom.status;

        // Check if student is actively enrolled
        const enrollment = await db.get(
            "SELECT * FROM class_enrollments WHERE class_id = ? AND student_id = ? AND status = 'active'",
            [classId, req.user.id]
        );
        if (enrollment) {
            req.isStudent = true;
            req.enrollment = enrollment;
            return next();
        }

        // Check if teacher — a pending or revoked membership is not one.
        const tc = await db.get(
            "SELECT * FROM teacher_classes WHERE class_id = ? AND teacher_id = ? AND (status IS NULL OR status = 'active')",
            [classId, req.user.id]
        );
        if (tc) {
            req.isTeacher = true;
            req.teacherClass = tc;
            return next();
        }

        return res.status(403).json({
            success: false,
            error: { code: 'NOT_AUTHORIZED', message: 'You are not enrolled in or assigned to this classroom.' }
        });
    } catch (err) {
        console.error('[CLASSROOM AUTH ERROR]', err.message);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
}

// ============================================================================
// 1. STUDENT JOINS CLASS WITH CLASS CODE (Instant — NO approval needed)
// ============================================================================
router.post('/join', auth, async (req, res) => {
    try {
        const { classCode } = req.body;
        if (!classCode) {
            return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Class code is required' } });
        }

        const code = String(classCode).trim().toUpperCase();
        const classroom = await db.get('SELECT * FROM classrooms WHERE UPPER(class_code) = ? AND status != "deleted"', [code]);
        if (!classroom) {
            return res.status(404).json({
                success: false,
                error: { code: 'INVALID_CLASS_CODE', message: 'The class code is invalid or the class does not exist.' }
            });
        }

        if (classroom.status === 'archived') {
            return res.status(400).json({
                success: false,
                error: { code: 'CLASS_ARCHIVED', message: 'This classroom has been archived and is not accepting new students.' }
            });
        }

        // Check if student is blocked
        const restriction = await db.get(
            "SELECT * FROM class_student_restrictions WHERE class_id = ? AND student_id = ? AND type = 'blocked'",
            [classroom.id, req.user.id]
        );
        if (restriction) {
            return res.status(403).json({
                success: false,
                error: { code: 'STUDENT_BLOCKED', message: 'Your access to this classroom has been restricted by the teacher.' }
            });
        }

        // Check existing enrollment
        const existing = await db.get(
            'SELECT * FROM class_enrollments WHERE class_id = ? AND student_id = ?',
            [classroom.id, req.user.id]
        );

        if (existing) {
            if (existing.status === 'active') {
                return res.status(400).json({
                    success: false,
                    error: { code: 'ALREADY_ENROLLED', message: 'You are already enrolled in this classroom.' }
                });
            } else if (existing.status === 'blocked') {
                return res.status(403).json({
                    success: false,
                    error: { code: 'STUDENT_BLOCKED', message: 'Your access to this classroom has been restricted.' }
                });
            } else {
                // Rejoining after removal
                await db.run(
                    "UPDATE class_enrollments SET status = 'active', joined_at = CURRENT_TIMESTAMP, removed_at = NULL, removed_by = NULL WHERE id = ?",
                    [existing.id]
                );
            }
        } else {
            // New instant enrollment
            await db.run(
                "INSERT INTO class_enrollments (class_id, student_id, status, joined_via) VALUES (?, ?, 'active', 'class_code')",
                [classroom.id, req.user.id]
            );
        }

        await logAudit(req.user.id, 'STUDENT_JOINED', 'class_enrollments', classroom.id, { classCode: code });

        // Fetch teachers info
        const teachers = await db.all(
            `SELECT u.username, tc.subject, tc.role FROM teacher_classes tc JOIN users u ON u.id = tc.teacher_id WHERE tc.class_id = ?`,
            [classroom.id]
        );

        res.json({
            success: true,
            message: `Successfully joined ${classroom.name}-${classroom.section}! 🎉`,
            classroom: { ...classroom, teachers }
        });
    } catch (err) {
        console.error('[STUDENT JOIN ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

// ============================================================================
// 2. GET ENROLLED CLASSES (STUDENT VIEW)
// ============================================================================
router.get('/my-classes', auth, async (req, res) => {
    try {
        const rows = await db.all(
            `SELECT c.*, ce.joined_at, ce.status as enrollment_status,
                (SELECT COUNT(*) FROM class_homework WHERE class_id = c.id) as homework_count,
                (SELECT COUNT(*) FROM class_worksheets WHERE class_id = c.id AND status = 'published') as worksheet_count,
                (SELECT COUNT(*) FROM class_announcements WHERE class_id = c.id) as announcement_count,
                (SELECT COUNT(*) FROM teacher_classes WHERE class_id = c.id) as teacher_count
             FROM classrooms c
             JOIN class_enrollments ce ON ce.class_id = c.id
             WHERE ce.student_id = ? AND ce.status = 'active' AND c.status != 'deleted'
             ORDER BY ce.joined_at DESC`,
            [req.user.id]
        );

        // Attach primary teachers
        for (const cls of rows) {
            const teachers = await db.all(
                `SELECT u.username, tc.subject, tc.role FROM teacher_classes tc JOIN users u ON u.id = tc.teacher_id WHERE tc.class_id = ?`,
                [cls.id]
            );
            cls.teachers = teachers;
        }

        res.json({ success: true, classes: rows });
    } catch (err) {
        console.error('[GET MY CLASSES ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

// ============================================================================
// 3. GET SINGLE CLASSROOM STREAM & DETAILS
// ============================================================================
router.get('/:id', auth, requireEnrolledOrTeacher, async (req, res) => {
    try {
        const classId = req.params.id;
        const classroom = await db.get('SELECT * FROM classrooms WHERE id = ?', [classId]);
        const teachers = await db.all(
            `SELECT u.id, u.username, u.profile_picture, tc.subject, tc.role
             FROM teacher_classes tc JOIN users u ON u.id = tc.teacher_id WHERE tc.class_id = ?`,
            [classId]
        );
        const classmates = await db.all(
            `SELECT u.id, u.username, u.profile_picture FROM class_enrollments ce JOIN users u ON u.id = ce.student_id WHERE ce.class_id = ? AND ce.status = 'active' ORDER BY u.username ASC`,
            [classId]
        );

        res.json({ success: true, classroom, teachers, classmates });
    } catch (err) {
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

// ============================================================================
// 4. GET CLASSROOM STREAM FEED
// ============================================================================
router.get('/:id/feed', auth, requireEnrolledOrTeacher, async (req, res) => {
    try {
        const classId = req.params.id;
        const studentId = req.user.id;

        const announcements = await db.all(
            `SELECT a.*, u.username as teacher_name, u.profile_picture as teacher_avatar
             FROM class_announcements a JOIN users u ON u.id = a.teacher_id WHERE a.class_id = ? ORDER BY a.created_at DESC LIMIT 30`,
            [classId]
        );

        const homework = await db.all(
            `SELECT h.*, u.username as teacher_name,
                (SELECT hs.status FROM homework_submissions hs WHERE hs.homework_id = h.id AND hs.student_id = ?) as my_submission_status,
                (SELECT hs.marks FROM homework_submissions hs WHERE hs.homework_id = h.id AND hs.student_id = ?) as my_marks
             FROM class_homework h JOIN users u ON u.id = h.teacher_id WHERE h.class_id = ? ORDER BY h.created_at DESC LIMIT 30`,
            [studentId, studentId, classId]
        );

        // w.* carries worksheet_data, which is the answer key. Sending it to
        // the feed put every answer one network-tab tab away from a student who
        // had not started yet, so the row is redacted before it leaves here.
        const worksheetRows = await db.all(
            `SELECT w.*, u.username as teacher_name,
                (SELECT MAX(wa.score) FROM worksheet_attempts wa WHERE wa.worksheet_id = w.id AND wa.student_id = ?) as my_best_score,
                (SELECT wa2.score FROM worksheet_attempts wa2 WHERE wa2.worksheet_id = w.id AND wa2.student_id = ? ORDER BY wa2.submitted_at DESC, wa2.id DESC LIMIT 1) as my_latest_score,
                (SELECT wa3.grading_status FROM worksheet_attempts wa3 WHERE wa3.worksheet_id = w.id AND wa3.student_id = ? ORDER BY wa3.submitted_at DESC, wa3.id DESC LIMIT 1) as my_latest_status
             FROM class_worksheets w JOIN users u ON u.id = w.teacher_id WHERE w.class_id = ? AND w.status = 'published' ORDER BY w.created_at DESC LIMIT 30`,
            [studentId, studentId, studentId, classId]
        );
        const worksheets = worksheetRows.map(row => (req.isTeacher ? row : studentWorksheetRow(row)));

        const notes = await db.all(
            `SELECT n.*, u.username as teacher_name FROM class_notes n JOIN users u ON u.id = n.teacher_id WHERE n.class_id = ? AND n.status = 'published' ORDER BY n.created_at DESC LIMIT 30`,
            [classId]
        );

        res.json({
            success: true,
            stream: {
                announcements,
                homework,
                worksheets,
                notes
            }
        });
    } catch (err) {
        console.error('[GET CLASS FEED ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

// ============================================================================
// 5. GET CLASS HOMEWORK
// ============================================================================
router.get('/:id/homework', auth, requireEnrolledOrTeacher, async (req, res) => {
    try {
        const classId = req.params.id;
        const studentId = req.user.id;
        const rows = await db.all(
            `SELECT h.*, u.username as teacher_name,
                hs.status as submission_status, hs.marks, hs.feedback, hs.submitted_at, hs.content as submission_content
             FROM class_homework h
             JOIN users u ON u.id = h.teacher_id
             LEFT JOIN homework_submissions hs ON hs.homework_id = h.id AND hs.student_id = ?
             WHERE h.class_id = ?
             ORDER BY h.created_at DESC`,
            [studentId, classId]
        );
        res.json({ success: true, homework: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

// ============================================================================
// 6. SUBMIT HOMEWORK
// ============================================================================
router.post('/homework/:id/submit', auth, async (req, res) => {
    try {
        const homeworkId = req.params.id;
        const { content, attachments } = req.body;
        if (!content && (!attachments || !attachments.length)) {
            return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Submission content or attachment is required' } });
        }

        const hw = await db.get(
            `SELECT h.*, c.status AS class_status FROM class_homework h
             JOIN classrooms c ON c.id = h.class_id WHERE h.id = ?`,
            [homeworkId]
        );
        if (!hw || hw.class_status === 'deleted') {
            return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Homework not found' } });
        }
        if (hw.class_status !== 'active') {
            return res.status(409).json({ success: false, error: { code: 'CLASS_NOT_ACTIVE', message: `This classroom is ${hw.class_status} and is no longer accepting work.` } });
        }

        // Ensure student is actively enrolled — removed and blocked students
        // keep their submitted history but cannot add to it.
        const enrollment = await db.get(
            "SELECT * FROM class_enrollments WHERE class_id = ? AND student_id = ? AND status = 'active'",
            [hw.class_id, req.user.id]
        );
        if (!enrollment) {
            return res.status(403).json({ success: false, error: { code: 'NOT_AUTHORIZED', message: 'You are not enrolled in this class' } });
        }

        const { revision, xpEarned } = await db.transaction(async () => {
            const existingSub = await db.get(
                'SELECT * FROM homework_submissions WHERE homework_id = ? AND student_id = ?',
                [homeworkId, req.user.id]
            );

            let submissionId;
            let nextRevision = 1;
            if (existingSub) {
                nextRevision = Number(existingSub.revision || 1) + 1;
                submissionId = existingSub.id;
                // The previous version keeps the marks and feedback it was
                // given. The new one starts ungraded: showing the old grade
                // against a new answer told the student their rewritten work
                // had already been marked.
                await db.run(
                    `INSERT INTO homework_submission_revisions
                       (submission_id, homework_id, student_id, revision, content, attachments, status, marks, feedback, graded_by, graded_at, submitted_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [submissionId, homeworkId, req.user.id, existingSub.revision || 1,
                     existingSub.content, existingSub.attachments, existingSub.status,
                     existingSub.marks, existingSub.feedback, existingSub.graded_by,
                     existingSub.graded_at, existingSub.submitted_at]
                );
                await db.run(
                    `UPDATE homework_submissions
                        SET content = ?, attachments = ?, status = 'submitted', submitted_at = CURRENT_TIMESTAMP,
                            revision = ?, marks = NULL, feedback = NULL, graded_at = NULL, graded_by = NULL, graded_revision = NULL
                      WHERE id = ?`,
                    [content || '', attachments ? JSON.stringify(attachments) : null, nextRevision, submissionId]
                );
            } else {
                // UNIQUE(homework_id, student_id) turns a double-click into one row.
                const inserted = await db.run(
                    "INSERT INTO homework_submissions (homework_id, student_id, content, attachments, status, revision) VALUES (?, ?, ?, ?, 'submitted', 1)",
                    [homeworkId, req.user.id, content || '', attachments ? JSON.stringify(attachments) : null]
                );
                submissionId = inserted.lastID;
            }

            // Turning the work in is what earns the XP, and it is earned once
            // for this homework however many times the answer is revised.
            const grant = await grantOnce(req.user.id, `homework:${homeworkId}`, 30, `Submitted: ${hw.title}`);
            await db.run(
                'INSERT INTO activity (user_id, tool_used, time_spent, xp_earned, estimated_minutes) VALUES (?, ?, 0, ?, 10)',
                [req.user.id, `Submitted: ${hw.title}`, grant.xp]
            );
            return { revision: nextRevision, xpEarned: grant.xp };
        });

        await logAudit(req.user.id, 'HOMEWORK_SUBMITTED', 'homework_submissions', homeworkId, { title: hw.title, revision });
        res.json({
            success: true,
            revision,
            xpEarned,
            status: 'submitted',
            message: revision > 1
                ? `Version ${revision} submitted. Your earlier version and its feedback are kept, and this one is waiting to be marked.`
                : `Homework submitted successfully!${xpEarned ? ` +${xpEarned} XP earned! 🚀` : ''}`
        });
    } catch (err) {
        console.error('[SUBMIT HOMEWORK ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

// ============================================================================
// 7. GET CLASS WORKSHEETS
// ============================================================================
router.get('/:id/worksheets', auth, requireEnrolledOrTeacher, async (req, res) => {
    try {
        const classId = req.params.id;
        const studentId = req.user.id;
        // Best and latest are both reported, and named, so the student's screen
        // and the teacher's report cannot quietly disagree about which one the
        // single number on each was showing.
        const rows = await db.all(
            `SELECT w.*, u.username as teacher_name,
                (SELECT MAX(score) FROM worksheet_attempts WHERE worksheet_id = w.id AND student_id = ?) as my_best_score,
                (SELECT score FROM worksheet_attempts WHERE worksheet_id = w.id AND student_id = ? ORDER BY submitted_at DESC, id DESC LIMIT 1) as my_latest_score,
                (SELECT grading_status FROM worksheet_attempts WHERE worksheet_id = w.id AND student_id = ? ORDER BY submitted_at DESC, id DESC LIMIT 1) as my_latest_status,
                (SELECT COUNT(*) FROM worksheet_attempts WHERE worksheet_id = w.id AND student_id = ?) as my_attempts
             FROM class_worksheets w
             JOIN users u ON u.id = w.teacher_id
             WHERE w.class_id = ? AND w.status = 'published'
             ORDER BY w.created_at DESC`,
            [studentId, studentId, studentId, studentId, classId]
        );
        res.json({ success: true, worksheets: rows.map(row => (req.isTeacher ? row : studentWorksheetRow(row))) });
    } catch (err) {
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

// ============================================================================
// 8. SUBMIT & AUTO-GRADE WORKSHEET
// ============================================================================
// ── GET /api/classroom/worksheets/:id/start ────────────────────────
// The questions a student needs in order to attempt a worksheet, and nothing
// else. The player used to read these out of the feed payload, which meant the
// answer key had to be sent to render the question — it does not.
router.get('/worksheets/:id/start', auth, async (req, res) => {
    try {
        const ws = await db.get(
            `SELECT w.*, c.status AS class_status FROM class_worksheets w
             JOIN classrooms c ON c.id = w.class_id WHERE w.id = ?`,
            [req.params.id]
        );
        if (!ws || ws.class_status === 'deleted') {
            return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Worksheet not found' } });
        }

        const enrolled = await db.get(
            "SELECT 1 AS ok FROM class_enrollments WHERE class_id = ? AND student_id = ? AND status = 'active'",
            [ws.class_id, req.user.id]
        );
        const teaching = await db.get(
            "SELECT 1 AS ok FROM teacher_classes WHERE class_id = ? AND teacher_id = ? AND (status IS NULL OR status = 'active')",
            [ws.class_id, req.user.id]
        );
        if (!enrolled && !teaching) {
            return res.status(403).json({ success: false, error: { code: 'NOT_ENROLLED', message: 'You are not enrolled in this class.' } });
        }

        const { questions, totalMarks } = validateWorksheet(ws.worksheet_data);
        const open = availability(ws);
        const attempts = await db.get(
            'SELECT COUNT(*) AS n FROM worksheet_attempts WHERE worksheet_id = ? AND student_id = ?',
            [req.params.id, req.user.id]
        );
        const used = Number(attempts.n || 0);
        const maxAttempts = Number(ws.max_attempts) || 0;

        res.json({
            success: true,
            worksheet: studentWorksheetRow(ws),
            questions: studentQuestionView(questions),
            totalMarks: totalMarks || ws.total_marks || 0,
            durationMinutes: Number(ws.duration) || null,
            attemptsUsed: used,
            attemptsAllowed: maxAttempts || null,
            canSubmit: ws.class_status === 'active' && open.open && !!enrolled && (!maxAttempts || used < maxAttempts),
            closedReason: open.open ? null : { code: open.code, message: open.message }
        });
    } catch (err) {
        console.error('[START WORKSHEET ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Could not open this worksheet' } });
    }
});

// This route used to check nothing at all: any signed-in account could post to
// any worksheet id, be graded, and collect XP — repeatedly, since every call
// inserted a fresh attempt. It now establishes, in order, that the caller may
// submit, that the worksheet is open to them, and that this is not a retry of
// something already recorded.
router.post('/worksheets/:id/submit', auth, async (req, res) => {
    try {
        const wsId = req.params.id;
        const { answers, submissionKey } = req.body;
        if (!Array.isArray(answers)) {
            return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Answers array is required' } });
        }
        const key = submissionKey === undefined || submissionKey === null
            ? null
            : String(submissionKey).trim().slice(0, 80);
        if (key !== null && !/^[A-Za-z0-9_:-]{8,80}$/.test(key)) {
            return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'submissionKey must be 8-80 characters of A-Z, a-z, 0-9, dash, underscore or colon.' } });
        }

        const ws = await db.get(
            `SELECT w.*, c.status AS class_status FROM class_worksheets w
             JOIN classrooms c ON c.id = w.class_id WHERE w.id = ?`,
            [wsId]
        );
        if (!ws || ws.class_status === 'deleted') {
            return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Worksheet not found' } });
        }
        if (ws.class_status !== 'active') {
            return res.status(409).json({ success: false, error: { code: 'CLASS_NOT_ACTIVE', message: `This classroom is ${ws.class_status} and is no longer accepting work.` } });
        }

        // Removed and blocked students keep their history but cannot add to it.
        const enrollment = await db.get(
            "SELECT status FROM class_enrollments WHERE class_id = ? AND student_id = ? AND status = 'active'",
            [ws.class_id, req.user.id]
        );
        if (!enrollment) {
            return res.status(403).json({ success: false, error: { code: 'NOT_ENROLLED', message: 'You are not enrolled in this class.' } });
        }

        const open = availability(ws);
        if (!open.open) {
            return res.status(409).json({ success: false, error: { code: open.code, message: open.message } });
        }

        const { ok, errors, questions, totalMarks } = validateWorksheet(ws.worksheet_data);
        if (!ok && questions.length === 0) {
            return res.status(409).json({ success: false, error: { code: 'WORKSHEET_UNUSABLE', message: 'This worksheet has no usable questions. Please tell your teacher.', details: errors.slice(0, 5) } });
        }
        // The total comes from the questions, not from a column that may have
        // been written before the questions were edited.
        const totalPossible = totalMarks || ws.total_marks || 0;

        const { answerMap, unknown } = normaliseAnswers(answers, questions);
        if (unknown.length) {
            return res.status(400).json({ success: false, error: { code: 'UNKNOWN_QUESTIONS', message: `These answers do not match any question on this worksheet: ${unknown.slice(0, 5).join(', ')}` } });
        }

        // A retry of a request already recorded returns what was recorded,
        // rather than grading and paying for it a second time.
        if (key) {
            const existing = await db.get(
                'SELECT * FROM worksheet_attempts WHERE worksheet_id = ? AND student_id = ? AND submission_key = ?',
                [wsId, req.user.id, key]
            );
            if (existing) return res.json(await attemptResponse(existing, questions, req.user.id, true));
        }

        const priorAttempts = await db.get(
            'SELECT COUNT(*) AS n FROM worksheet_attempts WHERE worksheet_id = ? AND student_id = ?',
            [wsId, req.user.id]
        );
        const attemptNo = Number(priorAttempts.n || 0) + 1;
        const maxAttempts = Number(ws.max_attempts) || 0;
        if (maxAttempts > 0 && attemptNo > maxAttempts) {
            return res.status(409).json({ success: false, error: { code: 'NO_ATTEMPTS_LEFT', message: `You have used all ${maxAttempts} attempt${maxAttempts === 1 ? '' : 's'} for this worksheet.` } });
        }

        // Grading can call a model, so it happens before the transaction opens:
        // holding a MySQL connection (or the SQLite queue) for the length of a
        // provider round trip would stall every other request.
        const { breakdown, score } = await gradeAttempt(questions, answerMap, totalPossible);

        // A grade the model did not produce, or produced with a fallback, is
        // provisional: it is shown, but it is not final and it earns nothing
        // until a teacher confirms it.
        const needsReview = breakdown.some(b => b.needsReview);
        const gradingStatus = needsReview ? 'provisional' : 'graded';
        const gradedKind = breakdown.some(b => b.gradedBy === 'heuristic') ? 'heuristic'
            : breakdown.some(b => b.gradedBy === 'ai') ? 'ai' : 'auto';

        const result = await db.transaction(async () => {
            let attemptId;
            try {
                const inserted = await db.run(
                    `INSERT INTO worksheet_attempts
                       (worksheet_id, student_id, answers, score, total_marks, status, breakdown, submission_key, grading_status, graded_kind, attempt_no)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [wsId, req.user.id, JSON.stringify(answers), score, totalPossible,
                     needsReview ? 'awaiting_review' : 'completed', JSON.stringify(breakdown),
                     key, gradingStatus, gradedKind, attemptNo]
                );
                attemptId = inserted.lastID;
            } catch (err) {
                // Two requests carrying the same key raced; the other one won.
                if (!/unique|duplicate/i.test(err.message)) throw err;
                return { raced: true };
            }

            let xpEarned = 0;
            if (!needsReview) {
                const grant = await grantOnce(
                    req.user.id, `worksheet:${wsId}`,
                    Math.round(score * 2.5) + 20,
                    `Worksheet: ${ws.title}`
                );
                xpEarned = grant.xp;
            }
            // The worksheet's configured duration is how long the teacher
            // expected it to take, not time anyone was measured working, so it
            // is recorded as an estimate and adds nothing to measured totals.
            await db.run(
                'INSERT INTO activity (user_id, tool_used, time_spent, xp_earned, estimated_minutes) VALUES (?, ?, 0, ?, ?)',
                [req.user.id, `Worksheet: ${ws.title}`, xpEarned, Number(ws.duration) || 0]
            );
            return { attemptId, xpEarned };
        });

        if (result.raced) {
            const existing = await db.get(
                'SELECT * FROM worksheet_attempts WHERE worksheet_id = ? AND student_id = ? AND submission_key = ?',
                [wsId, req.user.id, key]
            );
            if (existing) return res.json(await attemptResponse(existing, questions, req.user.id, true));
        }

        await logAudit(req.user.id, 'WORKSHEET_SUBMITTED', 'worksheet_attempts', wsId, { score, totalPossible, attemptNo, gradingStatus });

        res.json({
            success: true,
            attemptId: result.attemptId,
            attemptNo,
            score,
            totalPossible,
            xpEarned: result.xpEarned,
            gradingStatus,
            gradedKind,
            pendingReview: needsReview,
            results: buildStudentResults(questions, breakdown),
            message: needsReview
                ? `Submitted. Provisional score ${score}/${totalPossible} — your teacher will confirm the written answers.`
                : `Worksheet completed! Scored ${score}/${totalPossible}${result.xpEarned ? ` (${result.xpEarned} XP earned!)` : ''} 🌟`
        });
    } catch (err) {
        console.error('[SUBMIT WORKSHEET ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Could not record this submission. Your answers were not saved — please retry.' } });
    }
});

// The stored form of an attempt, shaped like a fresh submission so a retry and
// a first send are indistinguishable to the caller.
async function attemptResponse(attempt, questions, userId, replayed = false) {
    let breakdown = [];
    try { breakdown = JSON.parse(attempt.breakdown || '[]'); } catch { breakdown = []; }
    const granted = await alreadyGranted(userId, `worksheet:${attempt.worksheet_id}`);
    return {
        success: true,
        replayed,
        attemptId: attempt.id,
        attemptNo: attempt.attempt_no || 1,
        score: attempt.score,
        totalPossible: attempt.total_marks,
        xpEarned: granted.xp,
        gradingStatus: attempt.grading_status || 'graded',
        gradedKind: attempt.graded_kind || null,
        pendingReview: (attempt.grading_status || 'graded') === 'provisional',
        results: buildStudentResults(questions, breakdown),
        message: 'This submission was already recorded.'
    };
}

// ============================================================================
// 9. GET CLASS NOTES
// ============================================================================
router.get('/:id/notes', auth, requireEnrolledOrTeacher, async (req, res) => {
    try {
        const classId = req.params.id;
        const rows = await db.all(
            `SELECT n.*, u.username as teacher_name FROM class_notes n JOIN users u ON u.id = n.teacher_id WHERE n.class_id = ? AND n.status = 'published' ORDER BY n.created_at DESC`,
            [classId]
        );
        res.json({ success: true, notes: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

// ============================================================================
// 10. NOTIFICATIONS
// ============================================================================
// ── GET /api/classroom/worksheets/:id/my-result ────────────────────
// Lets a student reopen a graded attempt instead of only seeing the
// result once, in the moment they submit.
router.get('/worksheets/:id/my-result', auth, async (req, res) => {
    try {
        const wsId = req.params.id;
        const ws = await db.get('SELECT * FROM class_worksheets WHERE id = ?', [wsId]);
        if (!ws) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Worksheet not found' } });

        const enrolled = await db.get(
            "SELECT 1 AS ok FROM class_enrollments WHERE class_id = ? AND student_id = ? AND status = 'active'",
            [ws.class_id, req.user.id]
        );
        if (!enrolled) return res.status(403).json({ success: false, error: { code: 'NOT_AUTHORIZED', message: 'Not enrolled in this class' } });

        // Which attempt is being shown is now stated rather than implied. This
        // returned the best-scoring attempt while the teacher's report listed
        // the most recent one, so the same worksheet could show two different
        // scores with nothing on either screen saying why.
        const wanted = req.query.attempt === 'best' ? 'best' : 'latest';
        const order = wanted === 'best'
            ? 'score DESC, submitted_at DESC, id DESC'
            : 'submitted_at DESC, id DESC';
        const attempt = await db.get(
            `SELECT * FROM worksheet_attempts WHERE worksheet_id = ? AND student_id = ? ORDER BY ${order} LIMIT 1`,
            [wsId, req.user.id]
        );
        if (!attempt) return res.status(404).json({ success: false, error: { code: 'NO_ATTEMPT', message: 'You have not attempted this worksheet yet' } });

        const totals = await db.get(
            'SELECT COUNT(*) AS attempts, MAX(score) AS best FROM worksheet_attempts WHERE worksheet_id = ? AND student_id = ?',
            [wsId, req.user.id]
        );

        let questions = [];
        try { questions = (JSON.parse(ws.worksheet_data) || {}).questions || []; } catch (e) { questions = []; }

        let breakdown = [];
        try { breakdown = JSON.parse(attempt.breakdown || '[]'); } catch (e) { breakdown = []; }

        // Attempts predating the breakdown column still have raw answers.
        if (breakdown.length === 0) {
            try {
                const raw = JSON.parse(attempt.answers || '[]');
                breakdown = raw.map(a => ({ id: a.id, answer: a.answer }));
            } catch (e) { breakdown = []; }
        }

        res.json({
            success: true,
            title: ws.title,
            score: attempt.score,
            totalPossible: attempt.total_marks,
            submitted_at: attempt.submitted_at,
            showing: wanted,
            attemptNo: attempt.attempt_no || null,
            attemptsMade: Number(totals.attempts || 1),
            bestScore: totals.best,
            gradingStatus: attempt.grading_status || 'graded',
            pendingReview: (attempt.grading_status || 'graded') === 'provisional',
            results: buildStudentResults(questions, breakdown)
        });
    } catch (err) {
        console.error('[MY RESULT ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

router.get('/notifications/list', auth, async (req, res) => {
    try {
        const rows = await db.all(
            'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 30',
            [req.user.id]
        );
        const unreadCount = rows.filter(n => !n.is_read).length;
        res.json({ success: true, notifications: rows, unreadCount });
    } catch (err) {
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

router.post('/notifications/read', auth, async (req, res) => {
    try {
        await db.run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [req.user.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

module.exports = router;