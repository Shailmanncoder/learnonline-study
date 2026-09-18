function getJwtSecret(env = process.env) {
    const secret = env.JWT_SECRET?.trim();
    if (!secret || secret.length < 32 || /fallback_secret|super_secret|change.?me|your[_-].*secret/i.test(secret)) {
        throw new Error('JWT_SECRET must be a unique random secret of at least 32 characters.');
    }
    return secret;
}
module.exports = { getJwtSecret };
