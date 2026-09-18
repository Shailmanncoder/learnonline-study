// ================================================================
// Verified Source Library — API
//   /api/library/*        students (authenticated)
//   /api/library/admin/*  administrators (LIBRARY_ADMINS allowlist)
// ================================================================
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const libraryAdmin = require('../middleware/libraryAdmin');
const db = require('../config/db');
const { init } = require('../services/sourceLibrary/schema');
const collector = require('../services/sourceLibrary/collector');
const { searchQuestions, findSourceOfText } = require('../services/sourceLibrary/search');
const { buildCitation } = require('../services/sourceLibrary/citation');
const { toCard } = require('../services/sourceLibrary/libraryAnswer');
const { STATUS } = require('../services/sourceLibrary/verify');
const { getWeakTopics, getFacts } = require('../services/studyMemory');

const QUESTION_WITH_SOURCE = `
    SELECT q.*, d.official_url, d.edition, d.redistribution_allowed, d.usage_mode, d.license_status,
           d.discovered_label, d.status AS document_status, s.allowed_hosts, s.publisher AS source_publisher
    FROM questions q
    JOIN source_documents d ON d.id = q.document_id
    LEFT JOIN trusted_sources s ON s.id = d.trusted_source_id`;

const asyncRoute = (fn) => (req, res) => fn(req, res).catch((e) => {
    res.status(e.status || 500).json({ msg: e.message || 'Something went wrong' });
});

router.use(auth);

// ── Students ─────────────────────────────────────────────────────────
router.get('/search', asyncRoute(async (req, res) => {
    const q = String(req.query.q || '').slice(0, 300);
    if (q.trim().length < 3) return res.status(400).json({ msg: 'Say what you want to practise.' });
    const facts = await getFacts(req.user.id).catch(() => []);
    const weakTopics = await getWeakTopics(req.user.id).catch(() => []);
    const found = await searchQuestions(q, { facts, weakTopics });
    res.json({ chapter: found.chapter, total: found.total, cards: found.results.map(r => toCard(r.row, r.reasons)) });
}));

router.get('/questions/:id', asyncRoute(async (req, res) => {
    await init();
    const row = await db.get(`${QUESTION_WITH_SOURCE} WHERE q.id = ? AND q.verification_status <> ?`, [req.params.id, STATUS.REJECTED]);
    if (!row) return res.status(404).json({ msg: 'Question not found.' });
    res.json({ card: toCard(row) });
}));

router.post('/trace', asyncRoute(async (req, res) => {
    const text = String((req.body && req.body.text) || '').slice(0, 2000);
    const hit = await findSourceOfText(text);
    if (!hit) return res.json({ found: false, citation: buildCitation(null) });
    if (hit.ambiguous) return res.json({ found: false, ambiguous: true, count: hit.count, citation: buildCitation(null) });
    res.json({ found: true, card: toCard(hit.row) });
}));

// A page image of a document. Rendered for students ONLY when the licence
// permits redistribution; otherwise administrators alone may see it (for
// verification), and students are sent to the official source.
router.get('/documents/:id/pages/:page/image', asyncRoute(async (req, res, next) => {
    await init();
    const doc = await db.get('SELECT id, redistribution_allowed FROM source_documents WHERE id = ?', [req.params.id]);
    if (!doc) return res.status(404).json({ msg: 'Document not found.' });
    if (!Number(doc.redistribution_allowed)) {
        return libraryAdmin(req, res, () => sendPageImage(req, res));
    }
    return sendPageImage(req, res);
}));

async function sendPageImage(req, res) {
    const fs = require('node:fs');
    const path = require('node:path');
    const file = path.join(collector.STORE, `${Number(req.params.id)}.pdf`);
    const page = Number(req.params.page);
    if (!fs.existsSync(file)) return res.status(404).json({ msg: 'Document file not stored.' });
    const doc = await db.get('SELECT pdf_pages FROM source_documents WHERE id = ?', [req.params.id]);
    if (!Number.isInteger(page) || page < 1 || page > Number(doc.pdf_pages || 0)) return res.status(400).json({ msg: 'No such page.' });
    const { renderPageAsImage } = await import('unpdf');
    const png = await renderPageAsImage(new Uint8Array(fs.readFileSync(file)), page, {
        canvasImport: () => import('@napi-rs/canvas'), scale: 1.6
    });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'private, max-age=600');
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(Buffer.from(png));
}

// ── Administrators ───────────────────────────────────────────────────
const admin = express.Router();
admin.use(libraryAdmin);

admin.get('/me', (req, res) => res.json({ admin: req.libraryAdmin }));

