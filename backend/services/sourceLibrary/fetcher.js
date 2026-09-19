// ================================================================
// Safe fetcher for trusted sources
// ----------------------------------------------------------------
// The only code in the library that touches the network.
//
//  * Exact-host allowlist. "ncert.nic.in.evil.test" and
//    "user@ncert.nic.in" are rejected, not suffix-matched.
//  * https only, default port only, no credentials in the URL.
//  * Redirects followed MANUALLY, each hop re-validated — an allowed
//    host that redirects elsewhere cannot pull us off the allowlist.
//  * robots.txt honoured. A 404 means no restrictions (the robots
//    standard); a timeout or 5xx fails CLOSED — we do not crawl a site
//    whose rules we could not read.
//  * One request at a time per host, with a minimum gap.
//  * Size cap enforced while streaming, timeouts, and a declared-type
//    plus magic-byte check for PDFs.
//
// It never follows anything inside a downloaded document and never
// executes it: bytes go to the PDF text extractor and nowhere else.
// ================================================================
const USER_AGENT = 'LearnOnlineStudy-SourceCollector/1.0 (+https://learnonline.study; educational index)';
const MIN_GAP_MS = Number(process.env.LIBRARY_FETCH_GAP_MS) || 3000;
const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 3 * 1024 * 1024;
const MAX_PDF_BYTES = (Number(process.env.LIBRARY_MAX_PDF_MB) || 40) * 1024 * 1024;
const TIMEOUT_MS = 60000;

class FetchPolicyError extends Error {
    constructor(message, code) { super(message); this.code = code; }
}

function parseHostList(value) {
    return String(value || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
}

// Throws unless `url` is an https URL on one of `allowedHosts` exactly.
function assertAllowedUrl(url, allowedHosts) {
    let u;
    try { u = new URL(url); } catch (e) { throw new FetchPolicyError(`Not a valid URL: ${String(url).slice(0, 120)}`, 'invalid_url'); }
    const hosts = Array.isArray(allowedHosts) ? allowedHosts : parseHostList(allowedHosts);
    if (u.protocol !== 'https:') throw new FetchPolicyError(`Only https is allowed (${u.protocol})`, 'scheme');
    if (u.username || u.password) throw new FetchPolicyError('Credentials in URLs are not allowed', 'credentials');
    if (u.port && u.port !== '443') throw new FetchPolicyError(`Non-default port ${u.port} is not allowed`, 'port');
    const host = u.hostname.toLowerCase();
    if (!hosts.includes(host)) throw new FetchPolicyError(`Host not on the allowlist: ${host}`, 'host');
    return u;
}

// ── Rate limiting: serialise requests per host ──────────────────────
const lastRequestAt = new Map();
const hostQueues = new Map();

function throttled(host, fn) {
    const prev = hostQueues.get(host) || Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
        const wait = (lastRequestAt.get(host) || 0) + MIN_GAP_MS - Date.now();
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        try { return await fn(); } finally { lastRequestAt.set(host, Date.now()); }
    });
    hostQueues.set(host, run);
    return run;
}

// ── robots.txt ───────────────────────────────────────────────────────
const robotsCache = new Map();   // origin -> { at, rules | null, status }
const ROBOTS_TTL_MS = 6 * 60 * 60 * 1000;
// A failed read is remembered only briefly: the NCERT server is intermittent,
// and caching one timeout for six hours would block all ingestion that long.
const ROBOTS_FAILURE_TTL_MS = 2 * 60 * 1000;

// Minimal parser: the groups for "*" (and our agent token), Disallow/Allow
// with longest-match precedence. Enough for honouring a publisher's rules.
function parseRobots(text) {
    const groups = [];
    let current = null;
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, '').trim();
        if (!line) continue;
        const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
        if (!m) continue;
        const key = m[1].toLowerCase();
        const value = m[2].trim();
        if (key === 'user-agent') {
            if (!current || current.rules.length) { current = { agents: [], rules: [] }; groups.push(current); }
            current.agents.push(value.toLowerCase());
        } else if ((key === 'disallow' || key === 'allow') && current) {
            current.rules.push({ allow: key === 'allow', path: value });
        }
    }
    const mine = groups.filter(g => g.agents.some(a => a !== '*' && USER_AGENT.toLowerCase().includes(a)));
    const chosen = mine.length ? mine : groups.filter(g => g.agents.includes('*'));
    return chosen.flatMap(g => g.rules);
}

function robotsAllows(rules, pathWithQuery) {
    let best = null;
    for (const r of rules) {
        if (!r.path) continue;                         // "Disallow:" with no path allows all
        const pattern = '^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$');
        if (new RegExp(pattern).test(pathWithQuery)) {
            if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
        }
    }
    return !best || best.allow;
}

