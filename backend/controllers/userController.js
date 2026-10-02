const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const db = require('../config/db');

// Helper: calculate day streak from activity records
async function calcStreak(userId) {
    const rows = await db.all(
        "SELECT DISTINCT DATE(created_at) as day FROM activity WHERE user_id = ? ORDER BY day DESC LIMIT 365",
        [userId]
    );
    if (!rows.length) return 0;
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const latest = rows[0].day;
    if (latest !== today && latest !== yesterday) return 0;
    let streak = 1;
    for (let i = 1; i < rows.length; i++) {
        const prev = new Date(new Date(rows[i - 1].day).getTime() - 86400000)
            .toISOString().split('T')[0];
        if (rows[i].day === prev) streak++;
        else break;
    }
    return streak;
}

// Helper: calculate today's study minutes (automatically refreshes every 24 hours / daily)
async function calcTodayStudyTime(userId) {
    const today = new Date().toISOString().split('T')[0];
    const row = await db.get(
        "SELECT COALESCE(SUM(time_spent), 0) as today_time FROM activity WHERE user_id = ? AND DATE(created_at) = ?",
        [userId, today]
    );
    return row ? Number(row.today_time) : 0;
}

// @route   GET api/user/profile
// @desc    Get current user profile & stats
router.get('/profile', auth, async (req, res) => {
    try {
        // `role` is included so the client can gate the teacher/developer portals.
        const user = await db.get('SELECT id, username, role, xp, level, time_spent, profile_picture, bio, created_at FROM users WHERE id = ?', [req.user.id]);
        if (!user) return res.status(404).json({ msg: 'User not found' });
        const streak = await calcStreak(req.user.id);
        const studied_today = await calcTodayStudyTime(req.user.id);
        res.json({ ...user, streak, studied_today });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ msg: 'Server Error' });
    }
});

// ── Continue learning ─────────────────────────────────────────────
// Real saved work this account can pick up again, newest first. Everything
// here is a row that already exists; nothing is invented, and when there is
// nothing to resume the list is empty so the dashboard can show a true empty
// state rather than a decorative placeholder.
// @route   GET api/user/continue
router.get('/continue', auth, async (req, res) => {
    const uid = req.user.id;
    const safe = async (fn) => { try { return await fn(); } catch (e) { return []; } };

    const [threads, decks, notes, roadmaps, quizzes] = await Promise.all([
        safe(() => db.all('SELECT id, title, updated_at FROM chat_threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT 3', [uid])),
        safe(() => db.all('SELECT id, title, card_count, created_at FROM flashcard_decks WHERE user_id = ? ORDER BY id DESC LIMIT 2', [uid])),
        safe(() => db.all('SELECT id, title, created_at FROM notes WHERE user_id = ? ORDER BY id DESC LIMIT 2', [uid])),
        safe(() => db.all("SELECT id, status, updated_at FROM studio_roadmaps WHERE user_id = ? AND status <> 'failed' ORDER BY updated_at DESC LIMIT 1", [uid])),
        safe(() => db.all('SELECT id, topic, score, total, created_at FROM quiz_attempts WHERE user_id = ? ORDER BY id DESC LIMIT 2', [uid]))
    ]);

    const items = [];
    for (const t of threads) items.push({ kind: 'chat', id: t.id, title: t.title || 'Untitled conversation', detail: 'AI Companion conversation', route: `/ai-chat`, at: t.updated_at });
    for (const r of roadmaps) items.push({ kind: 'roadmap', id: r.id, title: 'Your study roadmap', detail: `Plan is ${r.status}`, route: '/study-roadmap', at: r.updated_at });
    for (const d of decks) items.push({ kind: 'flashcards', id: d.id, title: d.title || 'Flashcard deck', detail: `${d.card_count || 0} cards`, route: '/flashcards', at: d.created_at });
    for (const n of notes) items.push({ kind: 'note', id: n.id, title: n.title || 'Untitled note', detail: 'Saved note', route: '/notes', at: n.created_at });
    for (const q of quizzes) items.push({ kind: 'quiz', id: q.id, title: q.topic || 'Practice quiz', detail: `Scored ${q.score}/${q.total}`, route: '/quiz-generator', at: q.created_at });

    items.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    res.json({ items: items.slice(0, 6) });
});

