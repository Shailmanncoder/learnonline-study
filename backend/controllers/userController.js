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
