const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const db = require('../config/db');
const bcrypt = require('bcryptjs');

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
        const user = await db.get('SELECT id, username, email, email_verified_at, role, xp, level, time_spent, profile_picture, bio, created_at FROM users WHERE id = ?', [req.user.id]);
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

// Deliberately permissive about shape, strict about content. Anything that
// gets near an address people can reset an account with is checked properly.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// @route   POST api/user/profile
// @desc    Update user profile settings
router.post('/profile', auth, async (req, res) => {
    try {
        const body = req.body || {};
        const sets = [];
        const values = [];

        // Only fields actually present are touched. This used to write all
        // three unconditionally, so a client saving just a bio sent
        // username = undefined and the UPDATE failed against NOT NULL --
        // and nothing validated the username it did send.
        if ('username' in body) {
            const username = String(body.username ?? '').trim();
            if (!username || username.length > 50) {
                return res.status(400).json({ msg: 'Choose a username between 1 and 50 characters.' });
            }
            const taken = await db.get('SELECT id FROM users WHERE username = ? AND id <> ?', [username, req.user.id]);
            if (taken) return res.status(409).json({ msg: 'That username is already taken.' });
            sets.push('username = ?'); values.push(username);
        }

        // Email is NOT settable here. It goes through /user/email, which sends
        // a code and only writes the address once it has been confirmed --
        // otherwise an ordinary profile save could replace a verified address
        // with a typo, and reset codes would go to a stranger.

        if ('profile_picture' in body) {
            const picture = body.profile_picture == null || String(body.profile_picture).trim().length === 0
                ? null
                : String(body.profile_picture).trim();
            sets.push('profile_picture = ?'); values.push(picture);
        }

        if ('bio' in body) {
            sets.push('bio = ?'); values.push(String(body.bio ?? '').slice(0, 2000));
        }

        if (!sets.length) return res.status(400).json({ msg: 'Nothing to update.' });

        values.push(req.user.id);
        await db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, values);

        const user = await db.get('SELECT id, username, email, email_verified_at, role, profile_picture, bio FROM users WHERE id = ?', [req.user.id]);
        res.json({ msg: 'Profile updated successfully', user });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ msg: 'Could not save your profile. Please try again.' });
    }
});

// @route   GET api/user/usage
// @desc    This month's allowance, what is left, and what the plan opens.
// The screen and the enforcement read the same numbers from the same place,
// so a meter can never disagree with the limit that actually applies.
router.get('/usage', auth, async (req, res) => {
    try {
        const usage = require('../services/usage');
        const ent = require('../services/entitlements');
        const planId = await usage.planOf(req.user.id);
        const state = await usage.balance(req.user.id, planId);
        const tier = ent.tierOf(planId);
        // Which plan opens each tool, for every tool — so a locked one can be
        // marked before someone fills in its form, rather than only after they
        // press Generate.
        const unlocks = {};
        for (const id of ent.TOOL_ORDER) {
            if (!ent.toolAllowed(tier, id)) unlocks[id] = ent.requiredTierFor(id).label;
        }
        res.json({
            ...state,
            enforced: ent.enforced(),
            toolCount: tier.tools === 'all' ? ent.TOOL_ORDER.length : tier.tools,
            tools: ent.toolsFor(tier),
            locked: unlocks,
            costs: ent.COST
        });
    } catch (err) {
        console.error('[USER] usage failed:', err.message);
        res.status(500).json({ msg: 'Could not load your usage.' });
    }
});

