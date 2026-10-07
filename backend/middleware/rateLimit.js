// Fixed-window counters held in this process's memory.
//
// Honest about what this is: per-process. If the app is ever run with more
// than one worker, each keeps its own window and the effective limit is
// multiplied by the worker count; a restart clears every window. It is a brake
// on password guessing and on runaway generation loops, not a distributed
// quota — that needs a shared store, and is noted as outstanding rather than
// pretended at here.

const buckets = new Map();

// Without this the map grows one entry per distinct key, forever.
const SWEEP_EVERY_MS = 60_000;
let lastSweep = Date.now();
function sweep(now) {
    if (now - lastSweep < SWEEP_EVERY_MS) return;
    lastSweep = now;
    for (const [key, entry] of buckets) {
        if (entry.resetAt <= now) buckets.delete(key);
    }
}

function clientKey(req) {
    // req.ip is Express's own trust-proxy-aware client address: with
    // app.set('trust proxy', 1) it is the last entry nginx added to
    // X-Forwarded-For, and without it the socket address. A caller cannot pick
    // their own bucket by sending the header, because Express only honours the
    // one declared hop.
    //
    // This used to read X-Forwarded-For only when TRUST_PROXY === 'true', and
    // that variable is set nowhere. Behind nginx every request therefore keyed
    // on nginx's own address, so every visitor on the site shared ONE bucket:
    // the payment limiters throttled unrelated people together, and a per-IP
    // brake on password guessing would have been no brake at all.
    return (req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
}

/**
 * @param {object} options
 * @param {number} options.windowMs   length of the window
 * @param {number} options.max        requests allowed per window
 * @param {string} options.name       bucket namespace
 * @param {(req) => string} [options.keyOf]  defaults to account id, else IP
 * @param {string} [options.message]
 */
function rateLimit({ windowMs, max, name, keyOf, message }) {
    return (req, res, next) => {
        const now = Date.now();
        sweep(now);

        // Signed-in callers are limited per account, so one busy school network
        // does not throttle a whole class sharing an address.
        const who = keyOf ? keyOf(req) : (req.user && req.user.id ? `u${req.user.id}` : clientKey(req));
        const key = `${name}:${who}`;

        let entry = buckets.get(key);
        if (!entry || entry.resetAt <= now) {
            entry = { count: 0, resetAt: now + windowMs };
            buckets.set(key, entry);
        }
        entry.count += 1;

        if (entry.count > max) {
            const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
            res.set('Retry-After', String(retryAfter));
            return res.status(429).json({
                success: false,
                msg: message || 'Too many requests. Please wait a moment and try again.',
                error: { code: 'RATE_LIMITED', message: message || 'Too many requests. Please wait a moment and try again.', retryAfter }
            });
        }
        next();
    };
}

// Only failed attempts should count against a sign-in limit, or a person who
// simply uses the app a lot gets locked out of it.
function refund(name, req) {
    const who = req.user && req.user.id ? `u${req.user.id}` : clientKey(req);
    const entry = buckets.get(`${name}:${who}`);
    if (entry && entry.count > 0) entry.count -= 1;
}

module.exports = { rateLimit, refund, _buckets: buckets };
