#!/usr/bin/env node
// Move the NCERT corpus from the SQLite blob store into Postgres/pgvector,
// chunking and embedding as it goes. Re-runnable: chapters that already
// have chunks are skipped, so it can be run again to pick up books the
// importer added since the last pass.
//
//   node scripts/migrate-ncert-pg.js [--limit 50] [--force]
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const sqlite = require('../config/db');
const { createPgCorpus } = require('../services/ncertPg');
const { embedAll } = require('../services/embedder');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? Number(process.argv[i + 1]) : d; };
const LIMIT = arg('--limit', Infinity);
const FORCE = process.argv.includes('--force');

const CHUNK = 1400;
const STEP = 1100;

// Same windowing the keyword tutor used, so retrieval quality is comparable
// and only the scoring changes.
function chunkChapter(chapter) {
    const out = [];
    for (const page of chapter.pages || []) {
        // PDF extraction leaves NUL bytes in some pages; Postgres TEXT
        // cannot store 0x00 and the whole insert fails on one of them.
        const text = (page.text || '').replace(/\u0000/g, '').trim();
        if (text.length < 40) continue;
        for (let start = 0; start < text.length; start += STEP) {
            const slice = text.slice(start, start + CHUNK).trim();
            if (slice.length >= 60) out.push({ page: page.page, text: slice });
        }
    }
    return out;
}

(async () => {
    const corpus = createPgCorpus();
    await corpus.init();

    const done = new Set();
    if (!FORCE) {
        const { rows } = await corpus.pool.query('SELECT DISTINCT chapter_id FROM ncert_chunks');
        rows.forEach(r => done.add(r.chapter_id));
        if (done.size) console.log(`${done.size} chapters already embedded — skipping those`);
    }

    // Ids first, payloads one at a time: the payloads total several hundred
    // MB and must not all be resident at once.
    const ids = (await sqlite.all('SELECT id FROM ncert_books ORDER BY id')).map(r => r.id);
    console.log(`${ids.length} books in SQLite\n`);

    let nBooks = 0, nChapters = 0, nChunks = 0, skipped = 0;
    const failed = [];
    const t0 = Date.now();

    for (const id of ids) {
        if (nBooks >= LIMIT) break;
        let book;
        try {
            const row = await sqlite.get('SELECT payload FROM ncert_books WHERE id = ?', [id]);
            book = JSON.parse(row.payload);
        } catch (e) { continue; }

        const { grade, subject, medium } = await corpus.upsertBook(book);
        nBooks++;

        let position = 0;
        for (const ch of book.chapters || []) {
            await corpus.upsertChapter(ch, book.id, position++);
            if (done.has(ch.id)) { skipped++; continue; }
            // Nothing to retrieve from an image-only chapter.
            if (ch.status === 'unavailable') continue;

            const pieces = chunkChapter(ch);
            if (!pieces.length) continue;

            try {
                const vectors = await embedAll(pieces.map(p => p.text));
                await corpus.replaceChunks(ch.id, pieces.map((p, i) => ({
                    chapterId: ch.id, bookId: book.id, grade, subject, medium,
                    page: p.page, text: p.text, embedding: vectors[i]
                })));
                nChapters++;
                nChunks += pieces.length;
            } catch (e) {
                // A chapter that will not store is worth reporting, but it
                // must not cost us the other 900 books.
                failed.push({ chapter: ch.id, error: e.message });
            }
        }

        if (nBooks % 25 === 0) {
            const mins = (Date.now() - t0) / 60000;
            console.log(`  ${nBooks}/${ids.length} books · ${nChapters} chapters · ${nChunks} chunks · ${(nChunks / Math.max(mins, 0.01)).toFixed(0)}/min`);
        }
    }

    console.log('\nbuilding HNSW vector index…');
    await corpus.buildVectorIndex();
    // Which book is current changes as new editions import, so rank after
    // every pass rather than once at setup.
    const current = await corpus.computeEditionRanks();
    console.log(`ranked editions — ${current} current-edition books`);

    const s = await corpus.stats();
    console.log(`\ndone in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    console.log(`  books ${s.books} · chapters ${s.chapters} · chunks ${s.chunks} (${s.embedded} embedded)`);
    if (skipped) console.log(`  skipped ${skipped} already-embedded chapters`);
    if (failed.length) {
        console.log(`  ${failed.length} chapters failed to store:`);
        failed.slice(0, 10).forEach(f => console.log(`    ${f.chapter}: ${f.error}`));
    }
    await corpus.pool.end();
    process.exit(0);
})().catch(e => { console.error('[MIGRATE ERROR]', e.message); process.exit(1); });
