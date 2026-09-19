#!/usr/bin/env node
// Flag chapters whose extracted text is structurally invalid, so retrieval
// stops serving them. See scanIndic() in services/ncertSource.js.
//
//   node scripts/mark-garbled.js [--dry-run]
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { createPgCorpus } = require('../services/ncertPg');
const { scanIndic, looksLegacyEncoded } = require('../services/ncertSource');

const DRY = process.argv.includes('--dry-run');

(async () => {
    const corpus = createPgCorpus();
    // No script filter: legacy-font chapters contain NO Devanagari at all —
    // their bytes are Latin — so filtering on script would skip exactly the
    // ones that most need catching.
    const { rows } = await corpus.pool.query(
        `SELECT c.chapter_id, c.medium, string_agg(c.text, ' ') AS t
         FROM ncert_chunks c JOIN ncert_chapters ch ON ch.id = c.chapter_id
         WHERE ch.status <> 'garbled'
         GROUP BY c.chapter_id, c.medium`);

    const bad = [];
    const byMedium = {};
    for (const r of rows) {
        const s = scanIndic(r.t);
        if (!s.garbled && !looksLegacyEncoded(r.t, r.medium)) continue;
        bad.push(r.chapter_id);
        const m = r.medium || '(none)';
        byMedium[m] = (byMedium[m] || 0) + 1;
    }

    console.log(`${rows.length} chapters examined`);
    console.log(`${bad.length} unusable (broken font map or legacy 8-bit encoding)\n`);
    Object.entries(byMedium).sort((a, b) => b[1] - a[1])
        .forEach(([m, n]) => console.log(`  ${m.padEnd(14)}${n}`));

    if (DRY) { console.log('\n(dry run — nothing changed)'); await corpus.pool.end(); return; }

    for (let i = 0; i < bad.length; i += 500) {
        await corpus.pool.query(
            "UPDATE ncert_chapters SET status = 'garbled' WHERE id = ANY($1)",
            [bad.slice(i, i + 500)]);
    }
    console.log(`\nmarked ${bad.length} chapters as garbled — excluded from retrieval`);
    await corpus.pool.end();
})().catch(e => { console.error('[MARK ERROR]', e.message); process.exit(1); });
