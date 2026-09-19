#!/usr/bin/env node
// ================================================================
// OCR the chapters whose PDF text extraction produced garbage.
// ----------------------------------------------------------------
// Many DIKSHA Devanagari PDFs carry a broken font-to-Unicode map, so the
// extracted text looks like Hindi but is not ("मक" for "कि"). Rendering the
// page and reading the pixels sidesteps the font entirely. Measured on a
// Class 9 Hindi page: unpdf scored 0.128 on the integrity check, OCR scored
// 0.0000 at 93% confidence.
//
// Resumable: a chapter is rewritten only once its OCR passes the same
// integrity check, so finished chapters are skipped on a later run and a
// page that OCR cannot read stays quarantined rather than becoming a
// plausible-looking answer.
//
//   node scripts/ocr-ncert.js [--limit 20] [--workers 4] [--medium Hindi] [--book गंगा]
// ================================================================
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createWorker } = require('tesseract.js');
const { createPgCorpus } = require('../services/ncertPg');
const { createStore } = require('../services/ncertStore');
const { scanIndic, safeUrl } = require('../services/ncertSource');
const { embedAll } = require('../services/embedder');
const db = require('../config/db');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const LIMIT = Number(arg('--limit', Infinity));
const WORKERS = Math.max(1, Math.min(8, Number(arg('--workers', 4))));
const ONLY_MEDIUM = arg('--medium', null);
const ONLY_BOOK = arg('--book', null);   // substring of the book title

// Tesseract language per medium. Most of these are Devanagari, which `hin`
// reads well; only models known to ship are named, because a missing one
// fails the whole worker.
const LANG = {
    Hindi: 'hin', Marathi: 'mar', Nepali: 'nep', Sanskrit: 'san',
    Maithili: 'hin', Dogri: 'hin', Konkani: 'hin', Bodo: 'hin',
    Santhali: 'hin', Santali: 'hin', Sindhi: 'hin', Kashmiri: 'hin',
    Bengali: 'ben', Assamese: 'asm', Punjabi: 'pan', Gujarati: 'guj',
    Tamil: 'tam', Telugu: 'tel', Kannada: 'kan', Malayalam: 'mal',
    Oriya: 'ori', Odia: 'ori', Urdu: 'urd', English: 'eng'
};
const langFor = (m) => LANG[m] || 'hin';

const CHUNK = 1400;
const STEP = 1100;

function chunkPages(pages) {
    const out = [];
    for (const page of pages) {
        const text = (page.text || '').trim();
        if (text.length < 40) continue;
        for (let s = 0; s < text.length; s += STEP) {
            const slice = text.slice(s, s + CHUNK).trim();
            if (slice.length >= 60) out.push({ page: page.page, text: slice });
        }
    }
    return out;
}