// @route   GET api/user/tool-runs
// @desc    Past runs of one tool: the inputs you gave, with the output.
// This is what a tool has that a conversation does not — a run you can reopen
// and repeat without retyping the form.
router.get('/tool-runs', auth, async (req, res) => {
    try {
        await require('../migrations/006_tool_runs')(db);
        const toolId = String(req.query.tool || '').slice(0, 60);
        if (!toolId) return res.status(400).json({ msg: 'Which tool?' });
        const rows = await db.all(
            'SELECT id, tool_id, inputs, output, created_at FROM tool_runs WHERE user_id = ? AND tool_id = ? ORDER BY created_at DESC LIMIT 20',
            [req.user.id, toolId]
        );
        res.json({
            runs: rows.map(r => ({
                id: r.id, toolId: r.tool_id, createdAt: Number(r.created_at),
                inputs: (() => { try { return r.inputs ? JSON.parse(r.inputs) : null; } catch { return null; } })(),
                output: r.output || ''
            }))
        });
    } catch (err) {
        console.error('[USER] tool runs failed:', err.message);
        res.status(500).json({ msg: 'Could not load your past runs.' });
    }
});

// @route   DELETE api/user/tool-runs/:id
router.delete('/tool-runs/:id', auth, async (req, res) => {
    try {
        await require('../migrations/006_tool_runs')(db);
        // Scoped by user_id, so another account's run id is a 404, not a delete.
        const result = await db.run('DELETE FROM tool_runs WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        if (!result.changes) return res.status(404).json({ msg: 'Run not found.' });
        res.json({ ok: true });
    } catch (err) {
        console.error('[USER] delete run failed:', err.message);
        res.status(500).json({ msg: 'Could not delete that run.' });
    }
});

// ── Recovery email ────────────────────────────────────────────────
// Changing it is two steps: ask for a code, then confirm it. The new address
// is held in email_verifications until confirmed, so a half-finished change
// never disturbs an address that already works. Only a CONFIRMED address
// receives password reset codes.
const crypto = require('node:crypto');
const mailer = require('../services/mailer');
const { rateLimit } = require('../middleware/rateLimit');

let emailSchema;
const ensureEmailSchema = () => (emailSchema ||= require('../migrations/004_email_verification')(db));

const VERIFY_TTL_MS = 15 * 60_000;
const VERIFY_MAX_TRIES = 5;

const emailSendLimit = rateLimit({
    name: 'email-verify-send', windowMs: 60 * 60_000, max: 6,
    message: 'Too many verification emails. Please wait a while before trying again.'
});
const emailCheckLimit = rateLimit({
    name: 'email-verify-check', windowMs: 15 * 60_000, max: 10,
    message: 'Too many attempts. Please wait a few minutes.'
});

// @route   POST api/user/email
// @desc    Start (or cancel) a recovery-email change
router.post('/email', auth, emailSendLimit, async (req, res) => {
    try {
        await ensureEmailSchema();
        const raw = String((req.body || {}).email ?? '').trim();

        // Removing the address is immediate: it takes capability away rather
        // than granting it, so there is nothing to prove.
        if (!raw) {
            await db.run('UPDATE users SET email = NULL, email_verified_at = NULL WHERE id = ?', [req.user.id]);
            await db.run('DELETE FROM email_verifications WHERE user_id = ? AND used_at IS NULL', [req.user.id]);
            return res.json({ msg: 'Recovery email removed.', email: null, emailVerified: false, pendingEmail: null });
        }

        const email = raw.toLowerCase();
        if (email.length > 254 || !EMAIL_RE.test(email)) {
            return res.status(400).json({ msg: 'Enter a valid email address.' });
        }
        // A reset looks an account up by username OR email, so an address must
        // not be ambiguous between two accounts. Checked at send AND again at
        // confirm, because somebody else could claim it in between.
        const clash = await db.get(
            'SELECT id FROM users WHERE (email = ? OR username = ?) AND id <> ?',
            [email, email, req.user.id]
        );
        if (clash) return res.status(409).json({ msg: 'That email is already in use on another account.' });

        const me = await db.get('SELECT email, email_verified_at FROM users WHERE id = ?', [req.user.id]);
        if (me && me.email === email && me.email_verified_at) {
            return res.json({ msg: 'That address is already verified.', email, emailVerified: true, pendingEmail: null });
        }

        const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
        const now = Date.now();
        const codeHash = await bcrypt.hash(code, 10);
        await db.run('DELETE FROM email_verifications WHERE user_id = ? AND used_at IS NULL', [req.user.id]);
        await db.run(
            'INSERT INTO email_verifications (id, user_id, email, code_hash, created_at, expires_at, attempts) VALUES (?, ?, ?, ?, ?, ?, 0)',
            [crypto.randomUUID(), req.user.id, email, codeHash, now, now + VERIFY_TTL_MS]
        );

        if (!mailer.isWorking()) {
            if (process.env.NODE_ENV !== 'production') {
                console.log(`[USER] email verification code for user ${req.user.id}: ${code} (SMTP not configured)`);
            } else {
                console.error('[USER] email verification requested but SMTP is not configured; no email sent');
            }
            return res.json({
                msg: 'Email delivery is not configured on this server, so no code was sent.',
                emailConfigured: false, pendingEmail: email, emailVerified: false
            });
        }

        try {
            await mailer.send({
                to: email,
                subject: 'Confirm your LearnOnline.study recovery email',
                text: `Your confirmation code is ${code}\n\n`
                    + `Enter it on your profile to finish adding this address. It expires in 15 minutes.\n\n`
                    + `If you did not ask for this, you can ignore this email — nothing has changed.`
            });
        } catch (err) {
            console.error('[USER] verification email failed:', err.message);
            return res.status(502).json({ msg: 'We could not send to that address. Check it and try again.' });
        }

        res.json({ msg: `We sent a 6-digit code to ${email}. It expires in 15 minutes.`,
                   emailConfigured: true, pendingEmail: email, emailVerified: false });
    } catch (err) {
        console.error('[USER] email change failed:', err.message);
        res.status(500).json({ msg: 'Could not start the email change. Please try again.' });
    }
});

// @route   POST api/user/email/verify
// @desc    Confirm the pending recovery email with the emailed code
router.post('/email/verify', auth, emailCheckLimit, async (req, res) => {
    try {
        await ensureEmailSchema();
        const code = String((req.body || {}).code ?? '').trim();
        if (!/^\d{6}$/.test(code)) return res.status(400).json({ msg: 'Enter the 6-digit code from your email.' });

        const INVALID = 'That code is not valid or has expired. Send a new one.';
        const row = await db.get(
            'SELECT * FROM email_verifications WHERE user_id = ? AND used_at IS NULL ORDER BY created_at DESC',
            [req.user.id]
        );
        if (!row || row.expires_at < Date.now() || row.attempts >= VERIFY_MAX_TRIES) {
            return res.status(400).json({ msg: INVALID });
        }

        // Counted before the comparison, so a failure part-way through cannot
        // be replayed for unlimited guesses.
        await db.run('UPDATE email_verifications SET attempts = attempts + 1 WHERE id = ?', [row.id]);
        if (!(await bcrypt.compare(code, row.code_hash))) return res.status(400).json({ msg: INVALID });

        // Re-check ownership: someone else may have claimed this address while
        // the code was in flight.
        const clash = await db.get(
            'SELECT id FROM users WHERE (email = ? OR username = ?) AND id <> ?',
            [row.email, row.email, req.user.id]
        );
        if (clash) return res.status(409).json({ msg: 'That email is now in use on another account.' });

        const now = Date.now();
        await db.run('UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?', [row.email, now, req.user.id]);
        await db.run('UPDATE email_verifications SET used_at = ? WHERE id = ?', [now, row.id]);
        await db.run('DELETE FROM email_verifications WHERE user_id = ? AND used_at IS NULL', [req.user.id]);

        res.json({ msg: 'Email confirmed. You can now reset your password with it.',
                   email: row.email, emailVerified: true, pendingEmail: null });
    } catch (err) {
        console.error('[USER] email verify failed:', err.message);
        res.status(500).json({ msg: 'Could not confirm the email. Please try again.' });
    }
});

// @route   POST api/user/xp
// @desc    Add XP and time to user
// The largest award any screen in the app grants is 80 XP for 25 minutes.
// Anything beyond that did not come from finishing a piece of work.
const MAX_XP_PER_AWARD = 100;
const MAX_MINUTES_PER_AWARD = 30;

router.post('/xp', auth, async (req, res) => {
    try {
        const { xp, time, tool } = req.body;

        // This endpoint used to add whatever number the request contained,
        // straight into the column: `xp: 999999` set the account to level
        // 10000 in one call, and a negative value took XP away again. The
        // leaderboard is public, so that is not a cosmetic problem.
        //
        // The client is not a source of truth about how much work was done,
        // but it is the only thing that knows which award just fired, so the
        // value is bounded rather than trusted: a whole number, never
        // negative, never larger than the biggest award the app actually has.
        const award = Number(xp);
        const minutes = Number(time);
        if (!Number.isInteger(award) || award < 0 || award > MAX_XP_PER_AWARD) {
            return res.status(400).json({ msg: 'That is not a valid amount of XP.' });
        }
        if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_MINUTES_PER_AWARD) {
            return res.status(400).json({ msg: 'That is not a valid amount of study time.' });
        }
        const label = typeof tool === 'string' ? tool.trim().slice(0, 80) : '';

        await db.run(
            'UPDATE users SET xp = xp + ?, time_spent = time_spent + ? WHERE id = ?',
            [award, minutes, req.user.id]
        );

        const user = await db.get('SELECT xp, level, time_spent FROM users WHERE id = ?', [req.user.id]);
        const prevLevel = user.level;
        const newLevel = Math.floor(user.xp / 100) + 1;
        const leveledUp = newLevel > prevLevel;
        // Level is derived from XP, so it is written whenever the two differ.
        // Only ever raising it meant a level set by the old unchecked endpoint
        // stayed put even after the XP behind it was corrected.
        if (newLevel !== prevLevel) {
            await db.run('UPDATE users SET level = ? WHERE id = ?', [newLevel, req.user.id]);
        }

        if (label) {
            await db.run(
                'INSERT INTO activity (user_id, tool_used, time_spent, xp_earned) VALUES (?, ?, ?, ?)',
                [req.user.id, label, minutes, award]
            );
        }

        const streak = await calcStreak(req.user.id);
        const studied_today = await calcTodayStudyTime(req.user.id);

        res.json({
            xp: user.xp,
            level: newLevel,
            newTotal: user.xp,
            newLevel: newLevel,
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

// @route   PUT api/user/notes/:id
// @desc    Update one of the signed-in user's notes
// Clicking a note loads it into the editor, so Save has to mean "save this
// note". Without this route it always POSTed, and editing a note silently
// left a second copy behind.
router.put('/notes/:id', auth, async (req, res) => {
    try {
        const { title, content } = req.body;
        if (!title || !content) return res.status(400).json({ msg: 'Please provide title and content' });
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ msg: 'Invalid note id' });

        // Scoped by user_id, so another account's note id is a 404, not an edit.
        const result = await db.run(
            'UPDATE notes SET title = ?, content = ? WHERE id = ? AND user_id = ?',
            [title, content, id, req.user.id]
        );
        // config/db.js normalises both drivers to { lastID, changes }.
        if (!result.changes) return res.status(404).json({ msg: 'Note not found' });

        res.json({ id, title, content });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ msg: 'Server Error' });
    }
});

// @route   DELETE api/user/notes/:id
// @desc    Delete one of the signed-in user's notes
// The Delete button in the Note Taker had no route to call at all.
router.delete('/notes/:id', auth, async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ msg: 'Invalid note id' });

        const result = await db.run('DELETE FROM notes WHERE id = ? AND user_id = ?', [id, req.user.id]);
        // config/db.js normalises both drivers to { lastID, changes }.
        if (!result.changes) return res.status(404).json({ msg: 'Note not found' });

        res.json({ ok: true, id });
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
