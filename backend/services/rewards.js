const db = require('../config/db');

// XP is paid against a key that names the thing completed — worksheet:42,
// homework:7 — not the request that reported it. A retried submission, a
// regrade and a resubmission all reuse the key, so the unique constraint on
// (user_id, reward_key) is what makes the payment happen once. Relying on
// "did we already insert an attempt?" instead would pay twice whenever two
// requests raced.
//
// Call inside the caller's transaction so the XP and the work it is for commit
// together, or neither does.
async function grantOnce(userId, rewardKey, xp, reason = '') {
    const amount = Math.max(0, Math.round(Number(xp) || 0));
    try {
        await db.run(
            'INSERT INTO reward_grants (user_id, reward_key, xp, reason) VALUES (?, ?, ?, ?)',
            [userId, rewardKey, amount, String(reason).slice(0, 250)]
        );
    } catch (err) {
        // Already paid for this key.
        if (/unique|duplicate/i.test(err.message)) return { granted: false, xp: 0 };
        throw err;
    }
    if (amount > 0) {
        await db.run('UPDATE users SET xp = xp + ? WHERE id = ?', [amount, userId]);
    }
    return { granted: true, xp: amount };
}

async function alreadyGranted(userId, rewardKey) {
    const row = await db.get(
        'SELECT xp FROM reward_grants WHERE user_id = ? AND reward_key = ?',
        [userId, rewardKey]
    );
    return row ? { granted: true, xp: row.xp } : { granted: false, xp: 0 };
}

module.exports = { grantOnce, alreadyGranted };
