const express = require('express');
const crypto = require('node:crypto');
const router = express.Router();
const auth = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');
const { joinAttemptsExhausted, recordJoinAttempt } = require('../services/joinLimiter');
const { validateWorksheet, parseMark } = require('../services/assessments');
const { grantOnce } = require('../services/rewards');
const { providerOrder, geminiKey, geminiModel } = require('../services/ai');
const db = require('../config/db');

// --- Multi-Provider AI Helper for Worksheet Generation ---
async function generateAIJSON(prompt, systemInstruction = 'You are a pedagogical assistant. Respond only with JSON.') {
    // Provider order comes from the shared service, so AI_PROVIDER applies here
    // too. This used to hard-code Groq first, which meant a deploy preferring
    // Gemini still generated worksheets on Groq.
    const tryGroq = async () => {
        const groqKey = process.env.GROQ_API_KEY;
        if (!groqKey || groqKey === 'your_groq_api_key_here' || groqKey.length <= 5) return null;
        try {
            const Groq = require('groq-sdk');
            const groq = new Groq({ apiKey: groqKey });
            const completion = await groq.chat.completions.create({
                model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
                messages: [
                    { role: 'system', content: systemInstruction },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.3,
                response_format: { type: 'json_object' }
            });
            return completion.choices[0]?.message?.content || null;
        } catch (e) {
            console.warn('[GROQ WORKSHEET GEN WARNING]', e.message);
            return null;
        }
    };

    const tryGemini = async () => {
        const key = geminiKey();
        if (!key) return null;
        try {
            const { GoogleGenerativeAI } = require('@google/generative-ai');
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({ model: geminiModel() });
            const result = await model.generateContent(`${systemInstruction}\n\n${prompt}`);
            return result.response.text() || null;
        } catch (e) {
            console.warn('[GEMINI WORKSHEET GEN WARNING]', e.message);
            return null;
        }
    };

    for (const provider of providerOrder()) {
        const out = provider === 'gemini' ? await tryGemini() : await tryGroq();
        if (out) return out;
    }

    return '';
}

// Every route in this file is a teacher-portal action, so the gate goes here
// rather than being repeated (and eventually forgotten) on each one. The role
// comes from the account row, so opening the teacher portal in the browser or
// replaying a token issued before a role change grants nothing.
router.use(auth, requireRole('teacher', 'developer'));

// --- Helper: Unique Class Code Generator ---
// Math.random() is predictable enough that, given a few codes, an attacker can
// derive the generator state and guess the rest. Class codes are the only
// thing standing between an outsider and a class roster, so they come from the
// CSPRNG. The alphabet omits 0/O/1/I so a code read off a whiteboard is
// unambiguous.
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function generateClassCode() {
    const bytes = crypto.randomBytes(6);
    let code = '';
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    return code;
}

// Returns a code that is free, or throws rather than handing back one that is
// already taken — the previous loop fell through after ten collisions and
// wrote the duplicate, which would have pointed one code at two classes.
async function allocateClassCode() {
    for (let attempt = 0; attempt < 12; attempt++) {
        const code = generateClassCode();
        const taken = await db.get('SELECT id FROM classrooms WHERE class_code = ?', [code]);
        if (!taken) return code;
    }
    throw new Error('Could not allocate a free class code');
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

// --- Helper: Create Notification for all active students in a class ---
async function notifyClassStudents(classId, type, title, message, refType, refId) {
    try {
        const students = await db.all(
            "SELECT student_id FROM class_enrollments WHERE class_id = ? AND status = 'active'",
            [classId]
        );
        for (const s of students) {
            await db.run(
                'INSERT INTO notifications (user_id, type, title, message, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?)',
                [s.student_id, type, title, message, refType, refId]
            );
        }
    } catch (err) {
        console.warn('[NOTIFY ERROR]', err.message);
    }
}

// --- Authorization Middleware: Ensure caller is a teacher/owner of class ---
// Membership in teacher_classes is what authorises a teacher for a class —
// but only an *active* membership. A pending join request and a revoked one
// both leave the row in place, and neither should let anyone read a roster.
async function requireTeacherOfClass(req, res, next) {
    try {
        const classId = req.params.id || req.body.classId || req.params.classId;
        if (!classId) return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Class ID required' } });

        const tc = await db.get(
            `SELECT tc.*, c.created_by, c.status AS class_status
             FROM teacher_classes tc JOIN classrooms c ON c.id = tc.class_id
             WHERE tc.class_id = ? AND tc.teacher_id = ?`,
            [classId, req.user.id]
        );
        if (!tc || (tc.status && tc.status !== 'active')) {
            return res.status(403).json({
                success: false,
                error: {
                    code: tc && tc.status === 'pending' ? 'APPROVAL_PENDING' : 'NOT_AUTHORIZED',
                    message: tc && tc.status === 'pending'
                        ? 'Your request to join this classroom is awaiting the owner\'s approval.'
                        : 'You are not a registered teacher of this classroom'
                }
            });
        }
        if (tc.class_status === 'deleted') {
            return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Classroom not found' } });
        }
        req.teacherClass = tc;
        // The creator is the owner even if their teacher_classes row predates
        // roles being recorded there.
        req.isClassOwner = tc.role === 'owner' || Number(tc.created_by) === Number(req.user.id);
        next();
    } catch (err) {
        console.error('[TEACHER AUTH ERROR]', err.message);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Authorization check failed' } });
    }
}

// The check the routes below used to write inline, plus the two things every
// one of those copies missed: a pending or revoked membership is not authority,
// and a deleted class is not a class. Returns null when the caller has no
// standing, so `if (!tc) return 403` at the call sites keeps working.
async function activeTeacherMembership(classId, teacherId) {
    const tc = await db.get(
        `SELECT tc.*, c.status AS class_status, c.created_by
         FROM teacher_classes tc JOIN classrooms c ON c.id = tc.class_id
         WHERE tc.class_id = ? AND tc.teacher_id = ?`,
        [classId, teacherId]
    );
    if (!tc) return null;
    if (tc.status && tc.status !== 'active') return null;
    if (tc.class_status === 'deleted') return null;
    return tc;
}

// Class-wide powers. The split follows the permission matrix already written
// down in middleware/classroomAuth.js: a subject teacher teaches, a class
// teacher also manages the roster and the code, and only the owner can archive
// the class or decide who else teaches it.
function requireClassPower(power) {
    const ALLOWED = {
        MANAGE_ROSTER: ['owner', 'class_teacher'],
        MANAGE_CLASS_CODE: ['owner', 'class_teacher'],
        ARCHIVE_CLASSROOM: ['owner'],
        MANAGE_TEACHERS: ['owner']
    };
    return (req, res, next) => {
        const role = req.isClassOwner ? 'owner' : (req.teacherClass && req.teacherClass.role) || 'subject_teacher';
        if (!(ALLOWED[power] || []).includes(role)) {
            return res.status(403).json({
                success: false,
                error: { code: 'NOT_AUTHORIZED', message: `Only the class ${ALLOWED[power].join(' or ')} can do this.` }
            });
        }
        next();
    };
}

// An archived class is readable but frozen: no new work, no roster changes.
function requireActiveClass(req, res, next) {
    const status = req.teacherClass && req.teacherClass.class_status;
    if (status && status !== 'active') {
        return res.status(409).json({
            success: false,
            error: { code: 'CLASS_NOT_ACTIVE', message: `This classroom is ${status} and is read-only.` }
        });
    }
    next();
}

// ============================================================================
// 1. CREATE CLASSROOM
// ============================================================================
router.post('/classes', async (req, res) => {
    try {
        const { name, grade, section, subject, academic_year, description } = req.body;
        if (!name || !section) {
            return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Class Name and Section are required' } });
        }

        const classCode = await allocateClassCode();

        const classRes = await db.run(
            'INSERT INTO classrooms (name, grade, section, subject, academic_year, class_code, description, created_by, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [name.trim(), grade ? grade.trim() : 'Class 9', section.trim().toUpperCase(), subject ? subject.trim() : 'All Subjects', academic_year ? academic_year.trim() : '2026-27', classCode, description || '', req.user.id, 'active']
        );

        const classId = classRes.lastID;

        // Register creator as owner/class_teacher
        await db.run(
            'INSERT INTO teacher_classes (class_id, teacher_id, subject, role) VALUES (?, ?, ?, ?)',
            [classId, req.user.id, subject ? subject.trim() : 'Class Teacher', 'owner']
        );

        await logAudit(req.user.id, 'CLASS_CREATED', 'classrooms', classId, { name, section, classCode });

        const newClass = await db.get('SELECT * FROM classrooms WHERE id = ?', [classId]);
        res.json({
            success: true,
            classroom: { ...newClass, my_role: 'owner', teacher_count: 1, student_count: 0 }
        });
    } catch (err) {
        console.error('[CREATE CLASS ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Something went wrong on our side. Please try again.' } });
    }
});

