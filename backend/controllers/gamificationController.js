const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const db = require('../config/db');

// Badge catalogue — key, label, icon (Font Awesome class), description, and the check function.
// Checks are cheap COUNT queries so this can safely run on every XP-earning action.
const BADGE_CATALOGUE = [
    {
        key: 'first_note',
        label: 'First Note',
        icon: 'fa-solid fa-pen',
        description: 'Saved your very first note.',
        check: async (userId) => {
            const row = await db.get('SELECT COUNT(*) as c FROM notes WHERE user_id = ?', [userId]);
            return (row?.c || 0) >= 1;
        }
    },
    {
        key: 'streak_3',
        label: 'Warming Up',
        icon: 'fa-solid fa-fire',
        description: '3-day study streak.',
        check: async (userId, ctx) => (ctx.streak || 0) >= 3
    },
    {
        key: 'streak_7',
        label: '7-Day Streak',
        icon: 'fa-solid fa-fire-flame-curved',
        description: 'Studied 7 days in a row. Consistency is paying off!',
        check: async (userId, ctx) => (ctx.streak || 0) >= 7
    },
    {
        key: 'streak_30',
        label: 'Unstoppable',
        icon: 'fa-solid fa-meteor',
        description: '30-day study streak. Incredible dedication.',
        check: async (userId, ctx) => (ctx.streak || 0) >= 30
    },
    {
        key: 'quiz_10',
        label: 'Quiz Whiz',
        icon: 'fa-solid fa-lightbulb',
        description: 'Answered 100+ quiz questions across all attempts.',
        check: async (userId) => {
            const row = await db.get('SELECT COALESCE(SUM(total),0) as c FROM quiz_attempts WHERE user_id = ?', [userId]);
            return (row?.c || 0) >= 100;
        }
    },
    {
        key: 'quiz_perfect',
        label: 'Perfect Score',
        icon: 'fa-solid fa-star',
        description: 'Got a 100% score on a quiz.',
        check: async (userId) => {
            const row = await db.get('SELECT COUNT(*) as c FROM quiz_attempts WHERE user_id = ? AND total > 0 AND score = total', [userId]);
            return (row?.c || 0) >= 1;
        }
    },
    {
        key: 'flashcard_deck',
        label: 'Deck Builder',
        icon: 'fa-solid fa-layer-group',
        description: 'Created your first flashcard deck.',
        check: async (userId) => {
            const row = await db.get('SELECT COUNT(*) as c FROM flashcard_decks WHERE user_id = ?', [userId]);
            return (row?.c || 0) >= 1;
        }
    },
    {
        key: 'level_5',
        label: 'Rising Scholar',
        icon: 'fa-solid fa-graduation-cap',
        description: 'Reached Level 5.',
        check: async (userId, ctx) => (ctx.level || 0) >= 5
    },
    {
        key: 'level_10',
        label: 'Diamond Scholar',
        icon: 'fa-solid fa-gem',
        description: 'Reached Level 10 — top-tier dedication.',
        check: async (userId, ctx) => (ctx.level || 0) >= 10
    }
];

async function calcStreakForUser(userId) {
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
        const prev = new Date(new Date(rows[i - 1].day).getTime() - 86400000).toISOString().split('T')[0];
        if (rows[i].day === prev) streak++;
        else break;
    }
    return streak;
}

