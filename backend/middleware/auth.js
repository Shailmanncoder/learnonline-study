const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../config/security');

module.exports = function (req, res, next) {
    const token = req.header('Authorization');

    if (!token) {
        return res.status(401).json({ msg: 'No token, authorization denied' });
    }

    try {
        const decoded = jwt.verify(token.replace(/^Bearer\s+/i, ''), getJwtSecret(), { algorithms: ['HS256'] });
        if (!decoded.user || !Number.isInteger(decoded.user.id) || decoded.user.id <= 0) {
            return res.status(401).json({ msg: 'Token is not valid' });
        }
        req.user = decoded.user;
        next();
    } catch (err) {
        res.status(401).json({ msg: 'Token is not valid' });
    }
};