// ── Daily goals ───────────────────────────────────────────────────
// The dashboard's goal list is stored per account AND per date, so each day
// starts empty and previous days stay intact as a record. The date comes from
// the client because "today" is the student's local day, not the server's;
// it is validated strictly and never interpolated into SQL.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function goalDate(value) {
    const d = String(value || '').trim();
    if (DATE_RE.test(d) && !Number.isNaN(Date.parse(d))) return d;
    return new Date().toISOString().slice(0, 10);
}

// @route   GET api/user/goals?date=YYYY-MM-DD
router.get('/goals', auth, async (req, res) => {
    try {
        const date = goalDate(req.query.date);
        const rows = await db.all(
            'SELECT id, title, done, position FROM daily_goals WHERE user_id = ? AND goal_date = ? ORDER BY position, id',
            [req.user.id, date]
        );
        res.json({ date, goals: rows.map(r => ({ ...r, done: !!r.done })) });
    } catch (err) {
        console.error('[GOALS] list failed:', err.message);
        res.status(500).json({ msg: 'Could not load your goals' });
    }
});

// @route   POST api/user/goals
router.post('/goals', auth, async (req, res) => {
    try {
        const title = String(req.body?.title || '').trim().slice(0, 200);
        if (!title) return res.status(400).json({ msg: 'Write what you want to get done.' });
        const date = goalDate(req.body?.date);
        const count = await db.get('SELECT COUNT(*) AS n FROM daily_goals WHERE user_id = ? AND goal_date = ?', [req.user.id, date]);
        // A bounded list keeps the card readable and the table small.
        if (Number(count?.n || 0) >= 12) return res.status(400).json({ msg: 'That is twelve goals for one day — finish a few first.' });
        await db.run('INSERT INTO daily_goals (user_id, goal_date, title, done, position) VALUES (?, ?, ?, 0, ?)',
            [req.user.id, date, title, Number(count?.n || 0)]);
        const rows = await db.all('SELECT id, title, done, position FROM daily_goals WHERE user_id = ? AND goal_date = ? ORDER BY position, id', [req.user.id, date]);
        res.status(201).json({ date, goals: rows.map(r => ({ ...r, done: !!r.done })) });
    } catch (err) {
        console.error('[GOALS] create failed:', err.message);
        res.status(500).json({ msg: 'Could not save that goal' });
    }
});

// @route   PATCH api/user/goals/:id   — tick it off, or rename it
router.patch('/goals/:id', auth, async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) return res.status(400).json({ msg: 'Unknown goal' });
        // Scoped by user_id as well as id: another account's goal is simply not found.
        const own = await db.get('SELECT id, goal_date FROM daily_goals WHERE id = ? AND user_id = ?', [id, req.user.id]);
        if (!own) return res.status(404).json({ msg: 'Goal not found' });
        if (typeof req.body?.done === 'boolean') {
            await db.run('UPDATE daily_goals SET done = ? WHERE id = ? AND user_id = ?', [req.body.done ? 1 : 0, id, req.user.id]);
        }
        if (typeof req.body?.title === 'string') {
            const title = req.body.title.trim().slice(0, 200);
            if (!title) return res.status(400).json({ msg: 'A goal needs a name.' });
            await db.run('UPDATE daily_goals SET title = ? WHERE id = ? AND user_id = ?', [title, id, req.user.id]);
        }
        const rows = await db.all('SELECT id, title, done, position FROM daily_goals WHERE user_id = ? AND goal_date = ? ORDER BY position, id', [req.user.id, own.goal_date]);
        res.json({ date: own.goal_date, goals: rows.map(r => ({ ...r, done: !!r.done })) });
    } catch (err) {
        console.error('[GOALS] update failed:', err.message);
        res.status(500).json({ msg: 'Could not update that goal' });
    }
});

