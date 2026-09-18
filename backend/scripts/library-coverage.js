#!/usr/bin/env node
// Coverage of the Verified Source Library, straight from the database:
// documents, questions and verification status per class and subject.
//   node scripts/library-coverage.js [--json]
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
const db = require('../config/db');

(async () => {
    await db.ready();
    const docs = await db.all(`
        SELECT d.class_level c, d.subject s, COUNT(*) docs,
               SUM(d.status = 'processed') processed,
               SUM(d.status = 'failed') failed
        FROM source_documents d WHERE d.trusted_source_id IS NOT NULL
        GROUP BY d.class_level, d.subject`);
    const qs = await db.all(`
        SELECT d.class_level c, d.subject s, COUNT(q.id) total,
               SUM(q.verification_status = 'AUTO_VERIFIED') auto,
               SUM(q.verification_status = 'HUMAN_VERIFIED') human,
               SUM(q.verification_status = 'UNVERIFIED') review,
               SUM(q.verification_status = 'REJECTED') rejected,
               SUM(q.printed_page IS NOT NULL) printed,
               SUM(q.kind = 'example') examples
        FROM questions q JOIN source_documents d ON d.id = q.document_id
        GROUP BY d.class_level, d.subject`);
    const key = (r) => `${r.c}|${r.s}`;
    const byKey = new Map(qs.map(r => [key(r), r]));
    const rows = docs.map(d => ({ ...d, ...(byKey.get(key(d)) || {}) }))
        .sort((a, b) => Number(a.c) - Number(b.c) || String(a.s).localeCompare(String(b.s)));
    if (process.argv.includes('--json')) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }
    const n = (v) => String(v || 0).padStart(6);
    console.log('Class  Subject              Docs  Done  Fail | Questions   Auto  Human Review Rejct | Printed pg');
    const sum = {};
    for (const r of rows) {
        console.log(`${String(r.c).padEnd(6)} ${String(r.s).padEnd(20)} ${n(r.docs).slice(1)}${n(r.processed)}${n(r.failed)} | ${n(r.total).padStart(9)}${n(r.auto)} ${n(r.human)}${n(r.review)}${n(r.rejected)} | ${n(r.printed)}`);
        for (const k of ['docs', 'processed', 'failed', 'total', 'auto', 'human', 'review', 'rejected', 'printed']) sum[k] = (sum[k] || 0) + Number(r[k] || 0);
    }
    console.log(`${'TOTAL'.padEnd(27)} ${n(sum.docs).slice(1)}${n(sum.processed)}${n(sum.failed)} | ${n(sum.total).padStart(9)}${n(sum.auto)} ${n(sum.human)}${n(sum.review)}${n(sum.rejected)} | ${n(sum.printed)}`);
    process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
