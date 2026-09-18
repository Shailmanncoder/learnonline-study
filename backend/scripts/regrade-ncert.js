#!/usr/bin/env node
// Re-grade already-imported chapters against the current gradeChapter()
// rule. The page text is already stored, so nothing is re-downloaded.
//
//   node scripts/regrade-ncert.js --dry-run
//   node scripts/regrade-ncert.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const db = require('../config/db');
const { createStore } = require('../services/ncertStore');
const { gradeChapter } = require('../services/ncertSource');

const DRY = process.argv.includes('--dry-run');

(async () => {
    const store = createStore(db);
    const rows = await db.all('SELECT id FROM ncert_books ORDER BY id');
    const moved = { toReady: 0, toReview: 0, toUnavailable: 0, unchanged: 0 };
    let booksTouched = 0;

    for (const { id } of rows) {
        const book = await store.get(id);
        if (!book || !Array.isArray(book.chapters)) continue;

        let changed = false;
        for (const ch of book.chapters) {
            const { status, readablePages, chars } = gradeChapter(ch.pages);
            if (status === ch.status && ch.textChars === chars) { moved.unchanged++; continue; }
            if (status !== ch.status) {
                if (status === 'ready') moved.toReady++;
                else if (status === 'needs_review') moved.toReview++;
                else moved.toUnavailable++;
            }
            ch.status = status;
            ch.readablePages = readablePages;
            ch.textChars = chars;
            changed = true;
        }

        if (changed) {
            booksTouched++;
            if (!DRY) await store.put(book);
        }
    }

    console.log(DRY ? '[dry run] would change:' : 'applied:');
    console.log('  -> ready       ', moved.toReady);
    console.log('  -> needs_review', moved.toReview);
    console.log('  -> unavailable ', moved.toUnavailable);
    console.log('  unchanged      ', moved.unchanged);
    console.log('  books rewritten', booksTouched);
    process.exit(0);
})().catch(e => { console.error('[REGRADE ERROR]', e.message); process.exit(1); });
