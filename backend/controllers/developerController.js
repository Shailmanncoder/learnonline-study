// ================================================================
// Developer Hub storage
// ----------------------------------------------------------------
// The Hub's skills and practice history used to live in localStorage.
// That meant the data existed only in one browser: signing in on a
// phone showed an empty Hub, and clearing site data wiped the record
// permanently. It also could never be reported on, because the server
// had never seen it.
//
// Everything is scoped to the signed-in account's own id. There is no
// id taken from the client that is not re-checked against it, so one
// account can neither read nor delete another's rows.
// ================================================================
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const db = require('../config/db');

const LEVELS = ['Beginner', 'Intermediate', 'Advanced', 'Expert'];
const KINDS = ['test', 'review'];
const MAX_SKILLS = 40;

function cleanText(value, max) {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// The whole Hub state in one reply, so every mutation can return the new
// truth and the client never has to reassemble it from pieces.
async function snapshot(userId) {
    const [skills, events, counts] = await Promise.all([
        db.all('SELECT id, name, level FROM developer_skills WHERE user_id = ? ORDER BY id', [userId]),
        db.all('SELECT kind, title, detail, created_at FROM developer_events WHERE user_id = ? ORDER BY id DESC LIMIT 20', [userId]),
        db.all('SELECT kind, COUNT(*) AS n FROM developer_events WHERE user_id = ? GROUP BY kind', [userId])
    ]);
    const byKind = Object.fromEntries((counts || []).map(r => [r.kind, Number(r.n) || 0]));
    return {
        skills: skills || [],
        progress: {
            // Counted from the log itself rather than kept as separate
            // counters, so the dashboard number and the history below it
            // always agree.
            tests: byKind.test || 0,
            reviews: byKind.review || 0,
            events: (events || []).map(e => ({
                kind: e.kind,
                title: e.title,
                detail: e.detail || '',
                time: Date.parse(`${String(e.created_at).replace(' ', 'T')}Z`) || Date.now()
            }))
        }
    };
}

// @route  GET api/developer
router.get('/', auth, async (req, res) => {
    try {
        res.json(await snapshot(req.user.id));
    } catch (err) {
        console.error('[DEVHUB] load failed:', err.message);
        res.status(500).json({ msg: 'Could not load your Developer Hub' });
    }
});

// @route  POST api/developer/skills
router.post('/skills', auth, async (req, res) => {
    try {
        const name = cleanText(req.body?.name, 80);
        if (!name) return res.status(400).json({ msg: 'Name the skill you want to add.' });
        const level = LEVELS.includes(req.body?.level) ? req.body.level : 'Intermediate';

        const existing = await db.get('SELECT id FROM developer_skills WHERE user_id = ? AND name = ?', [req.user.id, name]);
        // The browser version happily stored the same skill twice; the unique
        // constraint and this check mean adding it again just updates its level.
        if (existing) {
            await db.run('UPDATE developer_skills SET level = ? WHERE id = ? AND user_id = ?', [level, existing.id, req.user.id]);
            return res.json(await snapshot(req.user.id));
        }

        const count = await db.get('SELECT COUNT(*) AS n FROM developer_skills WHERE user_id = ?', [req.user.id]);
        if (Number(count?.n || 0) >= MAX_SKILLS) {
            return res.status(400).json({ msg: `That is ${MAX_SKILLS} skills — remove one before adding another.` });
        }
        await db.run('INSERT INTO developer_skills (user_id, name, level) VALUES (?, ?, ?)', [req.user.id, name, level]);
        res.status(201).json(await snapshot(req.user.id));
    } catch (err) {
        console.error('[DEVHUB] add skill failed:', err.message);
        res.status(500).json({ msg: 'Could not save that skill' });
    }
});

// @route  DELETE api/developer/skills/:id
router.delete('/skills/:id', auth, async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) return res.status(400).json({ msg: 'Unknown skill' });
        // Scoped by user_id as well as id: another account's skill is not found
        // rather than deleted.
        const own = await db.get('SELECT id FROM developer_skills WHERE id = ? AND user_id = ?', [id, req.user.id]);
        if (!own) return res.status(404).json({ msg: 'Skill not found' });
        await db.run('DELETE FROM developer_skills WHERE id = ? AND user_id = ?', [id, req.user.id]);
        res.json(await snapshot(req.user.id));
    } catch (err) {
        console.error('[DEVHUB] delete skill failed:', err.message);
        res.status(500).json({ msg: 'Could not remove that skill' });
    }
});

// @route  POST api/developer/events  — a completed mock test or code review
router.post('/events', auth, async (req, res) => {
    try {
        const kind = KINDS.includes(req.body?.kind) ? req.body.kind : null;
        if (!kind) return res.status(400).json({ msg: 'Unknown kind of activity.' });
        const title = cleanText(req.body?.title, 200) || (kind === 'test' ? 'Completed technical practice' : 'Code review');
        const detail = cleanText(req.body?.detail, 300);
        await db.run('INSERT INTO developer_events (user_id, kind, title, detail) VALUES (?, ?, ?, ?)',
            [req.user.id, kind, title, detail]);
        res.status(201).json(await snapshot(req.user.id));
    } catch (err) {
        console.error('[DEVHUB] record event failed:', err.message);
        res.status(500).json({ msg: 'Could not record that result' });
    }
});

// @route  POST api/developer/import  — one-time lift of a browser's old data
// Runs only while the account has nothing stored yet, so re-sending an old
// browser's copy later cannot resurrect or duplicate anything.
router.post('/import', auth, async (req, res) => {
    try {
        const current = await snapshot(req.user.id);
        if (current.skills.length || current.progress.events.length) {
            return res.json({ imported: false, reason: 'already has server data', ...current });
        }
        const skills = Array.isArray(req.body?.skills) ? req.body.skills.slice(0, MAX_SKILLS) : [];
        const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 50) : [];

        for (const s of skills) {
            const name = cleanText(s?.name, 80);
            if (!name) continue;
            const level = LEVELS.includes(s?.level) ? s.level : 'Intermediate';
            await db.run('INSERT OR IGNORE INTO developer_skills (user_id, name, level) VALUES (?, ?, ?)', [req.user.id, name, level]);
        }
        // Oldest first, so the server's own ordering matches the original.
        for (const e of [...events].reverse()) {
            if (!KINDS.includes(e?.kind)) continue;
            await db.run('INSERT INTO developer_events (user_id, kind, title, detail) VALUES (?, ?, ?, ?)',
                [req.user.id, e.kind, cleanText(e?.title, 200) || 'Practice', cleanText(e?.detail, 300)]);
        }
        res.json({ imported: true, ...(await snapshot(req.user.id)) });
    } catch (err) {
        console.error('[DEVHUB] import failed:', err.message);
        res.status(500).json({ msg: 'Could not import your previous Hub data' });
    }
});

module.exports = router;
