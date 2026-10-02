const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../config/security');

const db = require('../config/db');
module.exports = async function (req, res, next) {
    const token = req.header('Authorization');

    if (!token) {
        return res.status(401).json({ msg: 'No token, authorization denied' });
    }

    let decoded;
    try {
        decoded = jwt.verify(token.replace(/^Bearer\s+/i, ''), getJwtSecret(), { algorithms: ['HS256'] });
        if (!decoded.user || !Number.isInteger(decoded.user.id) || decoded.user.id <= 0) {
            return res.status(401).json({ msg: 'Token is not valid' });
        }
    } catch {
        return res.status(401).json({ msg: 'Token is not valid' });
    }
    try {
        const account=await db.get('SELECT id,role FROM users WHERE id=?',[decoded.user.id]);
        if(!account)return res.status(401).json({msg:'Account is no longer available. Please sign in.'});
        req.user = {...decoded.user,role:account.role};
        next();
    } catch (err) {
        res.status(503).json({ msg: 'Account service is temporarily unavailable. Please retry.' });
    }
};