// ============================================================================
// 2. TEACHER JOINS EXISTING CLASS WITH CLASS CODE
// ============================================================================
// Knowing a class code is not authority to teach a class. The code is the same
// one students are given, so anyone a student shares it with could otherwise
// have walked in — and the old version took the role straight from the request
// body, so they could walk in as `owner` and take the class over. A code now
// only requests a seat; the owner decides whether it is granted, and at what
// role. Owner is never among the options: ownership transfers deliberately.
const ASSIGNABLE_TEACHER_ROLES = ['subject_teacher', 'class_teacher'];

router.post('/classes/join', async (req, res) => {
    try {
        const { classCode, subject } = req.body;
        if (!classCode) {
            return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Class code is required' } });
        }
        if (await joinAttemptsExhausted(req.user.id)) {
            return res.status(429).json({
                success: false,
                error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many incorrect class codes. Please wait a few minutes and try again.' }
            });
        }

        const code = String(classCode).trim().toUpperCase();
        const classroom = await db.get("SELECT * FROM classrooms WHERE UPPER(class_code) = ? AND status != 'deleted'", [code]);
        if (!classroom) {
            await recordJoinAttempt(req.user.id, false);
            return res.status(404).json({ success: false, error: { code: 'INVALID_CLASS_CODE', message: 'The class code is invalid or the class does not exist.' } });
        }
        await recordJoinAttempt(req.user.id, true);

        if (classroom.status === 'archived') {
            return res.status(400).json({ success: false, error: { code: 'CLASS_ARCHIVED', message: 'This class has been archived and cannot accept new teachers.' } });
        }

        const existing = await db.get('SELECT * FROM teacher_classes WHERE class_id = ? AND teacher_id = ?', [classroom.id, req.user.id]);
        if (existing) {
            const pending = existing.status === 'pending';
            return res.status(400).json({
                success: false,
                error: {
                    code: pending ? 'APPROVAL_PENDING' : 'DUPLICATE_TEACHER',
                    message: pending
                        ? 'Your request is already waiting for the class owner to approve it.'
                        : 'You are already registered as a teacher in this classroom.'
                }
            });
        }

        // UNIQUE(class_id, teacher_id) makes a double-submitted request one row.
        try {
            await db.run(
                `INSERT INTO teacher_classes (class_id, teacher_id, subject, role, status, requested_at)
                 VALUES (?, ?, ?, 'subject_teacher', 'pending', CURRENT_TIMESTAMP)`,
                [classroom.id, req.user.id, subject ? String(subject).trim().slice(0, 80) : 'Subject Teacher']
            );
        } catch (err) {
            if (!/unique|duplicate/i.test(err.message)) throw err;
        }

        const owner = await db.get(
            `SELECT teacher_id FROM teacher_classes WHERE class_id = ? AND role = 'owner' LIMIT 1`,
            [classroom.id]
        );
        const ownerId = (owner && owner.teacher_id) || classroom.created_by;
        if (ownerId) {
            await db.run(
                'INSERT INTO notifications (user_id, type, title, message, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?)',
                [ownerId, 'teacher_request', 'Teacher access requested',
                 `${req.user.username} has asked to teach ${classroom.name}-${classroom.section}.`, 'classrooms', classroom.id]
            );
        }

        await logAudit(req.user.id, 'TEACHER_ACCESS_REQUESTED', 'classrooms', classroom.id, { subject });

        res.json({
            success: true,
            status: 'pending',
            message: `Request sent. ${classroom.name}-${classroom.section} will appear once the class owner approves it.`,
            classroom: { id: classroom.id, name: classroom.name, section: classroom.section, my_role: null, my_status: 'pending' }
        });
    } catch (err) {
        console.error('[TEACHER JOIN ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Could not send the request' } });
    }
});

// ── Owner reviews teacher access requests ──────────────────────────
router.get('/classes/:id/teacher-requests', requireTeacherOfClass, requireClassPower('MANAGE_TEACHERS'), async (req, res) => {
    try {
        const requests = await db.all(
            `SELECT tc.teacher_id, tc.subject, tc.requested_at, u.username, u.profile_picture
             FROM teacher_classes tc JOIN users u ON u.id = tc.teacher_id
             WHERE tc.class_id = ? AND tc.status = 'pending' ORDER BY tc.requested_at ASC`,
            [req.params.id]
        );
        res.json({ success: true, requests });
    } catch (err) {
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Could not load requests' } });
    }
});

router.post('/classes/:id/teacher-requests/:teacherId', requireTeacherOfClass, requireClassPower('MANAGE_TEACHERS'), requireActiveClass, async (req, res) => {
    try {
        const { decision, role } = req.body;
        const classId = req.params.id;
        const teacherId = Number(req.params.teacherId);
        if (!Number.isInteger(teacherId) || teacherId <= 0) {
            return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'A valid teacher is required' } });
        }
        if (!['approve', 'reject'].includes(decision)) {
            return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'decision must be approve or reject' } });
        }
        // The owner chooses the role, and only from roles that can be granted.
        const grantedRole = ASSIGNABLE_TEACHER_ROLES.includes(role) ? role : 'subject_teacher';

        const pending = await db.get(
            `SELECT * FROM teacher_classes WHERE class_id = ? AND teacher_id = ? AND status = 'pending'`,
            [classId, teacherId]
        );
        if (!pending) {
            return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'No pending request from that teacher' } });
        }

        if (decision === 'approve') {
            await db.run(
                `UPDATE teacher_classes SET status = 'active', role = ?, approved_by = ? WHERE class_id = ? AND teacher_id = ?`,
                [grantedRole, req.user.id, classId, teacherId]
            );
        } else {
            await db.run('DELETE FROM teacher_classes WHERE class_id = ? AND teacher_id = ? AND status = \'pending\'', [classId, teacherId]);
        }

        const cls = await db.get('SELECT name, section FROM classrooms WHERE id = ?', [classId]);
        await db.run(
            'INSERT INTO notifications (user_id, type, title, message, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?)',
            [teacherId, 'teacher_request_decision',
             decision === 'approve' ? 'Teacher access approved' : 'Teacher access declined',
             `${cls ? `${cls.name}-${cls.section}` : 'The classroom'}: your request was ${decision === 'approve' ? `approved as ${grantedRole.replace('_', ' ')}` : 'declined'}.`,
             'classrooms', classId]
        );
        await logAudit(req.user.id, decision === 'approve' ? 'TEACHER_APPROVED' : 'TEACHER_REJECTED', 'teacher_classes', classId, { teacherId, grantedRole });

        res.json({ success: true, message: decision === 'approve' ? `Approved as ${grantedRole.replace('_', ' ')}` : 'Request declined' });
    } catch (err) {
        console.error('[TEACHER REQUEST DECISION ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Could not record the decision' } });
    }
});

// ============================================================================
// 3. GET TEACHER'S CLASSROOMS
// ============================================================================
router.get('/classes', async (req, res) => {
    try {
        const rows = await db.all(
            `SELECT c.*, tc.role as my_role, tc.subject as my_subject,
                (SELECT COUNT(*) FROM class_enrollments WHERE class_id = c.id AND status = 'active') as student_count,
                (SELECT COUNT(*) FROM teacher_classes WHERE class_id = c.id) as teacher_count
             FROM classrooms c
             JOIN teacher_classes tc ON tc.class_id = c.id
             WHERE tc.teacher_id = ? AND c.status != 'deleted'
             ORDER BY c.created_at DESC`,
            [req.user.id]
        );
        res.json({ success: true, classes: rows });
    } catch (err) {
        console.error('[GET TEACHER CLASSES ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Something went wrong on our side. Please try again.' } });
    }
});