// @route   DELETE api/user/goals/:id
router.delete('/goals/:id', auth, async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) return res.status(400).json({ msg: 'Unknown goal' });
        const own = await db.get('SELECT id, goal_date FROM daily_goals WHERE id = ? AND user_id = ?', [id, req.user.id]);
        if (!own) return res.status(404).json({ msg: 'Goal not found' });
        await db.run('DELETE FROM daily_goals WHERE id = ? AND user_id = ?', [id, req.user.id]);
        const rows = await db.all('SELECT id, title, done, position FROM daily_goals WHERE user_id = ? AND goal_date = ? ORDER BY position, id', [req.user.id, own.goal_date]);
        res.json({ date: own.goal_date, goals: rows.map(r => ({ ...r, done: !!r.done })) });
    } catch (err) {
        console.error('[GOALS] delete failed:', err.message);
        res.status(500).json({ msg: 'Could not remove that goal' });
    }
});

// @route   POST api/user/profile
// @desc    Update user profile settings
router.post('/profile', auth, async (req, res) => {
    try {
        const { username, profile_picture, bio } = req.body;
        
        const normalizedProfilePicture =
            profile_picture == null || String(profile_picture).trim().length === 0
                ? null
                : String(profile_picture).trim();

        await db.run(
            'UPDATE users SET username = ?, profile_picture = ?, bio = ? WHERE id = ?',
            [username, normalizedProfilePicture, bio || '', req.user.id]
        );

        res.json({ msg: 'Profile updated successfully' });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ msg: 'Server Error (Username might be taken)' });
    }
});

// @route   POST api/user/xp
// @desc    Add XP and time to user
router.post('/xp', auth, async (req, res) => {
    try {
        const { xp, time, tool } = req.body;

        await db.run(
            'UPDATE users SET xp = xp + ?, time_spent = time_spent + ? WHERE id = ?',
            [xp || 0, time || 0, req.user.id]
        );

        const user = await db.get('SELECT xp, level, time_spent FROM users WHERE id = ?', [req.user.id]);
        const prevLevel = user.level;
        const newLevel = Math.floor(user.xp / 100) + 1;
        const leveledUp = newLevel > prevLevel;
        if (leveledUp) {
            await db.run('UPDATE users SET level = ? WHERE id = ?', [newLevel, req.user.id]);
        }

        if (tool) {
            await db.run(
                'INSERT INTO activity (user_id, tool_used, time_spent, xp_earned) VALUES (?, ?, ?, ?)',
                [req.user.id, tool, time || 0, xp || 0]
            );
        }

        const streak = await calcStreak(req.user.id);
        const studied_today = await calcTodayStudyTime(req.user.id);

        res.json({
            xp: user.xp,
            level: leveledUp ? newLevel : prevLevel,
            newTotal: user.xp,
            newLevel: leveledUp ? newLevel : prevLevel,
            levelUp: leveledUp,
            time_spent: user.time_spent,
            studied_today,
            streak
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ msg: 'Server Error' });
    }
});

// @route   GET api/user/notes
// @desc    Get all notes for user
router.get('/notes', auth, async (req, res) => {
    try {
        const notes = await db.all('SELECT * FROM notes WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]);
        res.json(notes);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ msg: 'Server Error' });
    }
});

// @route   POST api/user/notes
// @desc    Create a note
router.post('/notes', auth, async (req, res) => {
    try {
        const { title, content } = req.body;
        if (!title || !content) return res.status(400).json({ msg: 'Please provide title and content' });

        const result = await db.run(
            'INSERT INTO notes (user_id, title, content) VALUES (?, ?, ?)',
            [req.user.id, title, content]
        );

        res.json({ id: result.lastID, title, content });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ msg: 'Server Error' });
    }
});