admin.get('/stats', asyncRoute(async (req, res) => {
    await init();
    await collector.seedTrustedSources();
    const n = async (sql, p = []) => Number(((await db.get(sql, p)) || {}).n || 0);
    res.json({
        documentsProcessed: await n("SELECT COUNT(*) AS n FROM source_documents WHERE status = 'processed'"),
        documentsFailed: await n("SELECT COUNT(*) AS n FROM source_documents WHERE status = 'failed'"),
        questionsExtracted: await n('SELECT COUNT(*) AS n FROM questions'),
        autoVerified: await n('SELECT COUNT(*) AS n FROM questions WHERE verification_status = ?', [STATUS.AUTO_VERIFIED]),
        humanVerified: await n('SELECT COUNT(*) AS n FROM questions WHERE verification_status = ?', [STATUS.HUMAN_VERIFIED]),
        needsReview: await n('SELECT COUNT(*) AS n FROM questions WHERE verification_status = ?', [STATUS.UNVERIFIED]),
        rejected: await n('SELECT COUNT(*) AS n FROM questions WHERE verification_status = ?', [STATUS.REJECTED]),
        jobsRunning: await n("SELECT COUNT(*) AS n FROM ingestion_jobs WHERE status IN ('queued', 'running')")
    });
}));

admin.get('/sources', asyncRoute(async (req, res) => {
    await collector.seedTrustedSources();
    res.json({ sources: await db.all('SELECT * FROM trusted_sources ORDER BY id') });
}));

admin.post('/sources', express.json(), asyncRoute(async (req, res) => {
    try { res.status(201).json({ source: await collector.addTrustedSource(req.body || {}) }); }
    catch (e) { res.status(400).json({ msg: e.message }); }
}));

admin.post('/sources/:id/discover', express.json(), asyncRoute(async (req, res) => {
    const { classLevel, subject } = req.body || {};
    try {
        const r = await collector.discover(req.params.id, { classLevel: Number(classLevel), subject });
        res.json({ pageUrl: r.pageUrl, candidates: r.candidates, rejected: r.rejected, note: r.note });
    } catch (e) { res.status(400).json({ msg: e.message }); }
}));

admin.post('/sources/:id/ingest', express.json(), asyncRoute(async (req, res) => {
    const { classLevel, subject, units = [], includeAnswers = false } = req.body || {};
    const unitList = (Array.isArray(units) ? units : [units]).map(Number).filter(Number.isInteger);
    // Deliberately small by default: whole-book crawls are opt-in, one unit at a time.
    if (!unitList.length) return res.status(400).json({ msg: 'Choose at least one unit to ingest.' });
    if (unitList.length > 5) return res.status(400).json({ msg: 'Ingest at most 5 units per job.' });
    const jobId = await collector.createJob('ingest_discovered', {
        sourceId: Number(req.params.id), classLevel: Number(classLevel), subject, units: unitList, includeAnswers: Boolean(includeAnswers)
    }, req.libraryAdmin.id);
    res.status(202).json({ jobId });
}));

admin.post('/upload',
    express.raw({ type: ['application/pdf', 'application/octet-stream'], limit: (Number(process.env.LIBRARY_MAX_PDF_MB) || 40) * 1024 * 1024 }),
    asyncRoute(async (req, res) => {
        const meta = { ...req.query, filename: req.get('X-Filename') ? decodeURIComponent(req.get('X-Filename')) : req.query.filename };
        if (String(meta.permission_confirmed) !== 'true') {
            return res.status(400).json({ msg: 'Confirm that you are authorised to index this document.' });
        }
        try {
            const documentId = await collector.registerUpload(req.body, meta, req.libraryAdmin.id);
            const jobId = await collector.createJob('process_document', { documentId }, req.libraryAdmin.id);
            res.status(202).json({ documentId, jobId });
        } catch (e) { res.status(400).json({ msg: e.message }); }
    }));

admin.get('/jobs', asyncRoute(async (req, res) => {
    await init();
    res.json({ jobs: await db.all('SELECT id, kind, status, progress, message, created_at, started_at, finished_at FROM ingestion_jobs ORDER BY id DESC LIMIT 50') });
}));
admin.get('/jobs/:id', asyncRoute(async (req, res) => {
    const job = await db.get('SELECT * FROM ingestion_jobs WHERE id = ?', [req.params.id]);
    if (!job) return res.status(404).json({ msg: 'Job not found.' });
    res.json({ job });
}));

admin.get('/documents', asyncRoute(async (req, res) => {
    await init();
    res.json({ documents: await db.all(
        `SELECT d.id, d.publisher, d.source_type, d.book_title, d.class_level, d.subject, d.unit_number, d.chapter,
                d.discovered_label, d.document_url, d.status, d.error, d.pdf_pages, d.content_hash, d.bytes,
                d.printed_page_method, d.printed_page_offset, d.usage_mode, d.license_status, d.redistribution_allowed,
                d.date_discovered, d.date_last_checked, d.processed_at,
                (SELECT COUNT(*) FROM questions q WHERE q.document_id = d.id) AS questions,
                (SELECT COUNT(*) FROM questions q WHERE q.document_id = d.id AND q.verification_status = 'UNVERIFIED') AS needs_review
         FROM source_documents d ORDER BY d.id DESC`) });
}));

admin.post('/documents/:id/reprocess', asyncRoute(async (req, res) => {
    const doc = await db.get('SELECT id FROM source_documents WHERE id = ?', [req.params.id]);
    if (!doc) return res.status(404).json({ msg: 'Document not found.' });
    res.status(202).json({ jobId: await collector.createJob('process_document', { documentId: doc.id }, req.libraryAdmin.id) });
}));

