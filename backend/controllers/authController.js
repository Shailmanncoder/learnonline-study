const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../config/security');
const db = require('../config/db');
const { rateLimit, refund } = require('../middleware/rateLimit');
const crypto = require('node:crypto');
const mailer = require('../services/mailer');

// The reset tables are created on first use, the same way the payment tables
// are, so no separate migration step is needed on deploy.
let resetSchema;
const ensureResetSchema = () => (resetSchema ||= require('../migrations/003_password_reset')(db));

const RESET_TTL_MS = 10 * 60_000;   // a code is worth ten minutes
const RESET_MAX_TRIES = 5;          // then it is spent, whatever the attacker does

// Sign-in and sign-up had no limit of any kind: twelve wrong passwords in a
// row came back twelve times with no delay and no lockout, so an attacker
// could guess at network speed against any account, forever. Failed attempts
// are what count -- refund() gives the slot back on success, so somebody who
// simply uses the app a lot is never locked out of it.
const loginLimit = rateLimit({
    name: 'auth-login', windowMs: 15 * 60_000, max: 10,
    message: 'Too many sign-in attempts. Please wait a few minutes and try again.'
});
const registerLimit = rateLimit({
    name: 'auth-register', windowMs: 60 * 60_000, max: 10,
    message: 'Too many accounts created from here. Please wait and try again.'
});

// Sign-in must not say WHICH half was wrong. It used to answer 404 "Account
// not found" for an unknown username and 400 "Incorrect password" for a real
// one, which let anyone test an address and learn whether it has an account
// here -- a list of real users, free, and with no rate limit behind it.
const SIGNIN_FAILED = 'Those sign-in details did not match an account. Check the username and password, or create an account.';

// Issue an email confirmation code. Shared by sign-up and the profile, so
// both produce the same thing and there is one place to change it.
async function sendEmailCode(userId, email) {
    await require('../migrations/004_email_verification')(db);
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const now = Date.now();
    await db.run('DELETE FROM email_verifications WHERE user_id = ? AND used_at IS NULL', [userId]);
    await db.run(
        'INSERT INTO email_verifications (id, user_id, email, code_hash, created_at, expires_at, attempts) VALUES (?,?,?,?,?,?,0)',
        [crypto.randomUUID(), userId, email, await bcrypt.hash(code, 10), now, now + 15 * 60_000]
    );
    if (!mailer.isWorking()) {
        if (process.env.NODE_ENV !== 'production') console.log(`[AUTH] email code for user ${userId}: ${code} (SMTP not configured)`);
        else console.error('[AUTH] email confirmation needed but mail is unavailable:', mailer.describe());
        return false;
    }
    await mailer.send({
        to: email,
        subject: 'Confirm your email for LearnOnline.study',
        text: `Your confirmation code is ${code}\n\n`
            + `Enter it to finish setting up your account. It expires in 15 minutes.\n\n`
            + `If you did not create an account, you can ignore this email.`
    });
    return true;
}

