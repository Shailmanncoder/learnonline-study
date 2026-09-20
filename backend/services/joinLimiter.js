const db = require('../config/db');

// Class codes are six characters from a 32-character alphabet. That is a big
// space, but not so big that an account can be left guessing at it forever.
// Only *failed* guesses count, so a teacher running an onboarding session and
// a class of thirty students typing their own correct code are never limited.
const WINDOW_MINUTES = 10;
const MAX_FAILURES = 10;

async function joinAttemptsExhausted(userId) {
    try {
        const row = await db.get(
            `SELECT COUNT(*) AS failures FROM class_join_attempts
             WHERE user_id = ? AND succeeded = 0
               AND created_at >= ?`,
            [userId, new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString().slice(0, 19).replace('T', ' ')]
        );
        return Number(row && row.failures) >= MAX_FAILURES;
    } catch (err) {
        // A limiter that cannot read its own table must not lock people out of
        // their classes; the join itself is still authorised on its own terms.
        console.warn('[JOIN LIMIT] check failed:', err.message);
        return false;
    }
}

async function recordJoinAttempt(userId, succeeded) {
    try {
        await db.run(
            'INSERT INTO class_join_attempts (user_id, succeeded) VALUES (?, ?)',
            [userId, succeeded ? 1 : 0]
        );
        if (succeeded) {
            await db.run('DELETE FROM class_join_attempts WHERE user_id = ? AND succeeded = 0', [userId]);
        }
    } catch (err) {
        console.warn('[JOIN LIMIT] record failed:', err.message);
    }
}

module.exports = { joinAttemptsExhausted, recordJoinAttempt, MAX_FAILURES, WINDOW_MINUTES };
