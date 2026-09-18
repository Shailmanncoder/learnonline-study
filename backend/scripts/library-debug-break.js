#!/usr/bin/env node
// Diagnostic: show the lines around where a document's question numbering
// breaks, to see why the deterministic parser lost the sequence.
//   node scripts/library-debug-break.js <documentId>
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const db = require('../config/db');
(async () => {
    const id = Number(process.argv[2]);
    const qs = await db.all("SELECT kind, CAST(question_number AS INTEGER) n, start_pdf_page p, end_pdf_page e FROM questions WHERE document_id = ? ORDER BY kind, n", [id]);
    const ex = qs.filter(q => q.kind === 'exercise');
    const eg = qs.filter(q => q.kind === 'example');
    const last = ex[ex.length - 1];
    console.log(`exercise 1..${last ? last.n : 0}, last on p${last ? last.e : '-'}; examples: ${eg.map(e => e.n).join(',')}`);
    const pages = await db.all('SELECT pdf_page_index i, lines_json FROM document_pages WHERE document_id = ? ORDER BY pdf_page_index', [id]);
    const from = last ? last.e : 1;
    for (const pg of pages.filter(p => p.i >= from && p.i <= from + 1)) {
        console.log(`--- PDF page ${pg.i}`);
        for (const l of JSON.parse(pg.lines_json)) {
            if (/^\(?\d{1,3}\s*[.)]|^In\b|^Example|question|^Q/i.test(l.text)) console.log(`  [x${Math.round(l.x)} y${Math.round(l.y)}] ${l.text.slice(0, 90)}`);
        }
    }
    process.exit(0);
})();
