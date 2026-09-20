const router = require('express').Router();
const auth = require('../middleware/auth');
const { createStore } = require('../services/ncertStore');
const { createTutor, createAutoTutor, createVectorTutor } = require('../services/ncertTutor');
const { generateJSON } = require('../services/ai');
const store = createStore(require('../config/db'));
const answer = createTutor({ store, generateJSON });
// Picks the book and chapter itself from class + subject, so callers never
// have to know a DIKSHA content id.
const answerAuto = createAutoTutor({ store, generateJSON, answerChapter: answer });

// Semantic retrieval when the pgvector corpus is available; the keyword
// tutor stays as the fallback so a Postgres outage degrades the answers
// rather than taking the tutor offline.
let answerVector = null;
if (process.env.NCERT_PG_URL) {
    try {
        const { createPgCorpus } = require('../services/ncertPg');
        const { embedOne } = require('../services/embedder');
        const corpus = createPgCorpus();
        corpus.init().catch(e => { console.warn('[NCERT] pgvector unavailable:', e.message); answerVector = null; });
        answerVector = createVectorTutor({ corpus, embedOne, generateJSON });
    } catch (e) {
        console.warn('[NCERT] semantic search disabled:', e.message);
    }
}
// Is the corpus actually reachable from THIS deploy? A production server
// pointing NCERT_PG_URL at a host with no pgvector fails in 2ms and silently
// serves ungrounded answers — fast, plausible, and wrong. This makes that
// visible instead of invisible.
router.get('/health', async (req, res) => {
    const url = process.env.NCERT_PG_URL;
    if (!url) return res.json({ corpus: 'not_configured', grounded: false });
    try {
        const { createPgCorpus } = require('../services/ncertPg');
        const corpus = createPgCorpus();
        const stats = await corpus.stats();
        await corpus.pool.end().catch(() => {});
        res.json({ corpus: 'ok', grounded: stats.chunks > 0, ...stats });
    } catch (e) {
        res.status(503).json({ corpus: 'unreachable', grounded: false, error: e.message });
    }
});

// Public catalog endpoints for the online study app
router.get('/catalog', async (req, res, next) => {
    try {
        const db = require('../config/db');
        const classes = [...new Set((await db.all(
            'SELECT DISTINCT class_level FROM source_documents WHERE class_level IS NOT NULL ORDER BY CAST(class_level AS INTEGER)'
        )).map(r => r.class_level))];
        const catalog = {};
        for (const cls of classes) {
            const books = await db.all(
                'SELECT DISTINCT subject FROM source_documents WHERE class_level = ? ORDER BY subject',
                [cls]
            );
            catalog[cls] = books.map(b => b.subject).filter(Boolean);
        }
        res.json({ classes, catalog });
    } catch (e) { next(e); }
});

router.get('/study/:classLevel/:subject', async (req, res, next) => {
    try {
        const db = require('../config/db');
        const { classLevel, subject } = req.params;
        const docs = await db.all(
            `SELECT DISTINCT chapter, id FROM source_documents
             WHERE class_level = ? AND subject = ? AND chapter IS NOT NULL
             ORDER BY chapter`,
            [classLevel, subject]
        );
        const chapters = docs.map(d => ({ id: d.id, title: d.chapter }));
        res.json({ chapters });
    } catch (e) { next(e); }
});

router.get('/chapter/:docId', async (req, res, next) => {
    try {
        const db = require('../config/db');
        const { docId } = req.params;
        const doc = await db.get(
            'SELECT * FROM source_documents WHERE id = ?',
            [docId]
        );
        if (!doc) return res.status(404).json({ msg: 'Chapter not found' });
        const questions = await db.all(
            'SELECT id, question, options, correct_answer FROM questions WHERE source_document_id = ? LIMIT 5',
            [docId]
        );
        res.json({
            document: { title: doc.chapter, class: doc.class_level, subject: doc.subject },
            questions: questions.map(q => ({
                id: q.id,
                question: q.question,
                options: q.options ? JSON.parse(q.options) : [],
                correctAnswer: q.correct_answer
            }))
        });
    } catch (e) { next(e); }
});

router.use(auth);
router.get('/status', (req, res) => {
    const fs = require('node:fs');
    const file = require('node:path').join(__dirname, '../database/ncert-sync-status.json');
    if (!fs.existsSync(file)) return res.json({state:'not_started'});
    try {
        const {errors, error, ...status} = JSON.parse(fs.readFileSync(file, 'utf8'));
        res.json(status);
    } catch { res.status(503).json({msg:'Import status is temporarily unavailable.'}); }
});
router.get('/books', async (req, res, next) => {
    try { res.json({ books: await store.all() }); } catch (e) { next(e); }
});
router.post('/ask', async (req, res, next) => {
    try { const result = await answer(req.body || {}); res.status(result.status).json(result.body); }
    catch (e) { next(e); }
});
// { grade, subject?, medium?, question } — no book/chapter id required.
router.post('/ask-auto', async (req, res, next) => {
    try {
        let result = null;
        if (answerVector) {
            try { result = await answerVector(req.body || {}); }
            catch (e) { console.warn('[NCERT] semantic search failed, using keyword:', e.message); }
        }
        // Keyword search can still hit when the phrasing is literal.
        if (!result || (result.status === 200 && !result.body.grounded)) {
            const fallback = await answerAuto(req.body || {});
            if (fallback.status === 200 && fallback.body.grounded) result = fallback;
            else result = result || fallback;
        }
        res.status(result.status).json(result.body);
    } catch (e) { next(e); }
});
router.get('/chapters', async (req, res, next) => {
    try {
        const { grade, subject, medium } = req.query;
        res.json({ chapters: await store.findChapters({ grade, subject, medium, limit: 200 }) });
    } catch (e) { next(e); }
});
module.exports = router;