// ============================================================================
// 4. GET CLASSROOM DETAILS (STREAM, STATS)
// ============================================================================
router.get('/classes/:id', requireTeacherOfClass, async (req, res) => {
    try {
        const classId = req.params.id;
        const classroom = await db.get('SELECT * FROM classrooms WHERE id = ?', [classId]);
        const teachers = await db.all(
            `SELECT u.id, u.username, u.profile_picture, tc.subject, tc.role
             FROM teacher_classes tc
             JOIN users u ON u.id = tc.teacher_id
             WHERE tc.class_id = ?`,
            [classId]
        );
        const students = await db.all(
            `SELECT u.id, u.username, u.profile_picture, ce.id as enrollment_id, ce.status, ce.joined_via, ce.joined_at
             FROM class_enrollments ce
             JOIN users u ON u.id = ce.student_id
             WHERE ce.class_id = ? AND ce.status = 'active'
             ORDER BY u.username ASC`,
            [classId]
        );

        // Recent stream activities
        const announcements = await db.all(
            `SELECT a.*, u.username as teacher_name, u.profile_picture as teacher_avatar
             FROM class_announcements a
             JOIN users u ON u.id = a.teacher_id
             WHERE a.class_id = ? ORDER BY a.created_at DESC LIMIT 20`,
            [classId]
        );
        const homework = await db.all(
            `SELECT h.*, u.username as teacher_name,
                (SELECT COUNT(*) FROM homework_submissions WHERE homework_id = h.id) as submission_count
             FROM class_homework h
             JOIN users u ON u.id = h.teacher_id
             WHERE h.class_id = ? ORDER BY h.created_at DESC LIMIT 20`,
            [classId]
        );
        const worksheets = await db.all(
            `SELECT w.*, u.username as teacher_name,
                (SELECT COUNT(*) FROM worksheet_attempts WHERE worksheet_id = w.id) as attempt_count
             FROM class_worksheets w
             JOIN users u ON u.id = w.teacher_id
             WHERE w.class_id = ? ORDER BY w.created_at DESC LIMIT 20`,
            [classId]
        );
        const notes = await db.all(
            `SELECT n.*, u.username as teacher_name
             FROM class_notes n
             JOIN users u ON u.id = n.teacher_id
             WHERE n.class_id = ? ORDER BY n.created_at DESC LIMIT 20`,
            [classId]
        );

        res.json({
            success: true,
            classroom,
            my_role: req.teacherClass.role,
            teachers,
            students,
            stream: { announcements, homework, worksheets, notes }
        });
    } catch (err) {
        console.error('[GET CLASS DETAILS ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Something went wrong on our side. Please try again.' } });
    }
});

// ============================================================================
// 5. GET CLASSROOM STUDENTS & PEOPLE LIST
// ============================================================================
router.get('/classes/:id/students', requireTeacherOfClass, async (req, res) => {
    try {
        const classId = req.params.id;
        const students = await db.all(
            `SELECT u.id, u.username, u.profile_picture, ce.id as enrollment_id, ce.status, ce.joined_via, ce.joined_at,
                (SELECT COUNT(*) FROM homework_submissions hs JOIN class_homework ch ON ch.id = hs.homework_id WHERE ch.class_id = ? AND hs.student_id = u.id) as submissions_count,
                (SELECT COUNT(*) FROM worksheet_attempts wa JOIN class_worksheets cw ON cw.id = wa.worksheet_id WHERE cw.class_id = ? AND wa.student_id = u.id) as worksheets_count
             FROM class_enrollments ce
             JOIN users u ON u.id = ce.student_id
             WHERE ce.class_id = ? AND ce.status = 'active'
             ORDER BY u.username ASC`,
            [classId, classId, classId]
        );

        const blocked = await db.all(
            `SELECT u.id, u.username, csr.reason, csr.created_at
             FROM class_student_restrictions csr
             JOIN users u ON u.id = csr.student_id
             WHERE csr.class_id = ?`,
            [classId]
        );

        res.json({ success: true, students, blocked });
    } catch (err) {
        console.error('[GET STUDENTS ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Something went wrong on our side. Please try again.' } });
    }
});

// ============================================================================
// 6. REMOVE STUDENT (Can rejoin with class code)
// ============================================================================
router.post('/classes/:id/students/remove', requireTeacherOfClass, requireClassPower('MANAGE_ROSTER'), requireActiveClass, async (req, res) => {
    try {
        const classId = req.params.id;
        const { studentId } = req.body;
        if (!Number.isInteger(Number(studentId)) || Number(studentId) <= 0) {
            return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'A valid student is required' } });
        }

        const updated = await db.run(
            "UPDATE class_enrollments SET status = 'removed', removed_at = CURRENT_TIMESTAMP, removed_by = ? WHERE class_id = ? AND student_id = ? AND status = 'active'",
            [req.user.id, classId, studentId]
        );
        if (!updated.changes) {
            return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'That student is not actively enrolled in this class' } });
        }

        const cls = await db.get('SELECT name, section FROM classrooms WHERE id = ?', [classId]);
        await db.run(
            'INSERT INTO notifications (user_id, type, title, message, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?)',
            [studentId, 'student_removed', 'Removed from Classroom', `You have been removed from ${cls ? `${cls.name}-${cls.section}` : 'the classroom'}.`, 'classrooms', classId]
        );

        await logAudit(req.user.id, 'STUDENT_REMOVED', 'class_enrollments', studentId, { classId });
        res.json({ success: true, message: 'Student removed successfully' });
    } catch (err) {
        console.error('[REMOVE STUDENT ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Something went wrong on our side. Please try again.' } });
    }
});

// ============================================================================
// 7. BLOCK STUDENT (Cannot rejoin with class code)
// ============================================================================
router.post('/classes/:id/students/block', requireTeacherOfClass, requireClassPower('MANAGE_ROSTER'), requireActiveClass, async (req, res) => {
    try {
        const classId = req.params.id;
        const { studentId, reason } = req.body;
        if (!Number.isInteger(Number(studentId)) || Number(studentId) <= 0) {
            return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'A valid student is required' } });
        }

        // The enrollment row and the restriction row have to move together —
        // one saying blocked while the other does not is what made unblocking
        // appear to work while the student stayed locked out.
        await db.transaction(async () => {
            await db.run(
                "UPDATE class_enrollments SET status = 'blocked', removed_at = CURRENT_TIMESTAMP, removed_by = ? WHERE class_id = ? AND student_id = ?",
                [req.user.id, classId, studentId]
            );
            const restriction = await db.get(
                'SELECT id FROM class_student_restrictions WHERE class_id = ? AND student_id = ?',
                [classId, studentId]
            );
            if (restriction) {
                await db.run(
                    "UPDATE class_student_restrictions SET type = 'blocked', reason = ?, created_by = ? WHERE id = ?",
                    [String(reason || 'Restricted by teacher').slice(0, 300), req.user.id, restriction.id]
                );
            } else {
                // INSERT OR REPLACE is SQLite-only; this works on both engines.
                await db.run(
                    "INSERT INTO class_student_restrictions (class_id, student_id, type, reason, created_by) VALUES (?, ?, 'blocked', ?, ?)",
                    [classId, studentId, String(reason || 'Restricted by teacher').slice(0, 300), req.user.id]
                );
            }
        });

        await logAudit(req.user.id, 'STUDENT_BLOCKED', 'class_student_restrictions', studentId, { classId, reason });
        res.json({ success: true, message: 'Student has been blocked from rejoining' });
    } catch (err) {
        console.error('[BLOCK STUDENT ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Could not block the student' } });
    }
});

