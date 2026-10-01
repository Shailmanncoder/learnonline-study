const router = require('express').Router();
const auth = require('../middleware/auth');
const db = require('../config/db');
const learning = require('../services/learning');
router.use(auth, require('../middleware/teacher'));
router.get('/queue', async (req, res) => {
    try {
        const rows = await db.all(`SELECT a.*, w.title, w.worksheet_data, u.username AS student_name, c.name AS class_name
            FROM worksheet_attempts a JOIN class_worksheets w ON w.id = a.worksheet_id
            JOIN teacher_classes tc ON tc.class_id = w.class_id AND tc.teacher_id = ?
            JOIN classrooms c ON c.id = w.class_id JOIN users u ON u.id = a.student_id
            WHERE (a.status = 'pending_review' OR a.grading_status = 'provisional') AND (tc.status IS NULL OR tc.status='active') AND c.status='active' ORDER BY a.submitted_at LIMIT 100`, [req.user.id]);
        res.json({ attempts: rows.map(a => ({ id: a.id, title: a.title, student: a.student_name, className: a.class_name,
            score: a.score, total: a.total_marks, questions: JSON.parse(a.worksheet_data).questions,
            breakdown: JSON.parse(a.breakdown || '[]') })) });
    } catch { res.status(500).json({ msg: 'Could not load review queue.' }); }
});
router.post('/:id', async (req, res) => {
    try {
        await learning.ready();
        const result = await db.transaction(async () => {
            const a = await db.get(`SELECT a.* FROM worksheet_attempts a JOIN class_worksheets w ON w.id = a.worksheet_id
                JOIN teacher_classes tc ON tc.class_id = w.class_id AND tc.teacher_id = ? JOIN classrooms c ON c.id=w.class_id WHERE a.id = ? AND (tc.status IS NULL OR tc.status='active') AND c.status='active'` + (db.dialect() === 'mysql' ? ' FOR UPDATE' : ''), [req.user.id, req.params.id]);
            if (!a) throw learning.httpError(404, 'Attempt not found.');
            if (a.status !== 'pending_review' && a.grading_status !== 'provisional') throw learning.httpError(409, 'This attempt has already been reviewed.');
            const rows = JSON.parse(a.breakdown || '[]');
            const grades = req.body.grades;
            const pending = rows.filter(r => r.needsReview);
            if (!Array.isArray(grades) || grades.length !== pending.length || new Set(grades.map(g => String(g?.id))).size !== grades.length) throw learning.httpError(400, 'Review every flagged answer exactly once.');
            for (const row of pending) {
                const grade = grades.find(g => String(g.id) === String(row.id));
                if (!grade || !Number.isFinite(grade.awarded) || grade.awarded < 0 || grade.awarded > row.marks || typeof grade.feedback !== 'string' || !grade.feedback.trim() || grade.feedback.length > 2000) throw learning.httpError(400, 'Enter valid marks and feedback for each answer.');
                Object.assign(row, { awarded: grade.awarded, feedback: grade.feedback.trim(), gradedBy: 'teacher', needsReview: false, correct: grade.awarded >= row.marks * 0.5 });
            }
            const score = Math.min(a.total_marks, rows.reduce((n,r) => n + Number(r.awarded || 0), 0));
            await db.run("UPDATE worksheet_attempts SET score = ?, breakdown = ?, status = 'completed', grading_status = 'graded', graded_kind = 'teacher' WHERE id = ?", [score, JSON.stringify(rows), a.id]);
            const {xp: xpEarned} = await require('../services/rewards').grantOnce(a.student_id, 'worksheet:' + a.worksheet_id, Math.round(score * 2.5) + 20, 'Teacher-reviewed worksheet');
            await db.run(`INSERT INTO grade_reviews (subject_type,subject_id,class_id,student_id,reason,status,previous_score,new_score,reviewer_id,resolution_note,resolved_at)
                SELECT 'worksheet',?,class_id,?,'provisional grade finalised','resolved',?,?,?,'Teacher review queue',CURRENT_TIMESTAMP FROM class_worksheets WHERE id=?`,[a.id,a.student_id,a.score,score,req.user.id,a.worksheet_id]);
            await db.run('INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata) VALUES (?, ?, ?, ?, ?)', [req.user.id, 'WORKSHEET_REVIEWED', 'worksheet_attempts', a.id, JSON.stringify({ before: a.score, after: score, grades })]);
            await db.run('INSERT INTO notifications (user_id, type, title, message, reference_type, reference_id) VALUES (?, ?, ?, ?, ?, ?)', [a.student_id, 'worksheet_reviewed', 'Your worksheet has been reviewed', `Final score: ${score}/${a.total_marks}`, 'worksheet', a.worksheet_id]);
            return { success: true, score, xpEarned };
        });
        res.json(result);
    } catch (e) { res.status(e.status || 500).json({ msg: e.status ? e.message : 'Could not save the review.' }); }
});
module.exports = router;
