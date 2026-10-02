const db = require('../config/db');
module.exports = async (req, res, next) => {
    try {
        const user = await db.get('SELECT role FROM users WHERE id = ?', [req.user.id]);
        if (!user || !['teacher', 'admin'].includes(user.role)) return res.status(403).json({ msg: 'A teacher account is required.' });
        next();
    } catch { res.status(503).json({ msg: 'Could not check teacher access. Please retry.' }); }
};