async function fetchPdf(url) {
    const res = await fetch(safeUrl(url), { signal: AbortSignal.timeout(180000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Kept as a Buffer: pdf.js DETACHES the typed array it is handed, so the
    // second page render would otherwise fail with "Cannot transfer object of
    // unsupported type". Each render gets its own copy.
    return Buffer.from(await res.arrayBuffer());
}

(async () => {
    const corpus = createPgCorpus();
    const store = createStore(db);
    const { renderPageAsImage } = await import('unpdf');

    const where = ["ch.status = 'garbled'"];
    const params = [];
    if (ONLY_MEDIUM) { params.push(ONLY_MEDIUM); where.push(`b.medium = $${params.length}`); }
    if (ONLY_BOOK) { params.push(`%${ONLY_BOOK}%`); where.push(`b.name LIKE $${params.length}`); }
    const { rows } = await corpus.pool.query(
        `SELECT ch.id, ch.book_id, ch.name, b.medium, b.grade, b.subject
         FROM ncert_chapters ch JOIN ncert_books b ON b.id = ch.book_id
         WHERE ${where.join(' AND ')} ORDER BY b.medium, ch.book_id, ch.position`, params);

    const queue = rows.slice(0, LIMIT === Infinity ? rows.length : LIMIT);
    console.log(`${queue.length} garbled chapters queued · ${WORKERS} workers\n`);

    let done = 0, fixed = 0, failed = 0, pagesOcr = 0, stillBad = 0;
    const t0 = Date.now();
    let next = 0;

    async function runWorker() {
        let worker = null;
        let workerLang = null;
        while (next < queue.length) {
            const item = queue[next++];
            try {
                const lang = langFor(item.medium);
                if (workerLang !== lang) {
                    if (worker) await worker.terminate();
                    worker = await createWorker(lang);
                    workerLang = lang;
                }

                const row = await db.get('SELECT payload FROM ncert_books WHERE id = ?', [item.book_id]);
                if (!row) throw new Error('book missing from store');
                const book = JSON.parse(row.payload);
                const chapter = (book.chapters || []).find((c) => c.id === item.id);
                if (!chapter || !chapter.url) throw new Error('chapter has no source url');

                const pdf = await fetchPdf(chapter.url);
                const pageCount = (chapter.pages || []).length;
                const pages = [];
                for (let p = 1; p <= pageCount; p++) {
                    const png = await renderPageAsImage(new Uint8Array(pdf), p, {
                        canvasImport: () => import('@napi-rs/canvas'),
                        scale: 2
                    });
                    const { data } = await worker.recognize(Buffer.from(png));
                    pages.push({ page: p, text: (data.text || '').trim() });
                    pagesOcr++;
                }

                const check = scanIndic(pages.map((p) => p.text).join(' '));
                if (check.garbled) {
                    // OCR did not help either; leave it quarantined.
                    stillBad++; done++;
                    continue;
                }

                chapter.pages = pages;
                chapter.status = 'ready';
                chapter.ocr = { engine: `tesseract:${lang}`, at: new Date().toISOString() };
                chapter.textChars = pages.reduce((n, p) => n + p.text.length, 0);
                await store.put(book);

                const pieces = chunkPages(pages);
                if (pieces.length) {
                    const vectors = await embedAll(pieces.map((p) => p.text));
                    await corpus.replaceChunks(item.id, pieces.map((p, i) => ({
                        chapterId: item.id,
                        bookId: item.book_id,
                        grade: item.grade,
                        subject: item.subject,
                        medium: item.medium,
                        page: p.page,
                        text: p.text,
                        embedding: vectors[i]
                    })));
                }
                await corpus.pool.query(
                    "UPDATE ncert_chapters SET status = 'ready', text_chars = $2 WHERE id = $1",
                    [item.id, chapter.textChars]);

                fixed++; done++;
            } catch (e) {
                failed++; done++;
                if (failed <= 10) console.warn(`  ! ${String(item.name).slice(0, 40)}: ${e.message}`);
            }

            if (done % 25 === 0) {
                const mins = (Date.now() - t0) / 60000;
                console.log(`  ${done}/${queue.length} · fixed ${fixed} · still bad ${stillBad} · failed ${failed} · ${pagesOcr} pages · ${(pagesOcr / Math.max(mins, 0.01)).toFixed(0)} pg/min`);
            }
        }
        if (worker) await worker.terminate();
    }

    await Promise.all(Array.from({ length: WORKERS }, () => runWorker()));

    console.log(`\ndone in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    console.log(`  recovered ${fixed} chapters (${pagesOcr} pages OCR'd)`);
    console.log(`  still unreadable ${stillBad} · failed ${failed}`);
    if (fixed) {
        // Which book is current changes once a demoted book becomes readable.
        const n = await corpus.computeEditionRanks();
        console.log(`  re-ranked editions — ${n} current-edition books`);
    }
    await corpus.pool.end();
    process.exit(0);
})().catch((e) => { console.error('[OCR ERROR]', e.message); process.exit(1); });
