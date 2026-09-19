const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const memory = require('../services/memoryDocs');

router.use(auth);

// Limits the client can show before a doomed upload starts.
router.get('/limits', (req, res) => {
    res.json({ maxMb: memory.MAX_MB, maxDocs: memory.MAX_DOCS_PER_USER });
});

router.get('/docs', async (req, res) => {
    try { res.json({ success: true, docs: await memory.listDocs(req.user.id) }); }
    catch (e) { res.status(500).json({ success: false, msg: e.message }); }
});

// The PDF is the raw request body, not multipart: no extra dependency, and
// express.raw enforces the size cap before any bytes reach the parser.
// Labels travel in query parameters.
router.post('/docs',
    express.raw({ type: ['application/pdf', 'application/octet-stream'], limit: memory.MAX_BYTES }),
    async (req, res) => {
        try {
            const doc = await memory.saveUpload(req.user.id, req.body, {
                filename: req.get('X-Filename') ? decodeURIComponent(req.get('X-Filename')) : req.query.filename,
                title: req.query.title,
                classLabel: req.query.classLabel,
                bookName: req.query.bookName,
                language: req.query.language
            });
            res.status(201).json({ success: true, doc });
        } catch (e) {
            res.status(e.status || 500).json({ success: false, msg: e.message });
        }
    });

router.patch('/docs/:id', async (req, res) => {
    try {
        const doc = await memory.updateDoc(req.user.id, req.params.id, req.body || {});
        if (!doc) return res.status(404).json({ success: false, msg: 'Document not found' });
        res.json({ success: true, doc });
    } catch (e) { res.status(500).json({ success: false, msg: e.message }); }
});

router.delete('/docs/:id', async (req, res) => {
    try {
        const ok = await memory.deleteDoc(req.user.id, req.params.id);
        if (!ok) return res.status(404).json({ success: false, msg: 'Document not found' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, msg: e.message }); }
});

// express.raw rejects oversize bodies before the handler runs; answer in the
// same JSON shape as everything else instead of Express's HTML error page.
router.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
        return res.status(413).json({ success: false, msg: `That PDF is larger than the ${memory.MAX_MB} MB limit.` });
    }
    next(err);
});

module.exports = router;
