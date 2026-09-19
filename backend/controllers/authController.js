const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../config/security');
const db = require('../config/db');

// @route   POST api/auth/register
// @desc    Register user with role support
router.post('/register', async (req, res) => {
    try {
        const { username, password, role = 'student' } = req.body;
        console.log('[AUTH] register request', { username, role });

        if (typeof username !== 'string' || !username.trim() || username.trim().length > 50 ||
            typeof password !== 'string' || !password || Buffer.byteLength(password, 'utf8') > 72) {
            return res.status(400).json({ msg: 'Please enter all required fields' });
        }
        if (password.length < 6) {
            return res.status(400).json({ msg: 'Password must be at least 6 characters long' });
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
        console.log('[AUTH] register inserted', { id: result.lastID, username, role: cleanRole });

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
router.post('/login', async (req, res) => {
    try {
        const { username, password, requiredRole } = req.body;
        console.log('[AUTH] login request', { username, requiredRole });

        if (typeof username !== 'string' || !username.trim() || username.trim().length > 50 ||
            typeof password !== 'string' || !password || Buffer.byteLength(password, 'utf8') > 72) {
            return res.status(400).json({ msg: 'Please enter username and password' });
        }

        const user = await db.get('SELECT * FROM users WHERE username = ?', [username.trim()]);
        if (!user) {
            return res.status(404).json({
                msg: 'Account not found with this username. You must create an account first before logging in!',
                notFound: true,
                requiresRegister: true
            });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ msg: 'Incorrect password. Please try again.' });
        }

        // Enforce role barrier: Students cannot enter Teacher Portal
        if (requiredRole === 'teacher' && user.role === 'student') {
            return res.status(403).json({
                msg: 'Access Denied: This account is registered as a Student. Students cannot log into the Teacher Portal. Please sign up with a Teacher account!',
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
