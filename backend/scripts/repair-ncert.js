#!/usr/bin/env node
// Re-fetch chapters that produced no pages. These are almost always large
// PDFs that hit the old 120s total timeout, not scans — a 57MB Urdu Class 7
// chapter that stored as 0 pages extracts to 20 readable pages once it is
// allowed to finish downloading.
//
//   node scripts/repair-ncert.js --dry-run
//   node scripts/repair-ncert.js [--limit 50]
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../config/db');
const { createStore } = require('../services/ncertStore');
const { extractChapter } = require('../services/ncertSource');

const DRY = process.argv.includes('--dry-run');
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;

const broken = (ch) => !(ch.pages || []).length && ch.url;

(async () => {
    const store = createStore(db);
    const rows = await db.all('SELECT id FROM ncert_books ORDER BY id');

    const targets = [];
    for (const { id } of rows) {
        const book = await store.get(id);
        for (const ch of book?.chapters || []) if (broken(ch)) targets.push({ bookId: id, chapterId: ch.id });
    }
    console.log(`${targets.length} chapters stored with zero pages`);
    if (DRY || !targets.length) { process.exit(0); }

    const byBook = new Map();
    for (const t of targets.slice(0, LIMIT)) {
        if (!byBook.has(t.bookId)) byBook.set(t.bookId, []);
        byBook.get(t.bookId).push(t.chapterId);
    }

    let recovered = 0, stillFailing = 0;
    for (const [bookId, chapterIds] of byBook) {
        const book = await store.get(bookId);
        if (!book) continue;
        let changed = false;

        for (const chapterId of chapterIds) {
            const idx = book.chapters.findIndex(c => c.id === chapterId);
            if (idx === -1) continue;
            const ch = book.chapters[idx];
            try {
                const fresh = await extractChapter(ch);
                book.chapters[idx] = fresh;
                changed = true;
                if ((fresh.pages || []).length) {
                    recovered++;
                    console.log(`  ok   ${fresh.status.padEnd(12)} ${fresh.pages.length}p ${String(fresh.textChars).padStart(7)}ch  ${(ch.name || '').slice(0, 46)}`);
                } else {
                    stillFailing++;
                }
            } catch (e) {
                stillFailing++;
                console.log(`  fail ${(e.message || '').slice(0, 46).padEnd(46)}  ${(ch.name || '').slice(0, 40)}`);
            }
        }
        if (changed) await store.put(book);
    }

    console.log(`\nrecovered ${recovered}, still failing ${stillFailing}`);
    process.exit(0);
})().catch(e => { console.error('[REPAIR ERROR]', e.message); process.exit(1); });
