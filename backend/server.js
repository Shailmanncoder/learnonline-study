const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

require('./config/security').getJwtSecret();

const app = express();

// nginx terminates TLS on this host and proxies to the container over plain
// HTTP, so without this Express sees req.secure === false on every request —
// and the payments router answers "Payments require HTTPS" with 426 to real
// browsers that did arrive over HTTPS. Trusting exactly one hop makes Express
// read X-Forwarded-Proto from nginx, and no further, so a client cannot spoof
// X-Forwarded-For by adding its own header.
//
// It also fixes req.ip, which was the proxy's address for everyone: the
// payment rate limiter and the risk ip_hash were treating every visitor as the
// same person.
app.set('trust proxy', 1);

app.use(cors());

// ── Payments ──────────────────────────────────────────────────────
// The webhook route is installed BEFORE express.json, because Razorpay's
// signature is computed over the exact bytes it sent. Once a JSON parser has
// read and re-serialised the body those bytes are gone, key order and spacing
// included, and every signature check fails. It therefore takes the raw body
// itself (express.raw inside installWebhooks).
require('./payments/router').installWebhooks(app);

app.use(express.json({ limit: '10mb' }));

const authRoutes         = require('./controllers/authController');
const userRoutes         = require('./controllers/userController');
const aiRoutes            = require('./controllers/aiController');
const teacherRoutes      = require('./controllers/teacherController');
const classroomRoutes    = require('./controllers/classroomController');
const studyRoutes        = require('./controllers/studyController');
const gamificationRoutes = require('./controllers/gamificationController');

app.use('/api/auth',         authRoutes);
app.use('/api/user',         userRoutes);
app.use('/api/ai',           aiRoutes);
app.use('/api/ncert',        require('./controllers/ncertController'));
app.use('/api/memory',       require('./controllers/memoryController'));
app.use('/api/library',      require('./controllers/libraryController'));
app.use('/api/teaching-studio', require('./controllers/teachingStudioController'));
app.use('/api/teacher',      teacherRoutes);
app.use('/api/classroom',    classroomRoutes);
app.use('/api/study',        studyRoutes);
app.use('/api/learning', require('./controllers/learningController'));
app.use('/api/studio', require('./controllers/studioController'));
app.use('/api/roadmaps', require('./controllers/studioRoadmapController'));
app.use('/api/review', require('./controllers/reviewController'));
app.use('/api/gamification', gamificationRoutes);
app.use('/api/developer',    require('./controllers/developerController'));
app.use('/api/payments',     require('./payments/router').router);

// Verified Source Library admin screen. The page itself holds no data; every
// call it makes is checked against the LIBRARY_ADMINS allowlist server-side.
app.get(['/admin/sources', '/admin/sources/'], (req, res) => {
    res.set('X-Frame-Options', 'DENY');
    res.sendFile(path.join(__dirname, '../frontend', 'admin-sources.html'));
});
// Billing and payment administration. Both serve the same page; it decides
// what to show from /api/payments/catalog, and every privileged call is
// re-checked server-side against PAYMENTS_ADMIN_IDS — the route itself grants
// nothing. Registered before the static mount and before the SPA catch-all so
// these paths are not swallowed by index.html.
// /checkout is the purchase flow, /billing the history, /admin/payments the
// administration view — payments.js switches on location.pathname, so all
// three must reach it rather than falling through to the SPA shell.
app.get(['/billing', '/billing/', '/checkout', '/checkout/', '/admin/payments', '/admin/payments/'], (req, res) => {
    res.set('X-Frame-Options', 'DENY');
    res.sendFile(path.join(__dirname, '../frontend', 'payments.html'));
});

app.use(express.static(path.join(__dirname, '../frontend')));

// SPA fallback. Anything that looks like a static asset must 404 rather than
// fall through to index.html — serving HTML for a missing .js gives the
// browser a "SyntaxError: Unexpected token '<'" that hides the real cause.
const ASSET_EXT = /\.(?:js|mjs|css|map|json|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|txt|xml|webmanifest)$/i;

app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    if (ASSET_EXT.test(req.path)) {
        return res.status(404).type('text/plain').send('Not found');
    }
    return res.sendFile(path.join(__dirname, '../frontend', 'index.html'));
});

// ── Express error handler ────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('[EXPRESS ERROR]', err.stack);
    if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ── Start server ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
async function start() {
await require('./config/db').ready();
await require('./services/studioStore').ready();
await require('./controllers/teachingStudioController').ready();
require('./services/studioSources').start().catch(e => console.warn('[SOURCE]',e.message));
require('./services/studioRoadmaps').start();
// Finish any upload that was mid-OCR when the server last stopped.
require('./services/memoryDocs').resumePending();
// Seed the trusted source registry and resume any interrupted ingestion job.
require('./services/sourceLibrary/collector').seedTrustedSources()
    .then(() => require('./services/sourceLibrary/collector').resumeJobs())
    .catch((e) => console.warn('[LIBRARY] startup:', e.message));

const server = app.listen(PORT, process.env.HOST || '0.0.0.0');
server.on('listening', () => {
    console.log(`Server running on port ${server.address().port}`);

    // Load the embedding model now rather than on the first student question.
    // Loading it lazily meant a cold container answered WITHOUT textbook
    // retrieval until the model landed — and said nothing about it, because
    // the tutor falls back silently by design.
    if (process.env.NCERT_PG_URL) {
        require('./services/embedder').warmup().then((ok) => {
            console.log(ok
                ? 'NCERT: semantic search ready'
                : 'NCERT: semantic search unavailable — falling back to keyword search');
        });
    }
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[ERROR] Port ${PORT} already in use. Another instance may be running.`);
    } else {
        console.error('[SERVER ERROR]', err.message);
    }
    process.exit(1);
});

}
start().catch((err) => {
    console.error('[STARTUP] Server could not start:', err.message);
    process.exit(1);
});