// Checks every badge for a user and awards any newly-earned ones.
// Returns the list of badges that were newly awarded this call (for celebratory UI).
async function checkAndAwardBadges(userId) {
    const user = await db.get('SELECT level FROM users WHERE id = ?', [userId]);
    const streak = await calcStreakForUser(userId);
    const ctx = { streak, level: user?.level || 1 };

    const alreadyEarned = await db.all('SELECT badge_key FROM user_badges WHERE user_id = ?', [userId]);
    const earnedKeys = new Set(alreadyEarned.map(r => r.badge_key));

    const newlyAwarded = [];
    for (const badge of BADGE_CATALOGUE) {
        if (earnedKeys.has(badge.key)) continue;
        try {
            const qualifies = await badge.check(userId, ctx);
            if (qualifies) {
                const insertSql = db.dialect() === 'mysql'
                    ? 'INSERT IGNORE INTO user_badges (user_id, badge_key) VALUES (?, ?)'
                    : 'INSERT OR IGNORE INTO user_badges (user_id, badge_key) VALUES (?, ?)';
                await db.run(insertSql, [userId, badge.key]);
                newlyAwarded.push(badge);
            }
        } catch (e) {
            console.warn(`[BADGE CHECK] ${badge.key} failed:`, e.message);
        }
    }
    return newlyAwarded;
}

// @route  GET /api/gamification/badges
// @desc   All badges, marked earned/locked, for the profile page
router.get('/badges', auth, async (req, res) => {
    try {
        await checkAndAwardBadges(req.user.id);
        const earned = await db.all('SELECT badge_key, earned_at FROM user_badges WHERE user_id = ?', [req.user.id]);
        const earnedMap = new Map(earned.map(r => [r.badge_key, r.earned_at]));

        const badges = BADGE_CATALOGUE.map(b => ({
            key: b.key,
            label: b.label,
            icon: b.icon,
            description: b.description,
            earned: earnedMap.has(b.key),
            earned_at: earnedMap.get(b.key) || null
        }));

        res.json({ badges, earnedCount: earned.length, totalCount: BADGE_CATALOGUE.length });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ msg: 'Server error' });
    }
});

// @route  POST /api/gamification/badges/check
// @desc   Call after any XP-earning action to award new badges immediately (returns only the NEW ones)
router.post('/badges/check', auth, async (req, res) => {
    try {
        const newlyAwarded = await checkAndAwardBadges(req.user.id);
        res.json({ newlyAwarded });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ msg: 'Server error' });
    }
});

// @route  GET /api/gamification/streak
// @desc   Current streak + freeze count, for the dashboard flame widget
router.get('/streak', auth, async (req, res) => {
    try {
        const streak = await calcStreakForUser(req.user.id);
        const user = await db.get('SELECT streak_freezes FROM users WHERE id = ?', [req.user.id]);
        res.json({ streak, streak_freezes: user?.streak_freezes ?? 1 });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ msg: 'Server error' });
    }
});

// @route  POST /api/gamification/streak/use-freeze
// @desc   Spend a streak freeze to protect today's streak if the user hasn't studied yet.
//         This logs a same-day activity row (0 XP) so the streak calc treats today as covered.
router.post('/streak/use-freeze', auth, async (req, res) => {
    try {
        const user = await db.get('SELECT streak_freezes, last_freeze_used_at FROM users WHERE id = ?', [req.user.id]);
        if (!user || (user.streak_freezes || 0) <= 0) {
            return res.status(400).json({ msg: "You're out of streak freezes for now." });
        }

        const today = new Date().toISOString().split('T')[0];
        const alreadyActiveToday = await db.get(
            "SELECT COUNT(*) as c FROM activity WHERE user_id = ? AND DATE(created_at) = ?",
            [req.user.id, today]
        );
        if ((alreadyActiveToday?.c || 0) > 0) {
            return res.status(400).json({ msg: "You've already studied today — no need for a freeze!" });
        }

        await db.run(
            'INSERT INTO activity (user_id, tool_used, time_spent, xp_earned) VALUES (?, ?, ?, ?)',
            [req.user.id, 'Streak Freeze', 0, 0]
        );
        await db.run(
            'UPDATE users SET streak_freezes = streak_freezes - 1, last_freeze_used_at = ? WHERE id = ?',
            [new Date().toISOString(), req.user.id]
        );

        const streak = await calcStreakForUser(req.user.id);
        res.json({ success: true, streak, message: 'Nice save! Your streak is protected for today.' });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ msg: 'Server error' });
    }
});

module.exports = router;
