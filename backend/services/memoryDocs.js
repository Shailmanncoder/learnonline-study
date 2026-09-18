// ================================================================
// Memory documents — a student's own uploaded PDFs
// ----------------------------------------------------------------
// A student uploads a book (or notes) and labels it with a class and a
// book name. When a later question names that book, the tutor answers
// from the PDF they gave it, and only from that PDF.
//
// Text is extracted once at upload. Pages that come out empty or broken —
// scanned pages, or Devanagari PDFs whose font map is garbage — are OCR'd
// in the background, one document at a time, so an upload never blocks a
// request. The same integrity checks that guard the NCERT corpus decide
// what needs OCR.
// ================================================================
const fs = require('node:fs');
const path = require('node:path');
const db = require('../config/db');
const { scanIndic, looksLegacyEncoded } = require('./ncertSource');
const { namesTitle, romanize, tokens } = require('./translit');

const ROOT = path.join(__dirname, '..', 'database', 'memory-docs');
const MAX_MB = Math.min(60, Math.max(1, Number(process.env.MEMORY_MAX_MB) || 20));
const MAX_BYTES = MAX_MB * 1024 * 1024;
const MAX_DOCS_PER_USER = 30;
const NAME_MIN = 0.6;          // same bar as naming an NCERT book
const PAGE_MIN_CHARS = 40;     // below this a page is treated as unreadable

const DOC_KEY = 'memdoc';
const DOC_LABEL_KEY = 'memdoc_label';

