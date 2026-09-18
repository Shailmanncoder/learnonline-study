const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

require('./config/security').getJwtSecret();

const app = express();

app.use(cors());
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
app.use('/api/teacher',      teacherRoutes);
app.use('/api/classroom',    classroomRoutes);
app.use('/api/study',        studyRoutes);
app.use('/api/gamification', gamificationRoutes);

// Verified Source Library admin screen. The page itself holds no data; every
// call it makes is checked against the LIBRARY_ADMINS allowlist server-side.
app.get(['/admin/sources', '/admin/sources/'], (req, res) => {
    res.set('X-Frame-Options', 'DENY');
    res.sendFile(path.join(__dirname, '../frontend', 'admin-sources.html'));
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
