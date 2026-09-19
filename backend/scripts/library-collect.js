#!/usr/bin/env node
// ================================================================
// Verified Source Library — collector CLI
//
//   node scripts/library-collect.js --discover --class 7 --subject Mathematics
//   node scripts/library-collect.js --class 7 --subject Mathematics --unit 1
//   node scripts/library-collect.js --class 9 --subject science --all-units
//   node scripts/library-collect.js --reprocess 3
//   node scripts/library-collect.js --reprocess-all --class 7 --subject Mathematics
//
// Fetches only from the allowlisted hosts of a registered trusted source,
// honours robots.txt and a per-host rate limit, and writes provenance only
// from the official page and the document itself.
// ================================================================
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const collector = require('../services/sourceLibrary/collector');
const db = require('../config/db');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);

(async () => {
    await collector.seedTrustedSources();
    const sourceKey = arg('--source', 'ncert-exemplar');
    const classLevel = Number(arg('--class', 7));
    const subject = arg('--subject', 'Mathematics');

    if (has('--discover')) {
        const r = await collector.discover(sourceKey, { classLevel, subject });
        console.log(`Official page: ${r.pageUrl}`);
        r.candidates.forEach(c => console.log(`  [${c.documentKind}] ${c.label}  ${c.url}`));
        if (r.rejected.length) console.log(`Rejected ${r.rejected.length}:`), r.rejected.forEach(x => console.log(`  ${x.url} — ${x.reason}`));
        process.exit(0);
    }

    const log = async (m) => console.log(m);
    if (arg('--reprocess')) {
        await collector.processDocument(Number(arg('--reprocess')), log);
        process.exit(0);
    }
    // Re-run extraction for every stored document of a class and subject,
    // from the saved PDFs (no re-download). Use after a parser change.
    if (has('--reprocess-all')) {
        const docs = await db.all(
            "SELECT id, unit_number, chapter FROM source_documents WHERE class_level = ? AND (LOWER(subject) = LOWER(?) OR subject = ?) AND status NOT IN ('duplicate', 'excluded') ORDER BY unit_number",
            [String(classLevel), subject, collector.canonicalSubject(subject)]);
        for (const d of docs) {
            console.log(`\n=== Unit ${d.unit_number} ${d.chapter} (document ${d.id})`);
            try { await collector.processDocument(d.id, async (m) => console.log('  ' + m)); }
            catch (e) { console.log('  FAILED: ' + e.message); }
        }
        process.exit(0);
    }

    const source = await collector.getSource(sourceKey);
    const units = String(arg('--unit', '')).split(',').filter(Boolean).map(Number);
    if (!units.length && !has('--all-units')) {
        console.error('Choose units with --unit 1,2,3 or pass --all-units (start small: --unit 1).');
        process.exit(2);
    }
    const found = await collector.discover(sourceKey, { classLevel, subject });
    const chosen = found.candidates.filter(c => c.documentKind === 'unit' && (has('--all-units') || units.includes(c.unitNumber)));
    if (!chosen.length) { console.error('No such unit on the official page.'); process.exit(1); }
    for (const c of chosen) {
        console.log(`\n${c.label} — ${c.url}`);
        const existing = await db.get('SELECT id FROM source_documents WHERE document_url = ?', [c.url]);
        let id = existing && existing.id;
        if (!id) {
            const r = await db.run(
                `INSERT INTO source_documents (trusted_source_id, publisher, source_type, book_title, class_level, subject,
                    unit_number, chapter, discovered_label, official_url, document_url, status, usage_mode, license_status,
                    redistribution_allowed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?, ?)`,
                [source.id, source.publisher, source.source_type, `${source.title}: ${c.subject}`, String(c.classLevel), c.subject,
                 c.unitNumber, c.chapter, c.label, found.pageUrl, c.url, source.usage_mode, source.license_status, source.redistribution_allowed]);
            id = r.lastID;
        }
        // One unreadable chapter must not stop the rest of the book.
        try { await collector.processDocument(id, log, { fetch: true }); }
        catch (e) { console.log('  FAILED: ' + e.message); }
    }
    const stats = await db.all('SELECT verification_status AS s, COUNT(*) AS n FROM questions GROUP BY verification_status');
    console.log('\nLibrary totals:', stats.map(x => `${x.s}=${x.n}`).join(', '));
    process.exit(0);
})().catch((e) => { console.error('Collector failed:', e.message); process.exit(1); });
