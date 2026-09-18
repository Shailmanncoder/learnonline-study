#!/usr/bin/env node
// Truth about what is actually importable, computed from the stored books
// rather than the sync counters (which only describe the current run).
//
//   node scripts/ncert-coverage.js
//   node scripts/ncert-coverage.js --medium English
//   node scripts/ncert-coverage.js --json
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const db = require('../config/db');

const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const wantMedium = arg('--medium');
const asJson = process.argv.includes('--json');

const classOrder = (g) => {
    const m = /Class\s+(\d+)/i.exec(g || '');
    return m ? Number(m[1]) : 99;
};

(async () => {
    const rows = await db.all('SELECT payload FROM ncert_books');
    const byClass = new Map();
    const mediums = new Map();
    let totals = { books: 0, ready: 0, review: 0, unavailable: 0, chars: 0 };

    for (const r of rows) {
        let book;
        try { book = JSON.parse(r.payload); } catch (e) { continue; }
        const medium = (book.mediums || [])[0] || 'Unknown';
        mediums.set(medium, (mediums.get(medium) || 0) + 1);
        if (wantMedium && medium.toLowerCase() !== wantMedium.toLowerCase()) continue;

        const grade = (book.grades || [])[0] || 'Ungraded';
        if (!byClass.has(grade)) {
            byClass.set(grade, { books: 0, ready: 0, review: 0, unavailable: 0, chars: 0, subjects: new Set() });
        }
        const bucket = byClass.get(grade);
        bucket.books++;
        totals.books++;
        (book.subjects || []).forEach(s => bucket.subjects.add(s));

        for (const ch of book.chapters || []) {
            const chars = ch.textChars || (ch.pages || []).reduce((n, p) => n + (p.text || '').length, 0);
            bucket.chars += chars;
            totals.chars += chars;
            if (ch.status === 'ready') { bucket.ready++; totals.ready++; }
            else if (ch.status === 'needs_review') { bucket.review++; totals.review++; }
            else { bucket.unavailable++; totals.unavailable++; }
        }
    }

    const ordered = [...byClass.entries()].sort((a, b) => classOrder(a[0]) - classOrder(b[0]));

    if (asJson) {
        console.log(JSON.stringify({
            totals,
            mediums: Object.fromEntries(mediums),
            classes: Object.fromEntries(ordered.map(([k, v]) => [k, { ...v, subjects: [...v.subjects] }]))
        }, null, 2));
        process.exit(0);
    }

    console.log(`NCERT coverage${wantMedium ? ` — ${wantMedium}` : ''}\n`);
    console.log('  class            books   ready  review     ocr      text   subjects');
    for (const [grade, v] of ordered) {
        console.log(
            '  ' + grade.padEnd(15) +
            String(v.books).padStart(5) + String(v.ready).padStart(8) +
            String(v.review).padStart(8) + String(v.unavailable).padStart(8) +
            (Math.round(v.chars / 1000) + 'K').padStart(10) + '   ' +
            [...v.subjects].slice(0, 3).join(', ').slice(0, 40)
        );
    }
    console.log('  ' + '-'.repeat(74));
    console.log('  ' + 'TOTAL'.padEnd(15) + String(totals.books).padStart(5) +
        String(totals.ready).padStart(8) + String(totals.review).padStart(8) +
        String(totals.unavailable).padStart(8) + (Math.round(totals.chars / 1000) + 'K').padStart(10));
    console.log('\n  books per medium:', [...mediums.entries()].sort((a, b) => b[1] - a[1])
        .slice(0, 8).map(([m, n]) => `${m} ${n}`).join('  ·  '));
    process.exit(0);
})().catch(e => { console.error('[COVERAGE ERROR]', e.message); process.exit(1); });