// ============================================================================
// 8. UNBLOCK STUDENT
// ============================================================================
// Lifting a block used to delete the restriction and stop there, leaving the
// enrollment on 'blocked' — which the join route reads and refuses. The
// student stayed locked out and the teacher was told it had worked. Both rows
// now move together, to 'removed': the block is lifted, and the student
// rejoins deliberately with the class code rather than being silently put back
// into a class they may have left.
router.post('/classes/:id/students/unblock', requireTeacherOfClass, requireClassPower('MANAGE_ROSTER'), requireActiveClass, async (req, res) => {
    try {
        const classId = req.params.id;
        const { studentId } = req.body;
        if (!Number.isInteger(Number(studentId)) || Number(studentId) <= 0) {
            return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'A valid student is required' } });
        }

        await db.transaction(async () => {
            await db.run('DELETE FROM class_student_restrictions WHERE class_id = ? AND student_id = ?', [classId, studentId]);
            await db.run(
                "UPDATE class_enrollments SET status = 'removed' WHERE class_id = ? AND student_id = ? AND status = 'blocked'",
                [classId, studentId]
            );
        });

        const cls = await db.get('SELECT name, section, class_code FROM classrooms WHERE id = ?', [classId]);
        await db.run(
            'INSERT INTO notifications (user_id, type, title, message, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?)',
            [studentId, 'student_unblocked', 'You can rejoin this classroom',
             `${cls ? `${cls.name}-${cls.section}` : 'A classroom'} is open to you again. Use the class code to rejoin.`, 'classrooms', classId]
        );
        await logAudit(req.user.id, 'STUDENT_UNBLOCKED', 'class_student_restrictions', studentId, { classId });

        res.json({ success: true, message: 'Block lifted. The student can now rejoin with the class code.' });
    } catch (err) {
        console.error('[UNBLOCK STUDENT ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Could not lift the block' } });
    }
});

// ============================================================================
// 9. REGENERATE CLASS CODE (Owner/Class Teacher only)
// ============================================================================
router.post('/classes/:id/regenerate-code', requireTeacherOfClass, requireClassPower('MANAGE_CLASS_CODE'), requireActiveClass, async (req, res) => {
    try {
        const classId = req.params.id;
        const newCode = await allocateClassCode();

        await db.run('UPDATE classrooms SET class_code = ? WHERE id = ?', [newCode, classId]);
        await logAudit(req.user.id, 'CLASS_CODE_REGENERATED', 'classrooms', classId, { newCode });

        res.json({ success: true, newCode });
    } catch (err) {
        console.error('[REGENERATE CODE ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Something went wrong on our side. Please try again.' } });
    }
});

// ============================================================================
// 10. ARCHIVE CLASSROOM
// ============================================================================
router.post('/classes/:id/archive', requireTeacherOfClass, requireClassPower('ARCHIVE_CLASSROOM'), async (req, res) => {
    try {
        const classId = req.params.id;
        const restore = req.body && req.body.restore === true;
        await db.run('UPDATE classrooms SET status = ? WHERE id = ?', [restore ? 'active' : 'archived', classId]);
        await logAudit(req.user.id, restore ? 'CLASS_RESTORED' : 'CLASS_ARCHIVED', 'classrooms', classId, {});
        res.json({
            success: true,
            status: restore ? 'active' : 'archived',
            message: restore
                ? 'Classroom restored. It accepts new work again.'
                : 'Classroom archived. It stays readable, but new work and roster changes are closed.'
        });
    } catch (err) {
        console.error('[ARCHIVE CLASS ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Could not update the classroom' } });
    }
});

// ============================================================================
// 11. ANNOUNCEMENTS (POST)
// ============================================================================
router.post('/announcements', async (req, res) => {
    try {
        const { classId, title, message, priority, attachments } = req.body;
        if (!classId || !title || !message) {
            return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Class ID, Title, and Message are required' } });
        }

        const tc = await activeTeacherMembership(classId, req.user.id);
        if (!tc) return res.status(403).json({ success: false, error: { code: 'NOT_AUTHORIZED', message: 'Not authorized for this class' } });
        // An archived class stays readable, and existing work can still be
        // graded, but it takes no new material.
        if (tc.class_status !== 'active') return res.status(409).json({ success: false, error: { code: 'CLASS_NOT_ACTIVE', message: `This classroom is ${tc.class_status} and no longer accepts new work.` } });

        const result = await db.run(
            'INSERT INTO class_announcements (class_id, teacher_id, title, message, priority, attachments) VALUES (?, ?, ?, ?, ?, ?)',
            [classId, req.user.id, title.trim(), message.trim(), priority || 'normal', attachments ? JSON.stringify(attachments) : null]
        );

        const annId = result.lastID;
        await notifyClassStudents(classId, 'announcement', title, message.substring(0, 100), 'announcement', annId);
        await logAudit(req.user.id, 'ANNOUNCEMENT_CREATED', 'class_announcements', annId, { classId, title });

        const announcement = await db.get(
            `SELECT a.*, u.username as teacher_name, u.profile_picture as teacher_avatar
             FROM class_announcements a JOIN users u ON u.id = a.teacher_id WHERE a.id = ?`,
            [annId]
        );
        res.json({ success: true, announcement });
    } catch (err) {
        console.error('[ANNOUNCEMENT ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Something went wrong on our side. Please try again.' } });
    }
});

// ============================================================================
// 12. HOMEWORK (CREATE / SUBMISSIONS / GRADE)
// ============================================================================
router.post('/homework', async (req, res) => {
    try {
        const { classId, title, subject, instructions, due_date, due_time, max_marks, attachments } = req.body;
        if (!classId || !title || !subject) {
            return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Class ID, Title, and Subject are required' } });
        }

        const tc = await activeTeacherMembership(classId, req.user.id);
        if (!tc) return res.status(403).json({ success: false, error: { code: 'NOT_AUTHORIZED', message: 'Not authorized for this class' } });
        // An archived class stays readable, and existing work can still be
        // graded, but it takes no new material.
        if (tc.class_status !== 'active') return res.status(409).json({ success: false, error: { code: 'CLASS_NOT_ACTIVE', message: `This classroom is ${tc.class_status} and no longer accepts new work.` } });

        const result = await db.run(
            'INSERT INTO class_homework (class_id, teacher_id, title, subject, instructions, due_date, due_time, max_marks, attachments, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [classId, req.user.id, title.trim(), subject.trim(), instructions || '', due_date || '', due_time || '', max_marks || 100, attachments ? JSON.stringify(attachments) : null, 'assigned']
        );

        const hwId = result.lastID;
        await notifyClassStudents(classId, 'homework', `New Homework: ${title}`, `Due: ${due_date || 'Soon'} in ${subject}`, 'homework', hwId);
        await logAudit(req.user.id, 'HOMEWORK_CREATED', 'class_homework', hwId, { classId, title });

        const homework = await db.get('SELECT h.*, u.username as teacher_name FROM class_homework h JOIN users u ON u.id = h.teacher_id WHERE h.id = ?', [hwId]);
        res.json({ success: true, homework });
    } catch (err) {
        console.error('[HOMEWORK ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Something went wrong on our side. Please try again.' } });
    }
});

router.get('/homework/:id/submissions', async (req, res) => {
    try {
        const hwId = req.params.id;
        const hw = await db.get('SELECT * FROM class_homework WHERE id = ?', [hwId]);
        if (!hw) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Homework not found' } });

        const tc = await activeTeacherMembership(hw.class_id, req.user.id);
        if (!tc) return res.status(403).json({ success: false, error: { code: 'NOT_AUTHORIZED', message: 'Not authorized' } });

        const submissions = await db.all(
            `SELECT hs.*, u.username as student_name, u.profile_picture as student_avatar
             FROM homework_submissions hs
             JOIN users u ON u.id = hs.student_id
             WHERE hs.homework_id = ?
             ORDER BY hs.submitted_at DESC`,
            [hwId]
        );
        res.json({ success: true, homework: hw, submissions });
    } catch (err) {
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Something went wrong on our side. Please try again.' } });
    }
});

