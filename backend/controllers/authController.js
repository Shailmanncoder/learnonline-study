const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../config/security');
const db = require('../config/db');
const { rateLimit, refund } = require('../middleware/rateLimit');

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

// @route   POST api/auth/register
// @desc    Register user with role support
router.post('/register', registerLimit, async (req, res) => {
    try {
        const { username, password, role = 'student' } = req.body;
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

        const result = await db.run(
            'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
            [username.trim(), hashedPassword, cleanRole]
        );
        console.log('[AUTH] register inserted', { id: result.lastID, role: cleanRole });

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
