const router = require('express').Router();
const auth = require('../middleware/auth');
const db = require('../config/db');
const learning = require('../services/learning');
const { randomUUID } = require('node:crypto');
router.use(auth);
router.use(async (req, res, next) => { try { await learning.ready(); next(); } catch (e) { next(e); } });
const route = fn => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(e.status || 500).json({ msg: e.status ? e.message : 'Could not save your learning progress. Please retry.' }); } };
const dayValid = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d;
async function dashboard(userId, day) {
    const [goals, mistakes, dueCards, homework, checked, attempts] = await Promise.all([
        db.all('SELECT * FROM learning_goals WHERE user_id = ? ORDER BY exam_date', [userId]),
        db.all('SELECT id, topic, due_at FROM learning_mistakes WHERE user_id = ? AND resolved = 0 ORDER BY due_at', [userId]),
        db.get('SELECT COUNT(*) AS n FROM flashcards f JOIN flashcard_decks d ON d.id = f.deck_id WHERE d.user_id = ? AND f.due_date <= ?', [userId, new Date().toISOString()]),
        db.all(`SELECT h.id, h.title, h.due_date FROM class_homework h JOIN class_enrollments e ON e.class_id = h.class_id
            LEFT JOIN homework_submissions s ON s.homework_id = h.id AND s.student_id = e.student_id
            WHERE e.student_id = ? AND e.status = 'active' AND h.status IN ('published', 'assigned') AND s.id IS NULL ORDER BY h.due_date LIMIT 5`, [userId]),
        db.all('SELECT task_key FROM learning_checkins WHERE user_id = ? AND day = ?', [userId, day]),
        db.all('SELECT topic, score, total FROM quiz_attempts WHERE user_id = ? AND total > 0 ORDER BY created_at DESC LIMIT 40', [userId])
    ]);
    const due = mistakes.filter(m => m.due_at <= new Date().toISOString());
    const tasks = [];
    if (due.length) tasks.push({ key: 'mistakes', title: `Retest ${Math.min(due.length, 5)} ${due.length === 1 ? 'mistake' : 'mistakes'}`, reason: 'Retrieval practice for questions you missed.', minutes: 10, action: 'mistakes' });
    if (dueCards.n) tasks.push({ key: 'flashcards', title: `Review ${Math.min(dueCards.n, 10)} due flashcards`, reason: 'Your spaced-repetition cards are ready.', minutes: 5, action: 'flashcards' });
    homework.forEach(h => tasks.push({ key: 'homework:' + h.id, title: h.title, reason: h.due_date ? 'Homework due ' + String(h.due_date).slice(0, 10) : 'Unsubmitted class homework', minutes: 20, action: 'classroom' }));
    const evidence = new Map();
    attempts.forEach(a => { const key = a.topic.trim().toLowerCase(); const v = evidence.get(key) || { topic: a.topic, score: 0, total: 0, attempts: 0 }; v.score += a.score; v.total += a.total; v.attempts++; evidence.set(key, v); });
    const topics = [...evidence.values()].map(t => ({ ...t, accuracy: Math.round(100 * t.score / t.total) })).sort((a,b) => a.accuracy - b.accuracy);
    const activeGoals = goals.filter(g => g.exam_date >= day);
    activeGoals.forEach(g => {
        const syllabus = JSON.parse(g.topics);
        const weak = topics.find(t => syllabus.some(s => s.toLowerCase() === t.topic.toLowerCase()));
        const daysLeft = Math.max(1, Math.ceil((Date.parse(g.exam_date) - Date.parse(day)) / 86400000));
        const topic = weak?.topic || syllabus[Math.floor(Date.parse(day) / 86400000) % syllabus.length];
        tasks.push({ key: 'goal:' + g.id, title: `Practice ${topic}`, reason: `${g.title} · ${daysLeft} day${daysLeft === 1 ? '' : 's'} left${weak ? ' · selected from recent quiz evidence' : ' · rotating through your syllabus'}`, minutes: g.minutes, action: 'quiz-generator', topic });
    });
    if (!tasks.length) tasks.push({ key: 'baseline', title: 'Take a baseline quiz', reason: 'Start with a topic you want to improve. Your results will shape your next steps.', minutes: 10, action: 'quiz-generator' });
    const done = new Set(checked.map(c => c.task_key));
    return { goals: goals.map(g => ({ ...g, topics: JSON.parse(g.topics) })), tasks: tasks.map(t => ({ ...t, completed: done.has(t.key) })), topics,
        stats: { dueMistakes: due.length, openMistakes: mistakes.length, dueCards: dueCards.n, activeGoals: activeGoals.length }, day };
}
router.get('/dashboard', route(async (req, res) => {
    const day = req.query.day || new Date().toISOString().slice(0, 10);
    if (!dayValid(day)) throw learning.httpError(400, 'Invalid calendar date.');
    res.json(await dashboard(req.user.id, day));
}));
router.post('/goals', route(async (req, res) => {
    const { title, examDate, minutes, topics } = req.body;
    const clean = [...new Set((Array.isArray(topics) ? topics : []).filter(t => typeof t === 'string').map(t => t.trim()).filter(Boolean))];
    if (typeof title !== 'string' || !title.trim() || title.length > 160 || !dayValid(examDate) || examDate < new Date(Date.now()-86400000).toISOString().slice(0,10) || !Number.isInteger(minutes) || minutes < 10 || minutes > 240 || !clean.length || clean.length > 30 || clean.some(t => t.length > 120)) throw learning.httpError(400, 'Add a title, current or future exam date, 10–240 daily minutes, and 1–30 topics.');
    const id = randomUUID();
    await db.run('INSERT INTO learning_goals (id, user_id, title, exam_date, minutes, topics, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, req.user.id, title.trim(), examDate, minutes, JSON.stringify(clean), new Date().toISOString()]);
    res.json({ success: true, id });
}));
router.delete('/goals/:id', route(async (req, res) => {
    await db.run('DELETE FROM learning_goals WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]); res.json({ success: true });
}));
router.post('/checkins', route(async (req, res) => {
    const { day, taskKey, completed } = req.body;
    if (!dayValid(day) || typeof completed !== 'boolean') throw learning.httpError(400, 'Invalid check-in.');
    const plan = await dashboard(req.user.id, day);
    if (!plan.tasks.some(t => t.key === taskKey)) throw learning.httpError(400, 'Task is no longer in this plan.');
    if (completed) await db.run('INSERT IGNORE INTO learning_checkins (user_id, day, task_key) VALUES (?, ?, ?)', [req.user.id, day, taskKey]);
    else await db.run('DELETE FROM learning_checkins WHERE user_id = ? AND day = ? AND task_key = ?', [req.user.id, day, taskKey]);
    res.json({ success: true });
}));
router.get('/mistakes', route(async (req, res) => {
    const rows = await db.all('SELECT id, topic, question, options_json, due_at, successes, reviews, resolved FROM learning_mistakes WHERE user_id = ? ORDER BY resolved, due_at LIMIT 200', [req.user.id]);
    res.json({ mistakes: rows.map(({ options_json, ...m }) => ({ ...m, options: JSON.parse(options_json) })) });
}));
router.post('/mistakes/:id/review', route(async (req, res) => {
    const answer = req.body.answer;
    if (!Number.isInteger(answer) || answer < 0 || answer > 3) throw learning.httpError(400, 'Choose one answer.');
    const result = await db.transaction(async () => {
        const m = await db.get('SELECT * FROM learning_mistakes WHERE id = ? AND user_id = ?' + (db.dialect() === 'mysql' ? ' FOR UPDATE' : ''), [req.params.id, req.user.id]);
        if (!m) throw learning.httpError(404, 'Mistake not found.');
        if (m.resolved || m.due_at > new Date().toISOString()) throw learning.httpError(409, 'This question is not due yet. Come back at the next review.');
        const correct = answer === m.correct_index;
        const successes = correct ? m.successes + 1 : 0;
        const days = correct ? [1, 3, 7][Math.min(successes - 1, 2)] : 0.007;
        const dueAt = new Date(Date.now() + days * 86400000).toISOString();
        await db.run('UPDATE learning_mistakes SET successes = ?, reviews = reviews + 1, resolved = ?, due_at = ?, answer_index = ? WHERE id = ?', [successes, successes >= 3 ? 1 : 0, dueAt, answer, m.id]);
        return { correct, correctIndex: m.correct_index, explanation: m.explanation, dueAt, resolved: successes >= 3 };
    });
    res.json(result);
}));
router.get('/export', route(async (req, res) => {
    const userId = req.user.id;
    const [goals, mistakes, attempts, checkins] = await Promise.all([
        db.all('SELECT title, exam_date, minutes, topics FROM learning_goals WHERE user_id = ?', [userId]),
        db.all('SELECT topic, question, explanation, due_at, successes, reviews, resolved FROM learning_mistakes WHERE user_id = ?', [userId]),
        db.all('SELECT topic, score, total, created_at FROM quiz_attempts WHERE user_id = ? ORDER BY created_at DESC', [userId]),
        db.all('SELECT day, task_key FROM learning_checkins WHERE user_id = ?', [userId])
    ]);
    res.json({ exportedAt: new Date().toISOString(), goals, mistakes, attempts, checkins });
}));
module.exports = router;
