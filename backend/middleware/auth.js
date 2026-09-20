const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { getJwtSecret } = require('../config/security');

// A valid signature only proves this token was issued at some point. Tokens
// last five days, during which the account can be deleted or its role changed,
// so the account row — not the token's copy of it — decides who the caller is
// and what they are. The token is used for one thing: which account id to load.
async function authenticate(req, res, next) {
    const header = req.header('Authorization');
    if (!header) {
        return res.status(401).json({ msg: 'No token, authorization denied' });
    }

    let decoded;
    try {
        decoded = jwt.verify(header.replace(/^Bearer\s+/i, ''), getJwtSecret(), { algorithms: ['HS256'] });
    } catch {
        return res.status(401).json({ msg: 'Token is not valid' });
    }
    if (!decoded.user || !Number.isInteger(decoded.user.id) || decoded.user.id <= 0) {
        return res.status(401).json({ msg: 'Token is not valid' });
    }

    let account;
    try {
        account = await db.get('SELECT id, username, role FROM users WHERE id = ?', [decoded.user.id]);
    } catch (err) {
        // Failing open here would treat the token's own claims as authority,
        // which is the thing this middleware exists to prevent.
        console.error('[AUTH] account lookup failed:', err.message);
        return res.status(503).json({ msg: 'Authentication is temporarily unavailable. Please retry.' });
    }
    if (!account) {
        return res.status(401).json({ msg: 'This account is no longer available' });
    }

    req.user = { id: account.id, username: account.username, role: account.role || 'student' };
    next();
}

// Gate for whole areas of the API, such as the teacher portal. The role always
// comes from the account row loaded above, never from the request body or from
// which portal the browser decided to open.
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ success: false, error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } });
        }
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({
                success: false,
                error: {
                    code: 'ROLE_REQUIRED',
                    message: `This action requires a ${roles.join(' or ')} account.`
                }
            });
        }
        next();
    };
}

module.exports = authenticate;
module.exports.requireRole = requireRole;