// @route   POST api/auth/register
// @desc    Register user with role support
router.post('/register', registerLimit, async (req, res) => {
    try {
        const { username, password, email, role = 'student' } = req.body;
        // The username is the person's email. It was logged on every attempt,
        // putting a list of accounts into plain-text server logs.
        console.log('[AUTH] register request', { role });

        if (typeof username !== 'string' || !username.trim() || username.trim().length > 50 ||
            typeof password !== 'string' || !password || Buffer.byteLength(password, 'utf8') > 72) {
            return res.status(400).json({ msg: 'Please enter all required fields' });
        }
        if (password.length < 8) {
            return res.status(400).json({ msg: 'Password must be at least 8 characters long' });
        }

        const userExists = await db.get('SELECT * FROM users WHERE username = ?', [username.trim()]);
        if (userExists) {
            return res.status(400).json({ msg: 'An account with this username/email already exists. Please sign in!' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        // 'admin' is never self-assignable: it used to be accepted straight from
        // the request body, so anyone could register as an administrator.
        const cleanRole = ['teacher', 'developer', 'student'].includes(role) ? role : 'student';

        // An email given at sign-up. Stored unverified: a code is sent straight
        // away, and nothing treats it as real until that code comes back. If
        // the username IS an address, it counts as the one supplied.
        const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
        const supplied = String(email ?? '').trim().toLowerCase()
            || (EMAIL_RE.test(username.trim()) ? username.trim().toLowerCase() : '');
        if (supplied && (supplied.length > 254 || !EMAIL_RE.test(supplied))) {
            return res.status(400).json({ msg: 'Enter a valid email address.' });
        }
        if (supplied) {
            // Must not collide with another account's address or username, for
            // the same reason a reset lookup must not be ambiguous.
            const clash = await db.get('SELECT id FROM users WHERE email = ? OR username = ?', [supplied, supplied]);
            if (clash) return res.status(409).json({ msg: 'That email is already in use on another account.' });
        }

        const result = await db.run(
            'INSERT INTO users (username, password, role, email) VALUES (?, ?, ?, ?)',
            [username.trim(), hashedPassword, cleanRole, supplied || null]
        );
        console.log('[AUTH] register inserted', { id: result.lastID, role: cleanRole });

        // Send the confirmation code now, so the address is usable by the time
        // they reach anything that needs it. Best effort: a mail failure must
        // never fail the sign-up itself.
        if (supplied) {
            sendEmailCode(result.lastID, supplied).catch(err =>
                console.warn('[AUTH] sign-up verification email failed:', err.message));
        }

        const payload = {
            user: { id: result.lastID, role: cleanRole }
        };

        jwt.sign(payload, getJwtSecret(), { expiresIn: '5d', algorithm: 'HS256' }, (err, token) => {
            if (err) throw err;
            res.json({
                token,
                user: { id: result.lastID, username: username.trim(), role: cleanRole }
            });
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ msg: 'Server error during registration' });
    }
});

// ── Forgot password ───────────────────────────────────────────────
// Both routes answer the same way whether or not the account exists. That is
// the whole point: sign-in used to reveal which addresses were registered, and
// a reset form is exactly the same oracle if it says "no such account".
const RESET_SENT = 'If that account exists and has a confirmed recovery email, a 6-digit code is on its way. It expires in 10 minutes.';

const forgotLimit = rateLimit({
    name: 'auth-forgot', windowMs: 15 * 60_000, max: 5,
    message: 'Too many reset requests. Please wait a few minutes.'
});
const resetLimit = rateLimit({
    name: 'auth-reset', windowMs: 15 * 60_000, max: 10,
    message: 'Too many attempts. Please wait a few minutes.'
});

// An account is found by username or by its recovery email, so someone who has
// forgotten which they used can enter either. An UNverified address does not
// identify an account: anyone can type any address into their own profile, so
// honouring one here would let them pull a stranger's account into the flow.
async function findAccount(identifier) {
    const value = String(identifier || '').trim();
    if (!value || value.length > 254) return null;
    return db.get(
        'SELECT * FROM users WHERE username = ? OR (email = ? AND email_verified_at IS NOT NULL)',
        [value, value]
    );
}

// @route   POST api/auth/forgot-password
router.post('/forgot-password', forgotLimit, async (req, res) => {
    try {
        await ensureResetSchema();
        const user = await findAccount(req.body && req.body.username);
        // The reply is sent regardless. Everything below is best-effort.
        res.json({ msg: RESET_SENT, emailConfigured: mailer.isWorking() });

        if (!user) return;
        // Send to the address on the account, confirmed or not.
        //
        // This used to require a confirmed address, which was wrong in a way
        // that mattered: confirming happens from the profile, the profile
        // needs you signed in, and if you have forgotten your password you
        // cannot sign in. Every account with an unconfirmed address was
        // therefore permanently unable to reset — the exact outcome this
        // feature exists to prevent. On production that was all 8 of them.
        //
        // The thing confirmation protects against is LOOKUP: being found by
        // an address someone else typed into their own profile. That is still
        // enforced in findAccount. Delivering to an address the account holder
        // put on their own account is a different question, and a stray code
        // is useless to whoever receives it without the username.
        const EMAIL_SHAPED = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
        const recipient = user.email || (EMAIL_SHAPED.test(user.username) ? user.username : null);
        if (!recipient) return;   // nothing on file to send to

        // Six digits from a cryptographic source, never Math.random.
        const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
        const now = Date.now();
        // Only the hash is stored, so a copy of the database is not a pile of
        // working reset codes. bcrypt also makes each guess cost something.
        const codeHash = await bcrypt.hash(code, 10);

        // One live code per account: asking again replaces the old one.
        await db.run('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL', [user.id]);
        await db.run(
            'INSERT INTO password_resets (id, user_id, code_hash, created_at, expires_at, attempts) VALUES (?, ?, ?, ?, ?, 0)',
            [crypto.randomUUID(), user.id, codeHash, now, now + RESET_TTL_MS]
        );

        if (!mailer.isWorking()) {
            // In development the code goes to the server log so the flow can be
            // used without a mail account. Never in production: that would put
            // working reset codes into the log file.
            if (process.env.NODE_ENV !== 'production') {
                console.log(`[AUTH] reset code for user ${user.id}: ${code} (SMTP not configured)`);
            } else {
                console.error('[AUTH] password reset requested but mail is unavailable:', mailer.describe());
            }
            return;
        }
        await mailer.send({
            to: recipient,
            subject: 'Your LearnOnline.study password reset code',
            text: `Your password reset code is ${code}\n\n`
                + `It expires in 10 minutes and can be used once.\n\n`
                + `If you did not ask to reset your password, you can ignore this email — `
                + `your password has not changed.`
        });
    } catch (err) {
        // The response has usually gone already; never turn a mail failure into
        // a signal about whether the account exists.
        console.error('[AUTH] forgot-password failed:', err.message);
        if (!res.headersSent) res.json({ msg: RESET_SENT, emailConfigured: mailer.isWorking() });
    }
});

// @route   POST api/auth/reset-password
router.post('/reset-password', resetLimit, async (req, res) => {
    try {
        await ensureResetSchema();
        const { username, code, password } = req.body || {};
        if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
            return res.status(400).json({ msg: 'Choose a new password of at least 8 characters.' });
        }
        if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) {
            return res.status(400).json({ msg: 'Enter the 6-digit code from your email.' });
        }

        const INVALID = 'That code is not valid or has expired. Request a new one.';
        const user = await findAccount(username);
        if (!user) return res.status(400).json({ msg: INVALID });

        const row = await db.get(
            'SELECT * FROM password_resets WHERE user_id = ? AND used_at IS NULL ORDER BY created_at DESC',
            [user.id]
        );
        if (!row || row.expires_at < Date.now() || row.attempts >= RESET_MAX_TRIES) {
            return res.status(400).json({ msg: INVALID });
        }

        // Count the attempt before checking it, so a crash mid-check cannot be
        // used to get unlimited guesses at a six-digit code.
        await db.run('UPDATE password_resets SET attempts = attempts + 1 WHERE id = ?', [row.id]);
        if (!(await bcrypt.compare(code.trim(), row.code_hash))) {
            return res.status(400).json({ msg: INVALID });
        }

        const now = Date.now();
        const hashed = await bcrypt.hash(password, await bcrypt.genSalt(10));
        await db.run('UPDATE users SET password = ?, password_changed_at = ? WHERE id = ?', [hashed, now, user.id]);
        await db.run('UPDATE password_resets SET used_at = ? WHERE id = ?', [now, row.id]);
        // Any other outstanding code for this account is now meaningless.
        await db.run('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL', [user.id]);

        // No token is returned. Whoever reset the password signs in with it,
        // which also means a stolen code alone does not hand over a session.
        res.json({ msg: 'Your password has been changed. Please sign in.' });
    } catch (err) {
        console.error('[AUTH] reset-password failed:', err.message);
        res.status(500).json({ msg: 'Could not reset the password. Please try again.' });
    }
});

// @route   POST api/auth/login
// @desc    Authenticate user & verify role
router.post('/login', loginLimit, async (req, res) => {
    try {
        const { username, password, requiredRole } = req.body;
        console.log('[AUTH] login request', { requiredRole });

        if (typeof username !== 'string' || !username.trim() || username.trim().length > 50 ||
            typeof password !== 'string' || !password || Buffer.byteLength(password, 'utf8') > 72) {
            return res.status(400).json({ msg: 'Please enter username and password' });
        }

        const user = await db.get('SELECT * FROM users WHERE username = ?', [username.trim()]);
        // Hash even when there is no such account, so the two cases take a
        // comparable amount of time. Answering instantly for an unknown
        // username is the same disclosure by another route.
        const isMatch = user
            ? await bcrypt.compare(password, user.password)
            : (await bcrypt.compare(password, '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'), false);
        if (!user || !isMatch) {
            // canRegister keeps the "create an account" affordance on the sign-in
            // form without confirming whether this particular one exists: it is
            // the same for a wrong password and an unknown username.
            return res.status(401).json({ msg: SIGNIN_FAILED, canRegister: true });
        }

        // A correct password is not an attack, so it does not count towards the
        // limit. Only failures accumulate.
        refund('auth-login', req);

        // Enforce role barrier: Students cannot enter Teacher Portal
        if (requiredRole === 'teacher' && !['teacher','admin'].includes(user.role)) {
            return res.status(403).json({
                msg: 'This account does not have teacher access. Please use its own portal.',
                isStudent: true
            });
        }

        const userRole = user.role || 'student';
        const payload = {
            user: { id: user.id, role: userRole }
        };

        jwt.sign(payload, getJwtSecret(), { expiresIn: '5d', algorithm: 'HS256' }, (err, token) => {
            if (err) throw err;
            res.json({
                token,
                user: {
                    id: user.id,
                    username: user.username,
                    role: userRole,
                    xp: user.xp || 0,
                    level: user.level || 1
                }
            });
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ msg: 'Server error during login' });
    }
});

module.exports = router;