async function checkRobots(u, allowedHosts) {
    const origin = u.origin;
    let entry = robotsCache.get(origin);
    const ttl = entry && entry.rules === null ? ROBOTS_FAILURE_TTL_MS : ROBOTS_TTL_MS;
    if (!entry || Date.now() - entry.at > ttl) {
        let status = 0;
        let rules = null;
        for (let attempt = 0; attempt < 2 && rules === null; attempt++) {
            if (attempt) await new Promise(r => setTimeout(r, 3000));
            try {
                const res = await throttled(u.hostname, () => fetch(`${origin}/robots.txt`, {
                    headers: { 'User-Agent': USER_AGENT }, redirect: 'manual', signal: AbortSignal.timeout(20000)
                }));
                status = res.status;
                if (res.status === 200) rules = parseRobots(await res.text());
                // 4xx: there is no robots file, which the standard reads as no
                // restrictions. 3xx/5xx stay unknown and fail closed.
                else if (res.status >= 400 && res.status < 500) rules = [];
            } catch (e) {
                status = 0;
            }
        }
        entry = { at: Date.now(), rules, status };
        robotsCache.set(origin, entry);
    }
    if (entry.rules === null) {
        throw new FetchPolicyError(
            `robots.txt for ${origin} could not be read (status ${entry.status || 'timeout'}); refusing to crawl. ` +
            'Retry later, or upload the document manually if you are authorised to.', 'robots_unavailable');
    }
    if (!robotsAllows(entry.rules, u.pathname + u.search)) {
        throw new FetchPolicyError(`robots.txt disallows ${u.pathname}`, 'robots_disallow');
    }
}

// ── The fetch itself ─────────────────────────────────────────────────
async function readCapped(res, maxBytes) {
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared && declared > maxBytes) throw new FetchPolicyError(`Document is ${declared} bytes, over the ${maxBytes} byte limit`, 'too_large');
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new FetchPolicyError(`Document exceeded the ${maxBytes} byte limit while downloading`, 'too_large');
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks.map(c => Buffer.from(c)));
}

/**
 * Fetch an allowlisted URL.
 *   kind: 'html' | 'pdf'
 * Returns { buffer, finalUrl, contentType, status, redirects }.
 */
async function safeFetch(url, { allowedHosts, kind = 'html', retries = 2 } = {}) {
    let current = assertAllowedUrl(url, allowedHosts);
    await checkRobots(current, allowedHosts);
    const redirects = [];

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        let res;
        let attempt = 0;
        for (;;) {
            try {
                res = await throttled(current.hostname, () => fetch(current, {
                    headers: {
                        'User-Agent': USER_AGENT,
                        Accept: kind === 'pdf' ? 'application/pdf' : 'text/html,application/xhtml+xml'
                    },
                    redirect: 'manual',
                    signal: AbortSignal.timeout(TIMEOUT_MS)
                }));
                if (res.status >= 500 && attempt < retries) throw new Error(`HTTP ${res.status}`);
                break;
            } catch (e) {
                if (e instanceof FetchPolicyError) throw e;
                if (attempt >= retries) throw new FetchPolicyError(`Fetch failed after ${attempt + 1} attempts: ${e.message}`, 'network');
                attempt++;
                await new Promise(r => setTimeout(r, 2000 * attempt));
            }
        }

        if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get('location');
            if (!location) throw new FetchPolicyError(`Redirect ${res.status} with no Location`, 'redirect');
            const next = new URL(location, current);
            // Re-validate every hop: this is what stops an allowed host from
            // redirecting the collector to an internal address or another site.
            current = assertAllowedUrl(next.href, allowedHosts);
            await checkRobots(current, allowedHosts);
            redirects.push(current.href);
            continue;
        }
        if (res.status !== 200) throw new FetchPolicyError(`HTTP ${res.status} for ${current.href}`, 'http_status');

        const contentType = String(res.headers.get('content-type') || '').toLowerCase();
        if (kind === 'pdf') {
            if (contentType && !/application\/(pdf|octet-stream)/.test(contentType)) {
                throw new FetchPolicyError(`Expected a PDF but the server sent ${contentType}`, 'mime');
            }
            const buffer = await readCapped(res, MAX_PDF_BYTES);
            // The declared type is only a claim; the bytes must be a PDF.
            if (!buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
                throw new FetchPolicyError('Downloaded file is not a PDF (no %PDF- header)', 'mime');
            }
            return { buffer, finalUrl: current.href, contentType, status: res.status, redirects };
        }
        if (contentType && !/text\/html|application\/xhtml/.test(contentType)) {
            throw new FetchPolicyError(`Expected HTML but the server sent ${contentType}`, 'mime');
        }
        const buffer = await readCapped(res, MAX_HTML_BYTES);
        return { buffer, finalUrl: current.href, contentType, status: res.status, redirects };
    }
    throw new FetchPolicyError(`More than ${MAX_REDIRECTS} redirects`, 'redirect');
}

module.exports = {
    safeFetch, assertAllowedUrl, parseRobots, robotsAllows, parseHostList,
    FetchPolicyError, USER_AGENT, MAX_PDF_BYTES
};
