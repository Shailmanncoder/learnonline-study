// ================================================================
// Source-library administrators
// ----------------------------------------------------------------
// Ingestion and verification decide what students are told is a
// verified citation, so admin access is deliberately NOT taken from
// the JWT role claim: tokens fall back to a default signing secret in
// local development, and the role used to be self-assignable at
// registration. Instead the user is looked up in the database and the
// username must appear in the server-side LIBRARY_ADMINS allowlist.
// With the variable unset, nobody is an admin — the safe default.
// ================================================================
const db = require('../config/db');

function allowlist() {
    return new Set(String(process.env.LIBRARY_ADMINS || '')
        .split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}

module.exports = async function libraryAdmin(req, res, next) {
    try {
        const admins = allowlist();
        if (!req.user || !admins.size) return res.status(403).json({ msg: 'Source library admin access required.' });
        const user = await db.get('SELECT id, username FROM users WHERE id = ?', [req.user.id]);
        if (!user || !admins.has(String(user.username || '').toLowerCase())) {
            return res.status(403).json({ msg: 'Source library admin access required.' });
        }
        req.libraryAdmin = { id: user.id, username: user.username };
        next();
    } catch (e) {
        res.status(500).json({ msg: 'Could not check admin access.' });
    }
};