// @route   GET api/user/leaderboard
// @desc    Get leaderboard (top 50) — always includes current user if token provided
router.get('/leaderboard', auth, async (req, res) => {
    try {
        // Student rankings must not disclose login emails or mix teacher scores.
        const publicEntry = user => ({
            id: user.id, username: user.id === req.user.id || !user.username.includes('@') ? user.username : `Learner ${user.id}`,
            xp: user.xp, level: user.level,
            profile_picture: user.id === req.user.id ? user.profile_picture : null,
            bio: user.id === req.user.id ? user.bio : ''
        });
        const rows = await db.all("SELECT id,username,xp,level,profile_picture,bio FROM users WHERE role = 'student' ORDER BY xp DESC,id ASC LIMIT 50");
        let currentUserRank = null;
        if (!rows.some(user => user.id === req.user.id)) {
            const me = await db.get("SELECT id,username,xp,level,profile_picture,bio FROM users WHERE id = ? AND role = 'student'", [req.user.id]);
            if (me) {
                const rank = await db.get("SELECT COUNT(*) n FROM users WHERE role = 'student' AND (xp > ? OR (xp = ? AND id < ?))", [me.xp, me.xp, me.id]);
                currentUserRank = { ...publicEntry(me), rank: rank.n + 1 };
            }
        }
        res.json({ leaders: rows.map(publicEntry), currentUserRank });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ msg: 'Server Error' });
    }
});

// @route   DELETE api/users/account
// @desc    Delete user account and all data
router.delete('/account', auth, async (req, res) => {
    try {
        const learning = require('../services/learning');
        await learning.ready();
        await require('./teachingStudioController').ready();
        await require('../services/teacherRequests').ready();
        await require('../services/studioStore').ready();
        await db.transaction(async () => {
            for (const table of ['studio_attempts','studio_coaching']) await db.run(`DELETE FROM ${table} WHERE user_id=? OR pack_id IN (SELECT id FROM studio_packs WHERE user_id=? OR class_id IN (SELECT id FROM classrooms WHERE created_by=?))`,[req.user.id,req.user.id,req.user.id]);
            await db.run('DELETE FROM studio_assignments WHERE student_id=? OR pack_id IN (SELECT id FROM studio_packs WHERE user_id=? OR class_id IN (SELECT id FROM classrooms WHERE created_by=?))',[req.user.id,req.user.id,req.user.id]);
            await db.run('DELETE FROM studio_packs WHERE user_id=? OR class_id IN (SELECT id FROM classrooms WHERE created_by=?)',[req.user.id,req.user.id]);
            await db.run('DELETE FROM studio_sources WHERE resource_id IN (SELECT id FROM teaching_resources WHERE teacher_id=? OR class_id IN (SELECT id FROM classrooms WHERE created_by=?))',[req.user.id,req.user.id]);
            await db.run('DELETE FROM studio_roadmaps WHERE user_id=?',[req.user.id]);
            await db.run('DELETE FROM studio_usage WHERE user_id=?',[req.user.id]);
            for (const table of ['learning_quizzes', 'learning_mistakes', 'learning_goals', 'learning_checkins', 'learning_rewards']) {
                await db.run(`DELETE FROM ${table} WHERE user_id = ?`, [req.user.id]);
            }
            for (const table of ['teaching_resources','teaching_drafts','teaching_attendance','teacher_join_requests']) {
                await db.run(`DELETE FROM ${table} WHERE teacher_id=? OR class_id IN (SELECT id FROM classrooms WHERE created_by=?)`,[req.user.id,req.user.id]);
            }
            await db.run('DELETE FROM teaching_attendance WHERE student_id=?',[req.user.id]);
            await db.run('DELETE FROM teaching_ai_usage WHERE teacher_id=?',[req.user.id]);
            await db.run('DELETE FROM notes WHERE user_id = ?', [req.user.id]);
            await db.run('DELETE FROM activity WHERE user_id = ?', [req.user.id]);
            await db.run('DELETE FROM users WHERE id = ?', [req.user.id]);
        });
        res.json({ msg: 'Account deleted successfully' });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ msg: 'Server Error' });
    }
});

module.exports = router;