router.post('/homework/grade', async (req, res) => {
    try {
        const { submissionId, marks, feedback, revision } = req.body;
        if (!submissionId || marks === undefined) {
            return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Submission ID and marks required' } });
        }

        const sub = await db.get('SELECT hs.*, ch.class_id, ch.title, ch.max_marks FROM homework_submissions hs JOIN class_homework ch ON ch.id = hs.homework_id WHERE hs.id = ?', [submissionId]);
        if (!sub) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Submission not found' } });

        const tc = await activeTeacherMembership(sub.class_id, req.user.id);
        if (!tc) return res.status(403).json({ success: false, error: { code: 'NOT_AUTHORIZED', message: 'Not authorized' } });

        // "0" is a legitimate mark and NaN is not, so the check is on the
        // parsed number, not on truthiness. Infinity and 1e999 both fail
        // Number.isFinite; a string of digits is accepted and coerced.
        const maximum = Number(sub.max_marks) > 0 ? Number(sub.max_marks) : 100;
        const parsedMark = parseMark(marks, maximum);
        if (!parsedMark.ok) {
            return res.status(400).json({
                success: false,
                error: { code: 'INVALID_MARKS', message: `${parsedMark.reason} Marks must be between 0 and ${maximum}.` }
            });
        }
        const awarded = parsedMark.value;

        // A teacher who opened version 1, marked it, and submits while the
        // student has since sent version 2 would otherwise stamp the old grade
        // onto the new answer without either of them noticing.
        const currentRevision = Number(sub.revision || 1);
        if (revision !== undefined && Number(revision) !== currentRevision) {
            return res.status(409).json({
                success: false,
                error: {
                    code: 'REVISION_CHANGED',
                    message: `This student has submitted a newer version (v${currentRevision}) since you opened it. Reload before grading.`,
                    currentRevision
                }
            });
        }

        await db.run(
            "UPDATE homework_submissions SET marks = ?, feedback = ?, status = 'graded', graded_at = CURRENT_TIMESTAMP, graded_by = ?, graded_revision = ? WHERE id = ?",
            [awarded, String(feedback || '').slice(0, 2000), req.user.id, currentRevision, submissionId]
        );

        await db.run(
            'INSERT INTO notifications (user_id, type, title, message, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?)',
            [sub.student_id, 'homework_graded', `Homework Graded: ${sub.title}`, `You scored ${awarded} out of ${maximum}. Feedback: ${feedback || 'Good work!'}`, 'homework', sub.homework_id]
        );

        res.json({ success: true, marks: awarded, revision: currentRevision, message: 'Submission graded successfully' });
    } catch (err) {
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Something went wrong on our side. Please try again.' } });
    }
});

// ============================================================================
// 13. STUDY NOTES (CREATE / PUBLISH)
// ============================================================================
router.post('/notes', async (req, res) => {
    try {
        const { classId, title, subject, content, attachments, status } = req.body;
        if (!classId || !title || !content) {
            return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Class ID, Title, and Content are required' } });
        }

        const tc = await activeTeacherMembership(classId, req.user.id);
        if (!tc) return res.status(403).json({ success: false, error: { code: 'NOT_AUTHORIZED', message: 'Not authorized' } });
        // An archived class stays readable, and existing work can still be
        // graded, but it takes no new material.
        if (tc.class_status !== 'active') return res.status(409).json({ success: false, error: { code: 'CLASS_NOT_ACTIVE', message: `This classroom is ${tc.class_status} and no longer accepts new work.` } });

        const result = await db.run(
            'INSERT INTO class_notes (class_id, teacher_id, title, subject, content, attachments, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [classId, req.user.id, title.trim(), subject ? subject.trim() : 'General', content.trim(), attachments ? JSON.stringify(attachments) : null, status || 'published']
        );

        const noteId = result.lastID;
        if (status !== 'draft') {
            await notifyClassStudents(classId, 'notes', `New Study Notes: ${title}`, `Subject: ${subject || 'General'}`, 'notes', noteId);
        }

        const note = await db.get('SELECT n.*, u.username as teacher_name FROM class_notes n JOIN users u ON u.id = n.teacher_id WHERE n.id = ?', [noteId]);
        res.json({ success: true, note });
    } catch (err) {
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Something went wrong on our side. Please try again.' } });
    }
});

// ============================================================================
// 14. AI WORKSHEET GENERATOR (GENERATE -> PREVIEW/EDIT -> PUBLISH)
// ============================================================================
router.post('/worksheets/generate', async (req, res) => {
    try {
        const { grade, subject, topic, chapter, difficulty, numQuestions, questionTypes, language, totalMarks, duration } = req.body;
        if (!subject || !topic) {
            return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Subject and Topic are required' } });
        }

        const prompt = `You are an expert curriculum designer and educator.
Create a comprehensive, pedagogically sound school worksheet on:
- Class/Grade: ${grade || 'Class 9'}
- Subject: ${subject}
- Chapter/Topic: ${chapter ? `${chapter} - ${topic}` : topic}
- Difficulty Level: ${difficulty || 'Medium'}
- Question Types: ${questionTypes || 'MCQ, Short Answer, Fill in the blanks'}
- Number of Questions: ${numQuestions || 5}
- Language: ${language || 'English'}
- Total Marks: ${totalMarks || 20}
- Suggested Duration: ${duration || 30} minutes

Respond ONLY with valid, parseable JSON in the following exact format without markdown backticks or commentary:
{
  "title": "${topic} Practice Worksheet",
  "instructions": "Answer all questions carefully. Time limit: ${duration || 30} minutes.",
  "subject": "${subject}",
  "total_marks": ${totalMarks || 20},
  "duration": ${duration || 30},
  "questions": [
    {
      "id": 1,
      "type": "mcq",
      "question": "What is the key principle of ${topic}?",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correct_answer": "Option A",
      "explanation": "Fundamental core concept",
      "marks": 2
    },
    {
      "id": 2,
      "type": "true_false",
      "question": "Statement relating to ${topic} is scientifically valid.",
      "options": ["True", "False"],
      "correct_answer": "True",
      "explanation": "Valid law",
      "marks": 1
    },
    {
      "id": 3,
      "type": "short_answer",
      "question": "Explain how ${topic} works with an everyday example.",
      "options": [],
      "correct_answer": "Key points and examples",
      "explanation": "Conceptual clarity",
      "marks": 3
    }
  ]
}`;

        const rawText = await generateAIJSON(prompt, 'You are an expert school educator. Respond ONLY with valid JSON matching the requested schema.');

        let worksheetJson = {};
        try {
            worksheetJson = JSON.parse(rawText.replace(/```json/gi, '').replace(/```/gi, '').trim());
        } catch (parseErr) {
            worksheetJson = {
                title: `${topic} Worksheet`,
                instructions: 'Answer all questions.',
                subject,
                total_marks: totalMarks || 20,
                duration: duration || 30,
                questions: [
                    {
                        id: 1,
                        type: 'mcq',
                        question: `Which fundamental principle applies to ${topic}?`,
                        options: ['Conservation of Energy', 'Rate of Change', 'Equilibrium', 'None of the above'],
                        correct_answer: 'Conservation of Energy',
                        explanation: 'Core scientific principle',
                        marks: 2
                    }
                ]
            };
        }

        res.json({ success: true, worksheet: worksheetJson });
    } catch (err) {
        console.error('[AI WORKSHEET GENERATOR ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'AI_ERROR', message: err.message } });
    }
});

// Generate 3 differentiated versions of a test (Easy / Medium / Hard) in one call —
// same question count and topic, scaled difficulty, each independently publishable.
router.post('/worksheets/generate-differentiated', async (req, res) => {
    try {
        const { grade, subject, topic, numQuestions, language, duration } = req.body;
        if (!subject || !topic) {
            return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Subject and Topic are required' } });
        }
        const qCount = numQuestions || 6;

        const prompt = `You are an expert curriculum designer. Create THREE differentiated versions of the same test — Easy, Medium, and Hard — all covering the identical topic so a teacher can assign the right level to each student.
- Class/Grade: ${grade || 'Class 9'}
- Subject: ${subject}
- Topic: ${topic}
- Language: ${language || 'English'}
- Questions per version: ${qCount}
- Suggested duration per version: ${duration || 30} minutes

Each version should test the SAME core concept but scale in complexity: Easy = recall & basic application, Medium = applied reasoning, Hard = multi-step analysis/synthesis.

Respond ONLY with valid JSON in this exact shape (no markdown fences, no commentary):
{
  "easy": { "title": "...", "instructions": "...", "subject": "${subject}", "total_marks": 20, "duration": ${duration || 30}, "questions": [ { "id": 1, "type": "mcq", "question": "...", "options": ["A","B","C","D"], "correct_answer": "A", "explanation": "...", "marks": 2 } ] },
  "medium": { "title": "...", "instructions": "...", "subject": "${subject}", "total_marks": 20, "duration": ${duration || 30}, "questions": [ ... ] },
  "hard": { "title": "...", "instructions": "...", "subject": "${subject}", "total_marks": 20, "duration": ${duration || 30}, "questions": [ ... ] }
}`;

        const rawText = await generateAIJSON(prompt, 'You are an expert school educator who writes rigorous, well-scaffolded differentiated assessments. Respond ONLY with valid JSON matching the requested schema.');

        let parsed = {};
        try {
            parsed = JSON.parse(rawText.replace(/```json/gi, '').replace(/```/gi, '').trim());
        } catch (parseErr) {
            return res.status(502).json({ success: false, error: { code: 'AI_ERROR', message: "Couldn't generate the differentiated test right now — please try again." } });
        }

        if (!parsed.easy || !parsed.medium || !parsed.hard) {
            return res.status(502).json({ success: false, error: { code: 'AI_ERROR', message: 'The AI response was incomplete — please try again.' } });
        }

        res.json({ success: true, versions: parsed });
    } catch (err) {
        console.error('[DIFFERENTIATED TEST GENERATOR ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'AI_ERROR', message: err.message } });
    }
});

// Publish / Save Worksheet to Class
router.post('/worksheets/publish', async (req, res) => {
    try {
        const { classId, title, subject, description, topic, difficulty, total_marks, duration, worksheet_data, status } = req.body;
        if (!classId || !title || !worksheet_data) {
            return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Class ID, Title, and Worksheet Data are required' } });
        }

        const tc = await activeTeacherMembership(classId, req.user.id);
        if (!tc) return res.status(403).json({ success: false, error: { code: 'NOT_AUTHORIZED', message: 'Not authorized for this class' } });
        // An archived class stays readable, and existing work can still be
        // graded, but it takes no new material.
        if (tc.class_status !== 'active') return res.status(409).json({ success: false, error: { code: 'CLASS_NOT_ACTIVE', message: `This classroom is ${tc.class_status} and no longer accepts new work.` } });

        // A worksheet that cannot be graded fairly is rejected here rather than
        // reaching a class and failing one answer at a time: unique question
        // ids, supported types, distinct options, a key that names one of them,
        // and positive marks. The total comes from the questions, so a stale
        // total_marks in the request cannot make a worksheet out of 20 that is
        // really out of 35.
        const check = validateWorksheet(worksheet_data);
        if (!check.ok) {
            return res.status(400).json({
                success: false,
                error: {
                    code: 'INVALID_WORKSHEET',
                    message: 'This worksheet cannot be published yet.',
                    details: check.errors.slice(0, 10)
                }
            });
        }

        const result = await db.run(
            'INSERT INTO class_worksheets (class_id, teacher_id, title, subject, description, topic, difficulty, worksheet_data, total_marks, duration, status, opens_at, closes_at, max_attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [classId, req.user.id, title.trim(), subject || 'General', description || '', topic || title, difficulty || 'Medium',
             JSON.stringify({ ...(typeof worksheet_data === 'object' && worksheet_data ? worksheet_data : {}), questions: check.questions }),
             check.totalMarks, duration || 30, status || 'published',
             req.body.opens_at || null, req.body.closes_at || null,
             Number.isInteger(Number(req.body.max_attempts)) && Number(req.body.max_attempts) > 0 ? Number(req.body.max_attempts) : null]
        );

        const wsId = result.lastID;
        if (status !== 'draft') {
            await notifyClassStudents(classId, 'worksheet', `New AI Worksheet: ${title}`, `${subject || 'General'} • ${check.totalMarks} Marks`, 'worksheet', wsId);
        }

        await logAudit(req.user.id, 'WORKSHEET_PUBLISHED', 'class_worksheets', wsId, { classId, title });

        const published = await db.get('SELECT w.*, u.username as teacher_name FROM class_worksheets w JOIN users u ON u.id = w.teacher_id WHERE w.id = ?', [wsId]);
        res.json({ success: true, worksheet: published });
    } catch (err) {
        console.error('[PUBLISH WORKSHEET ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Something went wrong on our side. Please try again.' } });
    }
});

