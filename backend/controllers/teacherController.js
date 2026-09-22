const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const db = require('../config/db');
const { providerOrder, geminiKey, geminiModel } = require('../services/ai');

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

// --- Helper: Secure Unique Class Code Generator ---
function generateClassCode() {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
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
async function requireTeacherOfClass(req, res, next) {
    try {
        const classId = req.params.id || req.body.classId || req.params.classId;
        if (!classId) return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Class ID required' } });

        const tc = await db.get(
            'SELECT tc.*, c.created_by FROM teacher_classes tc JOIN classrooms c ON c.id = tc.class_id WHERE tc.class_id = ? AND tc.teacher_id = ?',
            [classId, req.user.id]
        );
        if (!tc) {
            return res.status(403).json({ success: false, error: { code: 'NOT_AUTHORIZED', message: 'You are not a registered teacher of this classroom' } });
        }
        req.teacherClass = tc;
        next();
    } catch (err) {
        console.error('[TEACHER AUTH ERROR]', err.message);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
}

// ============================================================================
// 1. CREATE CLASSROOM
// ============================================================================
router.post('/classes', auth, async (req, res) => {
    try {
        const { name, grade, section, subject, academic_year, description } = req.body;
        if (!name || !section) {
            return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Class Name and Section are required' } });
        }

        let classCode = '';
        let exists = true;
        let attempts = 0;
        while (exists && attempts < 10) {
            classCode = generateClassCode();
            const existing = await db.get('SELECT id FROM classrooms WHERE class_code = ?', [classCode]);
            if (!existing) exists = false;
            attempts++;
        }

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
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

// ============================================================================
// 2. TEACHER JOINS EXISTING CLASS WITH CLASS CODE
// ============================================================================
router.post('/classes/join', auth, async (req, res) => {
    try {
        const { classCode, subject, role } = req.body;
        if (!classCode) {
            return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Class code is required' } });
        }

        const code = String(classCode).trim().toUpperCase();
        const classroom = await db.get('SELECT * FROM classrooms WHERE UPPER(class_code) = ? AND status != "deleted"', [code]);
        if (!classroom) {
            return res.status(404).json({ success: false, error: { code: 'INVALID_CLASS_CODE', message: 'The class code is invalid or the class does not exist.' } });
        }

        if (classroom.status === 'archived') {
            return res.status(400).json({ success: false, error: { code: 'CLASS_ARCHIVED', message: 'This class has been archived and cannot accept new teachers.' } });
        }

        const existing = await db.get('SELECT * FROM teacher_classes WHERE class_id = ? AND teacher_id = ?', [classroom.id, req.user.id]);
        if (existing) {
            return res.status(400).json({ success: false, error: { code: 'DUPLICATE_TEACHER', message: 'You are already registered as a teacher in this classroom.' } });
        }

        await db.run(
            'INSERT INTO teacher_classes (class_id, teacher_id, subject, role) VALUES (?, ?, ?, ?)',
            [classroom.id, req.user.id, subject ? subject.trim() : 'Subject Teacher', role || 'subject_teacher']
        );

        await logAudit(req.user.id, 'TEACHER_JOINED', 'classrooms', classroom.id, { subject, role });

        res.json({
            success: true,
            classroom: { ...classroom, my_role: role || 'subject_teacher' }
        });
    } catch (err) {
        console.error('[TEACHER JOIN ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

// ============================================================================
// 3. GET TEACHER'S CLASSROOMS
// ============================================================================
router.get('/classes', auth, async (req, res) => {
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
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

// ============================================================================
// 4. GET CLASSROOM DETAILS (STREAM, STATS)
// ============================================================================
router.get('/classes/:id', auth, requireTeacherOfClass, async (req, res) => {
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
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

// ============================================================================
// 5. GET CLASSROOM STUDENTS & PEOPLE LIST
// ============================================================================
router.get('/classes/:id/students', auth, requireTeacherOfClass, async (req, res) => {
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
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

// ============================================================================
// 6. REMOVE STUDENT (Can rejoin with class code)
// ============================================================================
router.post('/classes/:id/students/remove', auth, requireTeacherOfClass, async (req, res) => {
    try {
        const classId = req.params.id;
        const { studentId } = req.body;
        if (!studentId) return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Student ID required' } });

        await db.run(
            "UPDATE class_enrollments SET status = 'removed', removed_at = CURRENT_TIMESTAMP, removed_by = ? WHERE class_id = ? AND student_id = ?",
            [req.user.id, classId, studentId]
        );

        const cls = await db.get('SELECT name, section FROM classrooms WHERE id = ?', [classId]);
        await db.run(
            'INSERT INTO notifications (user_id, type, title, message, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?)',
            [studentId, 'student_removed', 'Removed from Classroom', `You have been removed from ${cls ? `${cls.name}-${cls.section}` : 'the classroom'}.`, 'classrooms', classId]
        );

        await logAudit(req.user.id, 'STUDENT_REMOVED', 'class_enrollments', studentId, { classId });
        res.json({ success: true, message: 'Student removed successfully' });
    } catch (err) {
        console.error('[REMOVE STUDENT ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

// ============================================================================
// 7. BLOCK STUDENT (Cannot rejoin with class code)
// ============================================================================
router.post('/classes/:id/students/block', auth, requireTeacherOfClass, async (req, res) => {
    try {
        const classId = req.params.id;
        const { studentId, reason } = req.body;
        if (!studentId) return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Student ID required' } });

        await db.run(
            "UPDATE class_enrollments SET status = 'blocked', removed_at = CURRENT_TIMESTAMP, removed_by = ? WHERE class_id = ? AND student_id = ?",
            [req.user.id, classId, studentId]
        );

        await db.run(
            "INSERT OR REPLACE INTO class_student_restrictions (class_id, student_id, type, reason, created_by) VALUES (?, ?, 'blocked', ?, ?)",
            [classId, studentId, reason || 'Restricted by teacher', req.user.id]
        );

        await logAudit(req.user.id, 'STUDENT_BLOCKED', 'class_student_restrictions', studentId, { classId, reason });
        res.json({ success: true, message: 'Student has been blocked from rejoining' });
    } catch (err) {
        console.error('[BLOCK STUDENT ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

// ============================================================================
// 8. UNBLOCK STUDENT
// ============================================================================
router.post('/classes/:id/students/unblock', auth, requireTeacherOfClass, async (req, res) => {
    try {
        const classId = req.params.id;
        const { studentId } = req.body;
        await db.run('DELETE FROM class_student_restrictions WHERE class_id = ? AND student_id = ?', [classId, studentId]);
        res.json({ success: true, message: 'Student restriction removed' });
    } catch (err) {
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

// ============================================================================
// 9. REGENERATE CLASS CODE (Owner/Class Teacher only)
// ============================================================================
router.post('/classes/:id/regenerate-code', auth, requireTeacherOfClass, async (req, res) => {
    try {
        const classId = req.params.id;
        let newCode = '';
        let exists = true;
        let attempts = 0;
        while (exists && attempts < 10) {
            newCode = generateClassCode();
            const existing = await db.get('SELECT id FROM classrooms WHERE class_code = ?', [newCode]);
            if (!existing) exists = false;
            attempts++;
        }

        await db.run('UPDATE classrooms SET class_code = ? WHERE id = ?', [newCode, classId]);
        await logAudit(req.user.id, 'CLASS_CODE_REGENERATED', 'classrooms', classId, { newCode });

        res.json({ success: true, newCode });
    } catch (err) {
        console.error('[REGENERATE CODE ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

// ============================================================================
// 10. ARCHIVE CLASSROOM
// ============================================================================
router.post('/classes/:id/archive', auth, requireTeacherOfClass, async (req, res) => {
    try {
        const classId = req.params.id;
        await db.run("UPDATE classrooms SET status = 'archived' WHERE id = ?", [classId]);
        await logAudit(req.user.id, 'CLASS_ARCHIVED', 'classrooms', classId, {});
        res.json({ success: true, message: 'Classroom archived' });
    } catch (err) {
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

// ============================================================================
// 11. ANNOUNCEMENTS (POST)
// ============================================================================
router.post('/announcements', auth, async (req, res) => {
    try {
        const { classId, title, message, priority, attachments } = req.body;
        if (!classId || !title || !message) {
            return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Class ID, Title, and Message are required' } });
        }

        const tc = await db.get('SELECT * FROM teacher_classes WHERE class_id = ? AND teacher_id = ?', [classId, req.user.id]);
        if (!tc) return res.status(403).json({ success: false, error: { code: 'NOT_AUTHORIZED', message: 'Not authorized for this class' } });

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
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

// ============================================================================
// 12. HOMEWORK (CREATE / SUBMISSIONS / GRADE)
// ============================================================================
router.post('/homework', auth, async (req, res) => {
    try {
        const { classId, title, subject, instructions, due_date, due_time, max_marks, attachments } = req.body;
        if (!classId || !title || !subject) {
            return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Class ID, Title, and Subject are required' } });
        }

        const tc = await db.get('SELECT * FROM teacher_classes WHERE class_id = ? AND teacher_id = ?', [classId, req.user.id]);
        if (!tc) return res.status(403).json({ success: false, error: { code: 'NOT_AUTHORIZED', message: 'Not authorized for this class' } });

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
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

router.get('/homework/:id/submissions', auth, async (req, res) => {
    try {
        const hwId = req.params.id;
        const hw = await db.get('SELECT * FROM class_homework WHERE id = ?', [hwId]);
        if (!hw) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Homework not found' } });

        const tc = await db.get('SELECT * FROM teacher_classes WHERE class_id = ? AND teacher_id = ?', [hw.class_id, req.user.id]);
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
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

router.post('/homework/grade', auth, async (req, res) => {
    try {
        const { submissionId, marks, feedback } = req.body;
        if (!submissionId || marks === undefined) {
            return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Submission ID and marks required' } });
        }

        const sub = await db.get('SELECT hs.*, ch.class_id, ch.title, ch.max_marks FROM homework_submissions hs JOIN class_homework ch ON ch.id = hs.homework_id WHERE hs.id = ?', [submissionId]);
        if (!sub) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Submission not found' } });

        const tc = await db.get('SELECT * FROM teacher_classes WHERE class_id = ? AND teacher_id = ?', [sub.class_id, req.user.id]);
        if (!tc) return res.status(403).json({ success: false, error: { code: 'NOT_AUTHORIZED', message: 'Not authorized' } });

        if (!Number.isFinite(Number(marks)) || Number(marks) < 0 || Number(marks) > sub.max_marks) return res.status(400).json({ success: false, error: { message: 'Marks must be between zero and the assignment maximum.' } });
        await db.run(
            "UPDATE homework_submissions SET marks = ?, feedback = ?, status = 'graded', graded_at = CURRENT_TIMESTAMP, graded_by = ? WHERE id = ?",
            [marks, feedback || '', req.user.id, submissionId]
        );

        await db.run(
            'INSERT INTO notifications (user_id, type, title, message, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?)',
            [sub.student_id, 'homework_graded', `Homework Graded: ${sub.title}`, `You scored ${marks} marks. Feedback: ${feedback || 'Good work!'}`, 'homework', sub.homework_id]
        );

        res.json({ success: true, message: 'Submission graded successfully' });
    } catch (err) {
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

// ============================================================================
// 13. STUDY NOTES (CREATE / PUBLISH)
// ============================================================================
router.post('/notes', auth, async (req, res) => {
    try {
        const { classId, title, subject, content, attachments, status } = req.body;
        if (!classId || !title || !content) {
            return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Class ID, Title, and Content are required' } });
        }

        const tc = await db.get('SELECT * FROM teacher_classes WHERE class_id = ? AND teacher_id = ?', [classId, req.user.id]);
        if (!tc) return res.status(403).json({ success: false, error: { code: 'NOT_AUTHORIZED', message: 'Not authorized' } });

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
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

// ============================================================================
// 14. AI WORKSHEET GENERATOR (GENERATE -> PREVIEW/EDIT -> PUBLISH)
// ============================================================================
router.post('/worksheets/generate', auth, async (req, res) => {
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
router.post('/worksheets/generate-differentiated', auth, async (req, res) => {
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
router.post('/worksheets/publish', auth, async (req, res) => {
    try {
        const { classId, title, subject, description, topic, difficulty, total_marks, duration, worksheet_data, status } = req.body;
        if (!classId || !title || !worksheet_data) {
            return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'Class ID, Title, and Worksheet Data are required' } });
        }

        const tc = await db.get('SELECT * FROM teacher_classes WHERE class_id = ? AND teacher_id = ?', [classId, req.user.id]);
        if (!tc) return res.status(403).json({ success: false, error: { code: 'NOT_AUTHORIZED', message: 'Not authorized for this class' } });

        const result = await db.run(
            'INSERT INTO class_worksheets (class_id, teacher_id, title, subject, description, topic, difficulty, worksheet_data, total_marks, duration, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [classId, req.user.id, title.trim(), subject || 'General', description || '', topic || title, difficulty || 'Medium', typeof worksheet_data === 'string' ? worksheet_data : JSON.stringify(worksheet_data), total_marks || 20, duration || 30, status || 'published']
        );

        const wsId = result.lastID;
        if (status !== 'draft') {
            await notifyClassStudents(classId, 'worksheet', `New AI Worksheet: ${title}`, `${subject || 'General'} • ${total_marks || 20} Marks`, 'worksheet', wsId);
        }

        await logAudit(req.user.id, 'WORKSHEET_PUBLISHED', 'class_worksheets', wsId, { classId, title });

        const published = await db.get('SELECT w.*, u.username as teacher_name FROM class_worksheets w JOIN users u ON u.id = w.teacher_id WHERE w.id = ?', [wsId]);
        res.json({ success: true, worksheet: published });
    } catch (err) {
        console.error('[PUBLISH WORKSHEET ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

// View student attempts for a worksheet
router.get('/worksheets/:id/attempts', auth, async (req, res) => {
    try {
        const wsId = req.params.id;
        const ws = await db.get('SELECT * FROM class_worksheets WHERE id = ?', [wsId]);
        if (!ws) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Worksheet not found' } });

        const tc = await db.get('SELECT * FROM teacher_classes WHERE class_id = ? AND teacher_id = ?', [ws.class_id, req.user.id]);
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
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

// ── GET /api/teacher/overview ──────────────────────────────────────
// Dashboard numbers plus what actually needs the teacher's attention.
// The stat tiles used to be hard-wired to 0 for homework and worksheets.
router.get('/overview', auth, async (req, res) => {
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
                `SELECT COUNT(*) AS n FROM class_homework WHERE class_id IN (${placeholders}) AND status = 'published'`,
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
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

// ── GET /api/teacher/worksheets ────────────────────────────────────
// Everything this teacher has published, with how many students have
// actually submitted. Without this the teacher has no route back to a
// worksheet once it leaves the editor.
router.get('/worksheets', auth, async (req, res) => {
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
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

// ── GET /api/teacher/worksheets/:id/analysis ───────────────────────
// Item analysis: which questions the class actually missed, and where the
// wrong answers clustered. This is the point of collecting per-question
// data — without it a worksheet is just a score.
router.get('/worksheets/:id/analysis', auth, async (req, res) => {
    try {
        const wsId = req.params.id;
        const ws = await db.get('SELECT * FROM class_worksheets WHERE id = ?', [wsId]);
        if (!ws) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Worksheet not found' } });

        const tc = await db.get('SELECT * FROM teacher_classes WHERE class_id = ? AND teacher_id = ?', [ws.class_id, req.user.id]);
        if (!tc) return res.status(403).json({ success: false, error: { code: 'NOT_AUTHORIZED', message: 'Not authorized' } });

        let questions = [];
        try { questions = (JSON.parse(ws.worksheet_data) || {}).questions || []; } catch (e) { questions = []; }

        const attempts = await db.all(
            `SELECT wa.*, u.username as student_name
             FROM worksheet_attempts wa JOIN users u ON u.id = wa.student_id
             WHERE wa.worksheet_id = ? ORDER BY wa.submitted_at DESC`,
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

        const scored = latest.filter(a => a.total_marks > 0);
        const avgPct = scored.length
            ? Math.round(scored.reduce((s, a) => s + (a.score / a.total_marks) * 100, 0) / scored.length)
            : null;

        // Weakest first — that ordering IS the teaching signal.
        const ranked = stats
            .filter(s => s.attempted > 0)
            .sort((a, b) => (a.pctCorrect ?? 101) - (b.pctCorrect ?? 101));

        res.json({
            success: true,
            worksheet: { id: ws.id, title: ws.title, class_id: ws.class_id, total_marks: ws.total_marks },
            summary: {
                submissions: latest.length,
                avgPct,
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
                submitted_at: a.submitted_at
            })).sort((a, b) => (a.pct ?? 0) - (b.pct ?? 0))
        });
    } catch (err) {
        console.error('[ANALYSIS ERROR]', err);
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

// ── POST /api/teacher/worksheets/:id/reteach ───────────────────────
// Turn the diagnosis into the next lesson: a short worksheet aimed only at
// the questions the class actually got wrong.
router.post('/worksheets/:id/reteach', auth, async (req, res) => {
    try {
        const wsId = req.params.id;
        const { questionIds, numQuestions } = req.body || {};

        const ws = await db.get('SELECT * FROM class_worksheets WHERE id = ?', [wsId]);
        if (!ws) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Worksheet not found' } });
        const tc = await db.get('SELECT * FROM teacher_classes WHERE class_id = ? AND teacher_id = ?', [ws.class_id, req.user.id]);
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
        res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
    }
});

module.exports = router;