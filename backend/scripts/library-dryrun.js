#!/usr/bin/env node
// Parse stored library PDFs with the current parser WITHOUT writing anything,
// to compare extraction quality across units before reprocessing for real.
//   node scripts/library-dryrun.js [documentId ...]
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('node:fs');
const db = require('../config/db');
const { STORE } = require('../services/sourceLibrary/collector');
const { extractPages } = require('../services/sourceLibrary/pdfLayout');
const { parseQuestions, numberTrusted } = require('../services/sourceLibrary/questionParser');

(async () => {
    const ids = process.argv.slice(2).map(Number).filter(Boolean);
    const docs = await db.all(`SELECT id, class_level, subject, unit_number, chapter FROM source_documents
        ${ids.length ? `WHERE id IN (${ids.join(',')})` : ''} ORDER BY class_level, subject, unit_number`);
    for (const d of docs) {
        const file = path.join(STORE, `${d.id}.pdf`);
        if (!fs.existsSync(file)) continue;
        const pages = await extractPages(fs.readFileSync(file));
        const r = parseQuestions(pages);
        const ex = r.questions.filter(q => q.kind === 'exercise');
        const trusted = r.questions.filter(q => numberTrusted(q, r.integrity)).length;
        const sections = [...new Set(ex.map(q => q.section || '(none)'))];
        console.log(`doc ${String(d.id).padStart(2)} C${d.class_level} ${String(d.subject).padEnd(11)} U${String(d.unit_number).padEnd(2)} ` +
            `${String(d.chapter).slice(0, 22).padEnd(22)} scheme=${r.scheme.padEnd(11)} exercise=${String(ex.length).padEnd(3)} ` +
            `examples=${String(r.questions.length - ex.length).padEnd(3)} trusted=${trusted}/${r.questions.length}` +
            (r.integrity.ok ? '' : `  ⚠ ${r.integrity.problems[0].slice(0, 80)}`));
        if (process.env.SHOW) {
            console.log(`     sections: ${sections.join(' | ')}`);
            for (const q of ex.slice(0, 3).concat(ex.slice(-1))) console.log(`     [${q.section || '-'} · ${q.questionNumber}] p${q.startPdfPage}: ${q.questionText.replace(/\n/g, ' / ').slice(0, 110)}`);
        }
    }
    process.exit(0);
})();