let ready;
function init() {
    return ready ||= (async () => {
        // db.dialect() reports 'mysql' until the connection has settled, so
        // it must be awaited first. Reading it early created a MySQL-style
        // "INT AUTO_INCREMENT" key on SQLite, which never fills in: every
        // upload got a NULL id and could never be found or processed.
        await db.ready();
        const mysql = db.dialect() === 'mysql';
        const id = mysql ? 'INT AUTO_INCREMENT PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
        const big = mysql ? 'MEDIUMTEXT' : 'TEXT';
        await db.run(`CREATE TABLE IF NOT EXISTS memory_docs (
            id ${id},
            user_id INTEGER NOT NULL,
            title VARCHAR(200) NOT NULL,
            class_label VARCHAR(40),
            book_name VARCHAR(200),
            language VARCHAR(20) DEFAULT 'auto',
            filename VARCHAR(255),
            bytes INTEGER DEFAULT 0,
            pages INTEGER DEFAULT 0,
            pages_done INTEGER DEFAULT 0,
            chars INTEGER DEFAULT 0,
            status VARCHAR(20) DEFAULT 'processing',
            error VARCHAR(300),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        await db.run(`CREATE TABLE IF NOT EXISTS memory_doc_pages (
            doc_id INTEGER NOT NULL,
            page INTEGER NOT NULL,
            text ${big},
            ocr INTEGER DEFAULT 0,
            PRIMARY KEY (doc_id, page)
        )`);
        await db.run('CREATE INDEX IF NOT EXISTS idx_memdocs_user ON memory_docs(user_id)').catch(() => {});

        // Repair a table created by that bug. Rows with a NULL id cannot be
        // addressed at all, so nothing usable is lost by rebuilding it.
        if (!mysql) {
            const def = await db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_docs'");
            if (def && !/AUTOINCREMENT/i.test(def.sql || '')) {
                await db.run('DROP TABLE memory_docs');
                await db.run('DELETE FROM memory_doc_pages');
                ready = null;
                return init();
            }
        }
    })().catch((e) => { ready = null; throw e; });
}

const fileFor = (userId, docId) => path.join(ROOT, String(Number(userId)), `${Number(docId)}.pdf`);

// A PDF starts with "%PDF-" within its first bytes. The Content-Type header is
// whatever the client claims; the bytes are what the parser will actually get.
function isPdf(buf) {
    if (!buf || buf.length < 5) return false;
    return buf.subarray(0, 1024).includes(Buffer.from('%PDF-'));
}

function cleanLabel(v, max = 200) {
    return String(v || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// "9", "class 9", "Class IX" -> "Class 9"
function normaliseClass(v) {
    const s = String(v || '').trim();
    if (!s) return '';
    const roman = { i:1, ii:2, iii:3, iv:4, v:5, vi:6, vii:7, viii:8, ix:9, x:10, xi:11, xii:12 };
    const d = s.match(/(\d{1,2})/);
    if (d && Number(d[1]) >= 1 && Number(d[1]) <= 12) return `Class ${Number(d[1])}`;
    const r = s.toLowerCase().replace(/class|grade|std/g, '').trim();
    return roman[r] ? `Class ${roman[r]}` : '';
}

async function listDocs(userId) {
    await init();
    return db.all(
        `SELECT id, title, class_label, book_name, language, filename, bytes, pages, pages_done,
                chars, status, error, created_at, updated_at
         FROM memory_docs WHERE user_id = ? ORDER BY updated_at DESC`, [userId]);
}

async function getDoc(userId, docId) {
    await init();
    return db.get('SELECT * FROM memory_docs WHERE id = ? AND user_id = ?', [docId, userId]);
}

async function saveUpload(userId, buffer, meta = {}) {
    await init();
    if (!buffer || !buffer.length) throw Object.assign(new Error('The file is empty.'), { status: 400 });
    if (buffer.length > MAX_BYTES) {
        throw Object.assign(new Error(`That PDF is larger than the ${MAX_MB} MB limit.`), { status: 413 });
    }
    if (!isPdf(buffer)) throw Object.assign(new Error('Only PDF files can be added to memory.'), { status: 415 });

    const count = await db.get('SELECT COUNT(*) AS n FROM memory_docs WHERE user_id = ?', [userId]);
    if (Number(count?.n || 0) >= MAX_DOCS_PER_USER) {
        throw Object.assign(new Error(`Memory holds up to ${MAX_DOCS_PER_USER} documents. Delete one to add another.`), { status: 409 });
    }

    const filename = cleanLabel(meta.filename || 'document.pdf', 255);
    const title = cleanLabel(meta.title) || filename.replace(/\.pdf$/i, '');
    const language = ['english', 'hindi', 'auto'].includes(String(meta.language).toLowerCase())
        ? String(meta.language).toLowerCase() : 'auto';

    const r = await db.run(
        `INSERT INTO memory_docs (user_id, title, class_label, book_name, language, filename, bytes, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'processing')`,
        [userId, title, normaliseClass(meta.classLabel) || null, cleanLabel(meta.bookName) || null,
         language, filename, buffer.length]);
    const docId = r.lastID;

    const file = fileFor(userId, docId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buffer);

    enqueue(docId);
    return getDoc(userId, docId);
}

async function updateDoc(userId, docId, patch = {}) {
    const doc = await getDoc(userId, docId);
    if (!doc) return null;
    const title = patch.title !== undefined ? (cleanLabel(patch.title) || doc.title) : doc.title;
    const classLabel = patch.classLabel !== undefined ? (normaliseClass(patch.classLabel) || null) : doc.class_label;
    const bookName = patch.bookName !== undefined ? (cleanLabel(patch.bookName) || null) : doc.book_name;
    await db.run(
        'UPDATE memory_docs SET title = ?, class_label = ?, book_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [title, classLabel, bookName, doc.id]);
    return getDoc(userId, docId);
}

async function deleteDoc(userId, docId) {
    const doc = await getDoc(userId, docId);
    if (!doc) return false;
    await db.run('DELETE FROM memory_doc_pages WHERE doc_id = ?', [doc.id]);
    await db.run('DELETE FROM memory_docs WHERE id = ?', [doc.id]);
    try { fs.unlinkSync(fileFor(userId, doc.id)); } catch (e) { /* already gone */ }
    return true;
}

// ── Processing queue ────────────────────────────────────────────────
// One document at a time: OCR is CPU-heavy, and running several at once on
// a small server starves the requests students are actually waiting on.
const queue = [];
let working = false;

function enqueue(docId) {
    queue.push(docId);
    if (!working) drain();
}

async function drain() {
    working = true;
    while (queue.length) {
        const docId = queue.shift();
        try { await processDoc(docId); }
        catch (e) {
            await db.run("UPDATE memory_docs SET status = 'failed', error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                [String(e.message || 'Processing failed').slice(0, 300), docId]).catch(() => {});
        }
    }
    working = false;
}

function ocrLanguage(language) {
    if (language === 'english') return 'eng';
    if (language === 'hindi') return 'hin+eng';
    return 'eng+hin';
}

async function processDoc(docId) {
    const doc = await db.get('SELECT * FROM memory_docs WHERE id = ?', [docId]);
    if (!doc) return;
    const raw = fs.readFileSync(fileFor(doc.user_id, doc.id));

    const { getDocumentProxy, extractText, renderPageAsImage } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(raw));
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = (text || []).map((t, i) => ({ page: i + 1, text: String(t || '').trim(), ocr: 0 }));
    const total = pages.length;
    await db.run('UPDATE memory_docs SET pages = ?, pages_done = 0 WHERE id = ?', [total, doc.id]);

    // Whole-document corruption means every page needs OCR; otherwise only
    // the pages that came out empty (scans, image-only pages).
    const joined = pages.map(p => p.text).join(' ');
    const legacyMedium = doc.language === 'hindi' ? 'Hindi' : null;
    const brokenFont = scanIndic(joined).garbled || (legacyMedium && looksLegacyEncoded(joined, legacyMedium));
    const needsOcr = pages.filter(p => brokenFont || p.text.length < PAGE_MIN_CHARS);

    let worker = null;
    try {
        if (needsOcr.length) {
            const { createWorker } = require('tesseract.js');
            worker = await createWorker(ocrLanguage(doc.language));
        }
        let done = 0;
        for (const p of pages) {
            if (worker && (brokenFont || p.text.length < PAGE_MIN_CHARS)) {
                // pdf.js detaches the buffer it is handed; every render needs its own copy.
                const png = await renderPageAsImage(new Uint8Array(raw), p.page, {
                    canvasImport: () => import('@napi-rs/canvas'), scale: 2
                });
                const { data } = await worker.recognize(Buffer.from(png));
                p.text = String(data.text || '').trim();
                p.ocr = 1;
            }
            await db.run('DELETE FROM memory_doc_pages WHERE doc_id = ? AND page = ?', [doc.id, p.page]);
            await db.run('INSERT INTO memory_doc_pages (doc_id, page, text, ocr) VALUES (?, ?, ?, ?)',
                [doc.id, p.page, p.text, p.ocr]);
            done++;
            if (done % 5 === 0 || done === total) {
                await db.run('UPDATE memory_docs SET pages_done = ? WHERE id = ?', [done, doc.id]);
            }
        }
    } finally {
        if (worker) await worker.terminate().catch(() => {});
    }

    const chars = pages.reduce((n, p) => n + p.text.length, 0);
    const readable = pages.filter(p => p.text.length >= PAGE_MIN_CHARS).length;
    const status = readable === 0 ? 'failed' : 'ready';
    await db.run(
        `UPDATE memory_docs SET status = ?, chars = ?, pages_done = ?, error = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [status, chars, total, status === 'failed' ? 'No readable text could be extracted from this PDF.' : null, doc.id]);
}

// Resume anything interrupted by a restart.
async function resumePending() {
    try {
        await init();
        const rows = await db.all("SELECT id FROM memory_docs WHERE status = 'processing' ORDER BY id");
        rows.forEach(r => enqueue(r.id));
    } catch (e) { /* non-fatal */ }
}

// ── Matching a question to an upload ────────────────────────────────
const RELEASE = /\b(exit|leave|close|clear|remove|stop using|unselect)\s+(this\s+|the\s+|my\s+)?(pdf|upload|document|file|book)\b|\b(all|any|my own)\s+(books|textbooks)\b|\bback to (my )?(textbook|books|syllabus)\b|\b(pdf|upload)\s+(hatao|chhodo|band karo)\b|(सभी|सारी|कोई भी)\s*(किताब|किताबें|पुस्तक)/i;
const UPLOAD_REF = /\b(my|mera|meri|mere)\s+(pdf|upload|uploaded|document|notes|file)\b|\b(uploaded|upload ki hui|jo maine upload)\b|मेरी\s*(पीडीएफ|फाइल)/i;

function gradeIn(question) {
    const t = String(question || '');
    const d = t.match(/\b(?:class|grade|std|standard|kaksha)\s*[-–]?\s*(\d{1,2})\b/i);
    if (d) return `Class ${Number(d[1])}`;
    const r = t.match(/\b(?:class|grade|std)\s*[-–]?\s*(xii|xi|x|ix|viii|vii|vi|v|iv|iii|ii|i)\b/i);
    return r ? normaliseClass(r[1]) : '';
}

// Which upload, if any, answers this question.
//   { doc, changed, released, stale, candidates }
async function resolveMemoryDoc(userId, facts, question) {
    await init();
    const get = (k) => (facts || []).find(f => f.mem_key === k)?.mem_value || '';
    const held = get(DOC_KEY);
    if (RELEASE.test(question || '')) return { doc: null, released: Boolean(held) };

    const docs = await db.all(
        "SELECT id, title, class_label, book_name, pages, status FROM memory_docs WHERE user_id = ? ORDER BY updated_at DESC",
        [userId]);
    const usable = docs.filter(d => d.status === 'ready');
    const named = gradeIn(question);

    let best = null;
    for (const d of usable) {
        // A class named in the question must agree with the class on the upload.
        if (named && d.class_label && d.class_label !== named) continue;
        const score = Math.max(
            d.book_name ? namesTitle(question, d.book_name) : 0,
            namesTitle(question, d.title || ''));
        if (score >= NAME_MIN && (!best || score > best.score)) best = { ...d, score };
    }
    if (!best && UPLOAD_REF.test(question || '') && usable.length) best = usable[0];
    if (best) return { doc: best, changed: String(best.id) !== String(held), candidates: docs.length };

    if (held) {
        const d = usable.find(x => String(x.id) === String(held));
        if (!d) return { doc: null, stale: true, candidates: docs.length };
        return { doc: d, candidates: docs.length };
    }
    return { doc: null, candidates: docs.length, processing: docs.filter(d => d.status === 'processing').length };
}

// The pages of an upload that bear on the question, within a character
// budget. Literal term overlap in both scripts, like the chapter lock — the
// English embedding model ranks Devanagari text close to randomly.
const FILLER = new Set(('kaise kya kyu kyun hai hain ho hota hoti hote tha thi ka ke ki ko se me mein ' +
    'batao samjhao explain please tell about what is are was how why who which when where do does ' +
    'the a an of to in on for and or this that it its iska isme yeh ye woh aur bhi my mera meri pdf ' +
    'upload uploaded book kitab class chapter page').split(' '));

async function findPages(docId, question, budget = 9000) {
    const rows = await db.all('SELECT page, text FROM memory_doc_pages WHERE doc_id = ? ORDER BY page', [docId]);
    const pages = rows.filter(r => (r.text || '').length >= PAGE_MIN_CHARS);
    if (!pages.length) return { pages: [], total: 0, partial: false };

    // An explicit "page 12" is the most precise thing a student can say.
    const asked = [...String(question || '').matchAll(/\b(?:page|pg|p\.|prishth|पृष्ठ)\s*(\d{1,4})\b/gi)].map(m => Number(m[1]));
    if (asked.length) {
        const exact = pages.filter(p => asked.includes(p.page));
        if (exact.length) return { pages: exact, total: pages.length, partial: exact.length < pages.length, byPage: true };
    }

    const words = String(question || '').toLocaleLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) || [];
    const raw = [...new Set(words.filter(w => w.length >= 3 && !FILLER.has(w)))];
    const roman = [...new Set(raw.flatMap(w => tokens(w)).filter(t => t.length >= 3))];

    const scored = pages.map((p, i) => {
        const hay = p.text.toLocaleLowerCase();
        const rom = romanize(p.text);
        let score = 0;
        for (const t of raw) if (hay.includes(t)) score++;
        for (const t of roman) if (rom.includes(t)) score++;
        return { ...p, i, score };
    });

    const total = scored.reduce((n, p) => n + p.text.length, 0);
    let picked;
    if (scored.some(p => p.score > 0)) {
        let used = 0;
        picked = [...scored].sort((a, b) => b.score - a.score || a.i - b.i).filter((p) => {
            if (p.score === 0 || used + p.text.length > budget) return false;
            used += p.text.length;
            return true;
        }).sort((a, b) => a.i - b.i);
    } else {
        // Nothing matched literally (a summary, say): sample across the whole
        // document instead of only its opening pages.
        const stride = total > budget ? Math.ceil(total / budget) : 1;
        picked = scored.filter((_, i) => i % stride === 0);
    }
    const covered = picked.reduce((n, p) => n + p.text.length, 0);
    return { pages: picked, total: pages.length, partial: covered < total };
}

module.exports = {
    init, listDocs, getDoc, saveUpload, updateDoc, deleteDoc, resumePending,
    resolveMemoryDoc, findPages, isPdf, normaliseClass, gradeIn,
    DOC_KEY, DOC_LABEL_KEY, MAX_MB, MAX_BYTES, MAX_DOCS_PER_USER
};