admin.get('/documents/:id/pages/:page', asyncRoute(async (req, res) => {
    const page = await db.get(
        'SELECT pdf_page_index, printed_page, printed_page_evidence, page_width, page_height, raw_text FROM document_pages WHERE document_id = ? AND pdf_page_index = ?',
        [req.params.id, req.params.page]);
    if (!page) return res.status(404).json({ msg: 'Page not found.' });
    res.json({ page });
}));

admin.get('/questions', asyncRoute(async (req, res) => {
    await init();
    const where = [];
    const params = [];
    if (req.query.status) { where.push('q.verification_status = ?'); params.push(String(req.query.status)); }
    if (req.query.documentId) { where.push('q.document_id = ?'); params.push(Number(req.query.documentId)); }
    if (req.query.q) { where.push('LOWER(q.question_text) LIKE ?'); params.push(`%${String(req.query.q).toLowerCase().slice(0, 100)}%`); }
    const rows = await db.all(
        `SELECT q.id, q.document_id, q.kind, q.chapter, q.section, q.question_number, q.start_pdf_page, q.end_pdf_page,
                q.printed_page, q.verification_status, q.verification_notes, substr(q.question_text, 1, 220) AS preview
         FROM questions q ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY q.document_id, q.kind DESC, CAST(q.question_number AS INTEGER) LIMIT 500`, params);
    res.json({ questions: rows });
}));

admin.get('/questions/:id', asyncRoute(async (req, res) => {
    const row = await db.get(`${QUESTION_WITH_SOURCE} WHERE q.id = ?`, [req.params.id]);
    if (!row) return res.status(404).json({ msg: 'Question not found.' });
    const logs = await db.all('SELECT * FROM verification_logs WHERE question_id = ? ORDER BY id DESC LIMIT 20', [row.id]);
    res.json({ question: row, citation: buildCitation(row), logs });
}));

async function setStatus(req, res, to) {
    const row = await db.get('SELECT * FROM questions WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ msg: 'Question not found.' });
    await db.run('UPDATE questions SET verification_status = ?, verified_by = ?, verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [to, req.libraryAdmin.id, row.id]);
    await db.run('INSERT INTO verification_logs (question_id, admin_user_id, action, from_status, to_status, note) VALUES (?, ?, ?, ?, ?, ?)',
        [row.id, req.libraryAdmin.id, to === STATUS.HUMAN_VERIFIED ? 'approve' : 'reject', row.verification_status, to,
         req.body && req.body.note ? String(req.body.note).slice(0, 600) : null]);
    res.json({ id: row.id, verification_status: to });
}
admin.post('/questions/:id/approve', express.json(), asyncRoute((req, res) => setStatus(req, res, STATUS.HUMAN_VERIFIED)));
admin.post('/questions/:id/reject', express.json(), asyncRoute((req, res) => setStatus(req, res, STATUS.REJECTED)));

// Editing provenance invalidates any earlier verification: the edited record
// must be approved again before it is shown as verified.
const EDITABLE = {
    question_number: v => (v === null || v === '' ? null : (/^\d{1,3}(?:\.\d{1,3})?$/.test(String(v)) ? String(v) : undefined)),
    printed_page: v => (v === null || v === '' ? null : (Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) < 5000 ? Number(v) : undefined)),
    chapter: v => (v === null || v === '' ? null : String(v).slice(0, 255)),
    section: v => (v === null || v === '' ? null : String(v).slice(0, 120)),
    question_text: v => (String(v || '').trim().length >= 3 ? String(v).replace(/\r/g, '').slice(0, 5000) : undefined)
};
admin.patch('/questions/:id', express.json(), asyncRoute(async (req, res) => {
    const row = await db.get('SELECT * FROM questions WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ msg: 'Question not found.' });
    const changes = {};
    for (const [field, clean] of Object.entries(EDITABLE)) {
        if (!(field in (req.body || {}))) continue;
        const value = clean(req.body[field]);
        if (value === undefined) return res.status(400).json({ msg: `Invalid value for ${field}.` });
        if (String(value) !== String(row[field])) changes[field] = { from: row[field], to: value };
    }
    if (!Object.keys(changes).length) return res.json({ id: row.id, changed: false });
    const sets = Object.keys(changes).map(f => `${f} = ?`);
    await db.run(`UPDATE questions SET ${sets.join(', ')}, verification_status = ?, verified_by = NULL, verified_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [...Object.values(changes).map(c => c.to), STATUS.UNVERIFIED, row.id]);
    await db.run('INSERT INTO verification_logs (question_id, admin_user_id, action, from_status, to_status, changes_json) VALUES (?, ?, ?, ?, ?, ?)',
        [row.id, req.libraryAdmin.id, 'edit', row.verification_status, STATUS.UNVERIFIED, JSON.stringify(changes).slice(0, 2000)]);
    res.json({ id: row.id, changed: true, verification_status: STATUS.UNVERIFIED });
}));

router.use('/admin', admin);

module.exports = router;