// View student attempts for a worksheet
router.get('/worksheets/:id/attempts', async (req, res) => {
    try {
        const wsId = req.params.id;
        const ws = await db.get('SELECT * FROM class_worksheets WHERE id = ?', [wsId]);
        if (!ws) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Worksheet not found' } });

        const tc = await activeTeacherMembership(ws.class_id, req.user.id);
        if (!tc) return res.status(403).json({ success: false, error: { code: 'NOT_AUTHORIZED', message: 'Not authorized' } });

        const attempts = await db.all(
            `SELECT wa.*, u.username as student_name, u.profile_picture as student_avatar
             FROM worksheet_attempts wa
             JOIN users u ON u.id = wa.student_id
             WHERE wa.worksheet_id = ?
             ORDER BY wa.submitted_at DESC`,
            [wsId]
        );

        res.json({ success: true, worksheet: ws, attempts });
    } catch (err) {
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Something went wrong on our side. Please try again.' } });
    }
});

// ── Review queue ───────────────────────────────────────────────────
// Where a machine grade stops being the last word. Two things land here: an
// attempt whose written answers the model could not mark confidently (or that
// fell back to the keyword heuristic), and an attempt whose score a student has
// asked a person to look at. Nothing here is scored until a teacher decides.
router.get('/reviews/queue', async (req, res) => {
    try {
        const classes = await db.all(
            `SELECT class_id FROM teacher_classes
             WHERE teacher_id = ? AND (status IS NULL OR status = 'active')`,
            [req.user.id]
        );
        const classIds = classes.map(c => c.class_id);
        if (!classIds.length) return res.json({ success: true, attempts: [], requests: [] });
        const holes = classIds.map(() => '?').join(',');

        const attempts = await db.all(
            `SELECT wa.id, wa.worksheet_id, wa.student_id, wa.score, wa.total_marks, wa.breakdown,
                    wa.graded_kind, wa.submitted_at, wa.attempt_no,
                    w.title, w.worksheet_data, w.class_id, c.name AS class_name, c.section,
                    u.username AS student_name
             FROM worksheet_attempts wa
             JOIN class_worksheets w ON w.id = wa.worksheet_id
             JOIN classrooms c ON c.id = w.class_id
             JOIN users u ON u.id = wa.student_id
             WHERE w.class_id IN (${holes}) AND wa.grading_status = 'provisional'
             ORDER BY wa.submitted_at ASC LIMIT 100`,
            classIds
        );

        const requests = await db.all(
            `SELECT gr.*, u.username AS student_name, c.name AS class_name, c.section
             FROM grade_reviews gr
             JOIN users u ON u.id = gr.student_id
             LEFT JOIN classrooms c ON c.id = gr.class_id
             WHERE gr.class_id IN (${holes}) AND gr.status = 'open'
             ORDER BY gr.created_at ASC LIMIT 100`,
            classIds
        );

        res.json({
            success: true,
            attempts: attempts.map(a => {
                const { worksheet_data, breakdown, ...rest } = a;
                const { questions } = validateWorksheet(worksheet_data);
                let rows = [];
                try { rows = JSON.parse(breakdown || '[]'); } catch { rows = []; }
                return {
                    ...rest,
                    className: `${a.class_name}-${a.section}`,
                    // Only the answers actually needing a person are sent.
                    items: rows.filter(r => r.needsReview).map(r => {
                        const q = questions.find(x => String(x.id) === String(r.id));
                        return {
                            id: r.id,
                            question: q ? q.question : `Question ${r.id}`,
                            expected: q ? q.correct_answer : null,
                            answer: r.answer,
                            marks: r.marks,
                            awarded: r.awarded,
                            gradedBy: r.gradedBy
                        };
                    })
                };
            }),
            requests
        });
    } catch (err) {
        console.error('[REVIEW QUEUE ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Could not load the review queue' } });
    }
});

