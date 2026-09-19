// ================================================================
// Study memory for the AI Companion
// ----------------------------------------------------------------
// Two kinds of memory, both injected as a system message:
//
//   1. Derived context — pulled live from the student's real record
//      (level, classes, recent scores, and the misconceptions the
//      grading engine already identified). Never stale, never wrong.
//   2. Durable facts — things the student told the tutor that should
//      outlive the conversation ("I'm Class 10 CBSE", "boards in March").
//
// Kept deliberately small: this rides on every request and the
// on-demand tier caps total tokens per minute.
// ================================================================
const db = require('../config/db');

const MAX_FACTS = 12;

async function getFacts(userId) {
    try {
        return await db.all(
            'SELECT mem_key, mem_value FROM user_memory WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?',
            [userId, MAX_FACTS]
        );
    } catch (e) {
        return [];
    }
}

async function rememberFact(userId, key, value, source = 'chat') {
    const k = String(key || '').trim().slice(0, 80);
    const v = String(value || '').trim().slice(0, 400);
    if (!k || !v) return;
    try {
        // Upsert without relying on dialect-specific syntax.
        const existing = await db.get('SELECT id FROM user_memory WHERE user_id = ? AND mem_key = ?', [userId, k]);
        if (existing) {
            await db.run('UPDATE user_memory SET mem_value = ?, source = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [v, source, existing.id]);
        } else {
            await db.run('INSERT INTO user_memory (user_id, mem_key, mem_value, source) VALUES (?, ?, ?, ?)', [userId, k, v, source]);
        }
    } catch (e) {
        console.warn('[MEMORY] could not store fact:', e.message);
    }
}

async function forgetFact(userId, key) {
    try {
        await db.run('DELETE FROM user_memory WHERE user_id = ? AND mem_key = ?', [userId, key]);
    } catch (e) { /* non-fatal */ }
}

// The weak spots the grading engine already worked out, so the tutor can
// open with what the student actually got wrong instead of guessing.
async function getWeakTopics(userId, limit = 5) {
    try {
        const attempts = await db.all(
            `SELECT wa.breakdown, w.title, w.topic, w.worksheet_data
             FROM worksheet_attempts wa
             JOIN class_worksheets w ON w.id = wa.worksheet_id
             WHERE wa.student_id = ? AND wa.breakdown IS NOT NULL
             ORDER BY wa.submitted_at DESC LIMIT 8`,
            [userId]
        );

        const missed = [];
        for (const a of attempts) {
            let rows = [];
            try { rows = JSON.parse(a.breakdown) || []; } catch (e) { continue; }
            let questions = [];
            try { questions = (JSON.parse(a.worksheet_data) || {}).questions || []; } catch (e) { questions = []; }

            rows.filter(r => r.correct === false).forEach((r) => {
                const q = questions.find(x => String(x.id) === String(r.id));
                missed.push({
                    topic: a.topic || a.title,
                    question: q ? String(q.question).slice(0, 110) : null,
                    gave: r.answer == null ? null : String(r.answer).slice(0, 60),
                    correct: q ? String(q.correct_answer).slice(0, 60) : null
                });
            });
        }
        return missed.slice(0, limit);
    } catch (e) {
        return [];
    }
}

// Board / class / subject drive syllabus grounding. Stored as ordinary
// memory facts so they survive alongside everything else the tutor knows.
const SYLLABUS_KEYS = ['board', 'class', 'subject'];

function buildSyllabusDirective(facts) {
    const get = (k) => {
        const f = facts.find(x => x.mem_key === k);
        return f ? f.mem_value : null;
    };
    const board = get('board');
    const cls = get('class');
    const subject = get('subject');
    if (!board && !cls) return null;

    const who = [cls ? `Class ${cls}` : null, subject, board].filter(Boolean).join(' ');
    return [
        `SYLLABUS: This student follows the ${who} syllabus.`,
        `- Answer within that syllabus, using the terminology, definitions and units their textbook uses.`,
        board && /ncert|cbse/i.test(board)
            ? `- Follow the NCERT textbook for this class and subject. Name the relevant chapter when you can.`
            : `- Follow the prescribed ${board} textbook for this class and subject.`,
        `- Match the depth expected at this level: do not introduce concepts from higher classes unless asked.`,
        `- If a question falls outside this syllabus, say so plainly, then answer briefly anyway.`
    ].filter(Boolean).join('\n');
}

async function buildStudyContext(userId) {
    const [user, classes, recent, weak, facts] = await Promise.all([
        db.get('SELECT username, xp, level, streak_freezes FROM users WHERE id = ?', [userId]).catch(() => null),
        db.all(
            `SELECT c.name, c.section, c.subject, c.grade
             FROM class_enrollments ce JOIN classrooms c ON c.id = ce.class_id
             WHERE ce.student_id = ? AND ce.status = 'active' LIMIT 5`,
            [userId]
        ).catch(() => []),
        db.all(
            `SELECT w.title, wa.score, wa.total_marks
             FROM worksheet_attempts wa JOIN class_worksheets w ON w.id = wa.worksheet_id
             WHERE wa.student_id = ? ORDER BY wa.submitted_at DESC LIMIT 3`,
            [userId]
        ).catch(() => []),
        getWeakTopics(userId),
        getFacts(userId)
    ]);

    const lines = [];
    const name = user && user.username
        ? (user.username.includes('@') ? user.username.split('@')[0] : user.username)
        : 'the student';
    lines.push(`Student: ${name}${user ? ` (Level ${user.level}, ${user.xp} XP)` : ''}.`);

    if (classes.length) {
        lines.push(`Enrolled in: ${classes.map(c => `${c.name}${c.section ? '-' + c.section : ''} (${c.subject || 'general'})`).join(', ')}.`);
    }
    if (recent.length) {
        lines.push(`Recent worksheet scores: ${recent.map(r => `${r.title} ${r.score}/${r.total_marks}`).join('; ')}.`);
    }
    if (weak.length) {
        lines.push('Known weak spots (from their graded work) — reference these when relevant:');
        weak.forEach((w) => {
            lines.push(`  • ${w.topic}: got "${w.question || 'a question'}" wrong` +
                (w.gave && w.correct ? ` — answered "${w.gave}", correct was "${w.correct}".` : '.'));
        });
    }
    const otherFacts = facts.filter(f => !SYLLABUS_KEYS.includes(f.mem_key));
    if (otherFacts.length) {
        lines.push('Remembered about this student:');
        otherFacts.forEach(f => lines.push(`  • ${f.mem_key}: ${f.mem_value}`));
    }

    const syllabus = buildSyllabusDirective(facts);
    if (lines.length <= 1 && !classes.length && !syllabus) return null;

    const context = `CONTEXT ABOUT THIS STUDENT (use naturally; never read it back as a list, never claim to know things not listed here):\n${lines.join('\n')}`;
    return syllabus ? `${syllabus}\n\n${context}` : context;
}

module.exports = { buildStudyContext, getFacts, rememberFact, forgetFact, getWeakTopics, SYLLABUS_KEYS };