// Finalising an attempt: the teacher's marks replace the provisional ones, the
// score becomes final, and only then is the reward paid.
router.post('/reviews/:attemptId', async (req, res) => {
    try {
        const attemptId = Number(req.params.attemptId);
        if (!Number.isInteger(attemptId) || attemptId <= 0) {
            return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'A valid attempt is required' } });
        }
        const grades = Array.isArray(req.body && req.body.grades) ? req.body.grades : [];

        const attempt = await db.get(
            `SELECT wa.*, w.class_id, w.title FROM worksheet_attempts wa
             JOIN class_worksheets w ON w.id = wa.worksheet_id WHERE wa.id = ?`,
            [attemptId]
        );
        if (!attempt) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Attempt not found' } });

        const tc = await activeTeacherMembership(attempt.class_id, req.user.id);
        if (!tc) return res.status(403).json({ success: false, error: { code: 'NOT_AUTHORIZED', message: 'Not authorized' } });

        if ((attempt.grading_status || 'graded') !== 'provisional') {
            return res.status(409).json({ success: false, error: { code: 'ALREADY_FINAL', message: 'This attempt has already been finalised.' } });
        }

        let breakdown = [];
        try { breakdown = JSON.parse(attempt.breakdown || '[]'); } catch { breakdown = []; }

        for (const g of grades) {
            const row = breakdown.find(b => String(b.id) === String(g && g.id));
            if (!row) {
                return res.status(400).json({ success: false, error: { code: 'UNKNOWN_QUESTION', message: `No question "${g && g.id}" on this attempt.` } });
            }
            const parsed = parseMark(g.awarded, Number(row.marks));
            if (!parsed.ok) {
                return res.status(400).json({ success: false, error: { code: 'INVALID_MARKS', message: `Marks for "${g.id}": ${parsed.reason}` } });
            }
            const awarded = parsed.value;
            row.awarded = awarded;
            row.feedback = String(g.feedback || row.feedback || '').slice(0, 2000);
            row.correct = awarded >= Number(row.marks) * 0.5;
            row.needsReview = false;
            // Who actually decided this mark, kept with the mark itself.
            row.gradedBy = 'teacher';
            row.reviewedBy = req.user.id;
        }

        const stillOpen = breakdown.some(b => b.needsReview);
        const previousScore = Number(attempt.score) || 0;
        const newScore = Math.min(
            breakdown.reduce((sum, b) => sum + (Number(b.awarded) || 0), 0),
            Number(attempt.total_marks) || 0
        );

        const xpEarned = await db.transaction(async () => {
            await db.run(
                `UPDATE worksheet_attempts
                    SET breakdown = ?, score = ?, grading_status = ?, status = ?, graded_kind = 'teacher'
                  WHERE id = ?`,
                [JSON.stringify(breakdown), newScore,
                 stillOpen ? 'provisional' : 'graded',
                 stillOpen ? 'awaiting_review' : 'completed', attemptId]
            );
            await db.run(
                `INSERT INTO grade_reviews (subject_type, subject_id, class_id, student_id, reason, status, previous_score, new_score, reviewer_id, resolution_note, resolved_at)
                 VALUES ('worksheet', ?, ?, ?, 'provisional grade finalised', 'resolved', ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                [attemptId, attempt.class_id, attempt.student_id, previousScore, newScore, req.user.id,
                 String((req.body && req.body.note) || '').slice(0, 500)]
            );
            if (stillOpen) return 0;
            // Deferred until a person confirmed the score.
            const grant = await grantOnce(
                attempt.student_id, `worksheet:${attempt.worksheet_id}`,
                Math.round(newScore * 2.5) + 20, `Worksheet: ${attempt.title}`
            );
            return grant.xp;
        });

        await db.run(
            'INSERT INTO notifications (user_id, type, title, message, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?)',
            [attempt.student_id, 'worksheet_reviewed', `Reviewed: ${attempt.title}`,
             stillOpen
                ? 'Part of your worksheet has been reviewed by your teacher.'
                : `Your teacher confirmed your score: ${newScore}/${attempt.total_marks}.`,
             'worksheet', attempt.worksheet_id]
        );
        await logAudit(req.user.id, 'ATTEMPT_REVIEWED', 'worksheet_attempts', attemptId, { previousScore, newScore });

        res.json({ success: true, score: newScore, previousScore, finalised: !stillOpen, xpAwarded: xpEarned });
    } catch (err) {
        console.error('[REVIEW ATTEMPT ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Could not save the review' } });
    }
});

// ── GET /api/teacher/overview ──────────────────────────────────────
// Dashboard numbers plus what actually needs the teacher's attention.
// The stat tiles used to be hard-wired to 0 for homework and worksheets.
router.get('/overview', async (req, res) => {
    try {
        const tid = req.user.id;

        const classes = await db.all(
            `SELECT c.id, c.name, c.section,
                    (SELECT COUNT(*) FROM class_enrollments ce WHERE ce.class_id = c.id AND ce.status = 'active') AS students
             FROM teacher_classes tc JOIN classrooms c ON c.id = tc.class_id
             WHERE tc.teacher_id = ? AND c.status = 'active'`,
            [tid]
        );
        const classIds = classes.map(c => c.id);
        const totalStudents = classes.reduce((n, c) => n + (c.students || 0), 0);

        let activeHomework = 0, publishedWorksheets = 0, ungraded = 0, needsAttention = [];

        if (classIds.length) {
            const placeholders = classIds.map(() => '?').join(',');

            const hw = await db.get(
                // Homework is created with status 'assigned'; this counted
                // 'published', which no homework row has ever had, so the
                // dashboard tile read 0 no matter how much work was set.
                `SELECT COUNT(*) AS n FROM class_homework WHERE class_id IN (${placeholders}) AND status <> 'draft'`,
                classIds
            );
            activeHomework = hw ? hw.n : 0;

            const wsCount = await db.get(
                `SELECT COUNT(*) AS n FROM class_worksheets WHERE class_id IN (${placeholders}) AND status = 'published'`,
                classIds
            );
            publishedWorksheets = wsCount ? wsCount.n : 0;

            const hwPending = await db.get(
                `SELECT COUNT(*) AS n FROM homework_submissions hs
                 JOIN class_homework h ON h.id = hs.homework_id
                 WHERE h.class_id IN (${placeholders}) AND hs.graded_at IS NULL`,
                classIds
            );
            ungraded = hwPending ? hwPending.n : 0;

            // Worksheets with submissions, weakest class average first — this
            // is the queue a teacher should work through.
            const rows = await db.all(
                `SELECT w.id, w.title, w.total_marks, c.name AS class_name, c.section AS class_section,
                        COUNT(DISTINCT wa.student_id) AS submissions,
                        AVG(CAST(wa.score AS FLOAT) / NULLIF(wa.total_marks, 0)) AS avg_ratio
                 FROM class_worksheets w
                 JOIN classrooms c ON c.id = w.class_id
                 JOIN worksheet_attempts wa ON wa.worksheet_id = w.id
                 WHERE w.class_id IN (${placeholders})
                 GROUP BY w.id
                 ORDER BY avg_ratio ASC
                 LIMIT 5`,
                classIds
            );
            needsAttention = rows.map(r => ({
                id: r.id,
                title: r.title,
                className: `${r.class_name}${r.class_section ? '-' + r.class_section : ''}`,
                submissions: r.submissions,
                avgPct: r.avg_ratio === null ? null : Math.round(r.avg_ratio * 100)
            }));
        }

        res.json({
            success: true,
            stats: {
                classes: classes.length,
                students: totalStudents,
                activeHomework,
                publishedWorksheets,
                ungraded
            },
            needsAttention
        });
    } catch (err) {
        console.error('[TEACHER OVERVIEW ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Something went wrong on our side. Please try again.' } });
    }
});

// ── GET /api/teacher/worksheets ────────────────────────────────────
// Everything this teacher has published, with how many students have
// actually submitted. Without this the teacher has no route back to a
// worksheet once it leaves the editor.
router.get('/worksheets', async (req, res) => {
    try {
        const rows = await db.all(
            `SELECT w.id, w.title, w.subject, w.topic, w.total_marks, w.status, w.created_at,
                    c.name AS class_name, c.section AS class_section, w.class_id,
                    (SELECT COUNT(DISTINCT student_id) FROM worksheet_attempts wa WHERE wa.worksheet_id = w.id) AS submissions,
                    (SELECT COUNT(*) FROM class_enrollments ce WHERE ce.class_id = w.class_id AND ce.status = 'active') AS enrolled
             FROM class_worksheets w
             JOIN teacher_classes tc ON tc.class_id = w.class_id AND tc.teacher_id = ?
             JOIN classrooms c ON c.id = w.class_id
             ORDER BY w.created_at DESC
             LIMIT 60`,
            [req.user.id]
        );
        res.json({ success: true, worksheets: rows });
    } catch (err) {
        console.error('[LIST WORKSHEETS ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Something went wrong on our side. Please try again.' } });
    }
});

// ── GET /api/teacher/worksheets/:id/analysis ───────────────────────
// Item analysis: which questions the class actually missed, and where the
// wrong answers clustered. This is the point of collecting per-question
// data — without it a worksheet is just a score.
router.get('/worksheets/:id/analysis', async (req, res) => {
    try {
        const wsId = req.params.id;
        const ws = await db.get('SELECT * FROM class_worksheets WHERE id = ?', [wsId]);
        if (!ws) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Worksheet not found' } });

        const tc = await activeTeacherMembership(ws.class_id, req.user.id);
        if (!tc) return res.status(403).json({ success: false, error: { code: 'NOT_AUTHORIZED', message: 'Not authorized' } });

        let questions = [];
        try { questions = (JSON.parse(ws.worksheet_data) || {}).questions || []; } catch (e) { questions = []; }

        const attempts = await db.all(
            `SELECT wa.*, u.username as student_name
             FROM worksheet_attempts wa JOIN users u ON u.id = wa.student_id
             WHERE wa.worksheet_id = ? ORDER BY wa.submitted_at DESC, wa.id DESC`,
            [wsId]
        );

        // One row per student — their most recent attempt.
        const latestByStudent = new Map();
        attempts.forEach(a => {
            if (!latestByStudent.has(a.student_id)) latestByStudent.set(a.student_id, a);
        });
        const latest = [...latestByStudent.values()];

        const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

        const stats = questions.map(q => {
            const marks = q.marks || 1;
            let attempted = 0, correct = 0, awardedTotal = 0;
            const wrongCounts = {};
            let needsReview = 0;

            latest.forEach(a => {
                let row = null;
                if (a.breakdown) {
                    try {
                        row = (JSON.parse(a.breakdown) || []).find(b => String(b.id) === String(q.id)) || null;
                    } catch (e) { row = null; }
                }
                if (!row) {
                    // Attempts recorded before breakdowns existed — recompute
                    // what we can from the raw answers.
                    try {
                        const ansList = JSON.parse(a.answers || '[]');
                        const given = (ansList.find(x => String(x.id) === String(q.id)) || {}).answer;
                        if (given === undefined) return;
                        const isObj = q.type === 'mcq' || q.type === 'true_false' || q.type === 'fill_blank';
                        row = {
                            answer: given,
                            correct: isObj ? norm(given) === norm(q.correct_answer) : null,
                            awarded: 0
                        };
                    } catch (e) { return; }
                }

                if (row.answer === null || row.answer === undefined || norm(row.answer) === '') return;
                attempted += 1;
                awardedTotal += Number(row.awarded) || 0;
                if (row.needsReview || row.gradedBy === 'heuristic') needsReview += 1;
                if (row.correct) {
                    correct += 1;
                } else if (row.correct === false) {
                    const key = String(row.answer).slice(0, 80);
                    wrongCounts[key] = (wrongCounts[key] || 0) + 1;
                }
            });

            const commonWrong = Object.entries(wrongCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 4)
                .map(([answer, count]) => ({ answer, count }));

            return {
                id: q.id,
                question: q.question,
                type: q.type,
                marks,
                correct_answer: q.correct_answer,
                explanation: q.explanation || null,
                attempted,
                correct,
                needsReview,
                pctCorrect: attempted ? Math.round((correct / attempted) * 100) : null,
                avgMarks: attempted ? Math.round((awardedTotal / attempted) * 10) / 10 : null,
                commonWrong
            };
        });

        // A provisional score is a machine's guess awaiting a teacher, so it is
        // counted separately rather than averaged in as though it were a mark
        // someone stands behind.
        const isProvisional = (a) => (a.grading_status || 'graded') === 'provisional';
        const finalised = latest.filter(a => a.total_marks > 0 && !isProvisional(a));
        const avgPct = finalised.length
            ? Math.round(finalised.reduce((s, a) => s + (a.score / a.total_marks) * 100, 0) / finalised.length)
            : null;

        // The denominator: how many students could have submitted. Without it,
        // "average 82%" from three of thirty reads like the class average.
        const roster = await db.get(
            "SELECT COUNT(*) AS n FROM class_enrollments WHERE class_id = ? AND status = 'active'",
            [ws.class_id]
        );
        const classSize = Number(roster && roster.n) || 0;

        // Weakest first — that ordering IS the teaching signal.
        const ranked = stats
            .filter(s => s.attempted > 0)
            .sort((a, b) => (a.pctCorrect ?? 101) - (b.pctCorrect ?? 101));

        res.json({
            success: true,
            worksheet: { id: ws.id, title: ws.title, class_id: ws.class_id, total_marks: ws.total_marks },
            summary: {
                // Each student's most recent attempt, counted once, and said
                // out loud so this and the student's own screen agree.
                showing: 'latest attempt per student',
                submissions: latest.length,
                classSize,
                notSubmitted: Math.max(classSize - latest.length, 0),
                finalisedCount: finalised.length,
                provisionalCount: latest.filter(isProvisional).length,
                // Averaged over finalised attempts only.
                avgPct,
                avgPctBasis: finalised.length,
                weakest: ranked.slice(0, 3).map(q => ({ id: q.id, question: q.question, pctCorrect: q.pctCorrect })),
                needsReview: stats.reduce((n, q) => n + q.needsReview, 0)
            },
            questions: stats,
            students: latest.map(a => ({
                id: a.student_id,
                name: a.student_name,
                score: a.score,
                total: a.total_marks,
                pct: a.total_marks ? Math.round((a.score / a.total_marks) * 100) : null,
                // An unmarked answer is not a zero, and the two must not look
                // alike in a ranking.
                gradingStatus: a.grading_status || 'graded',
                provisional: isProvisional(a),
                attemptNo: a.attempt_no || null,
                submitted_at: a.submitted_at
            })).sort((a, b) => (a.pct ?? 0) - (b.pct ?? 0))
        });
    } catch (err) {
        console.error('[ANALYSIS ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Something went wrong on our side. Please try again.' } });
    }
});

// ── POST /api/teacher/worksheets/:id/reteach ───────────────────────
// Turn the diagnosis into the next lesson: a short worksheet aimed only at
// the questions the class actually got wrong.
router.post('/worksheets/:id/reteach', async (req, res) => {
    try {
        const wsId = req.params.id;
        const { questionIds, numQuestions } = req.body || {};

        const ws = await db.get('SELECT * FROM class_worksheets WHERE id = ?', [wsId]);
        if (!ws) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Worksheet not found' } });
        const tc = await activeTeacherMembership(ws.class_id, req.user.id);
        if (!tc) return res.status(403).json({ success: false, error: { code: 'NOT_AUTHORIZED', message: 'Not authorized' } });

        let parsed = {};
        try { parsed = JSON.parse(ws.worksheet_data) || {}; } catch (e) { parsed = {}; }
        const all = parsed.questions || [];
        const wanted = Array.isArray(questionIds) && questionIds.length
            ? all.filter(q => questionIds.map(String).includes(String(q.id)))
            : all;

        if (wanted.length === 0) {
            return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'No questions selected' } });
        }

        const count = Math.min(Math.max(Number(numQuestions) || 5, 3), 10);
        const prompt = `Students in this class answered the following questions incorrectly. Write a short REMEDIAL worksheet that reteaches the same underlying concepts using different wording and fresh examples — do not simply repeat the questions.

Concepts they got wrong:
${wanted.map((q, i) => `${i + 1}. ${q.question} (expected: ${q.correct_answer})`).join('\n')}

Produce exactly ${count} questions, easier than the originals, building up from the basics.

Respond ONLY with JSON:
{"title":"Reteach: <topic>","instructions":"<one line>","subject":"${parsed.subject || ws.subject || 'General'}","total_marks":<number>,"duration":15,"questions":[{"id":1,"type":"mcq","question":"...","options":["..."],"correct_answer":"...","explanation":"...","marks":2}]}`;

        const worksheet = await generateAIJSON(
            prompt,
            'You are an expert teacher writing targeted remediation. Respond ONLY with valid JSON.'
        );

        let json = null;
        try {
            json = JSON.parse(String(worksheet).replace(/```json/gi, '').replace(/```/gi, '').trim());
        } catch (e) {
            json = null;
        }
        if (!json || !Array.isArray(json.questions) || json.questions.length === 0) {
            return res.status(502).json({ success: false, error: { code: 'AI_ERROR', message: 'Could not generate a reteach worksheet — please try again.' } });
        }

        res.json({ success: true, worksheet: json, basedOn: wanted.map(q => q.id) });
    } catch (err) {
        console.error('[RETEACH ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Something went wrong on our side. Please try again.' } });
    }
});

module.exports = router;