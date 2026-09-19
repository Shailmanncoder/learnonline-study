#!/usr/bin/env node
// Copy the Verified Source Library into a running app's SQLite database.
//   node scripts/library-import.js <library.db> [target.db]
//
// <library.db> holds source_documents, document_pages, questions,
// answer_sources and verification_logs exported from another copy of the app.
// Only those tables are written: users, chats and everything else in the
// target are left alone. Safety:
//   * a consistent online backup of the target is taken first (VACUUM INTO);
//   * it refuses to run if any of those tables already has rows, so ids from
//     the source (which questions reference) can never collide;
//   * the trusted source the documents belong to must already exist in the
//     target under the same id and key — the app seeds it on start;
//   * everything is inserted in one transaction, and the counts are checked
//     against the source before it commits.
const path = require('node:path');
const sqlite3 = require(path.join(__dirname, '..', 'node_modules', 'sqlite3'));

const SOURCE = process.argv[2];
const TARGET = process.argv[3] || path.join(__dirname, '..', 'database', 'studyhub.db');
const TABLES = ['source_documents', 'document_pages', 'questions', 'answer_sources', 'verification_logs'];

if (!SOURCE) {
    console.error('Usage: node scripts/library-import.js <library.db> [target.db]');
    process.exit(2);
}

const db = new sqlite3.Database(TARGET);
const q = (method, sql, params = []) => new Promise((resolve, reject) =>
    db[method](sql, params, function (err, rows) { err ? reject(err) : resolve(method === 'run' ? this : rows); }));

(async () => {
    await q('run', 'PRAGMA busy_timeout = 15000');

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(path.dirname(TARGET), `studyhub.backup-${stamp}.db`);
    await q('run', 'VACUUM INTO ?', [backup]);
    console.log(`Backup written: ${backup}`);

    await q('run', 'ATTACH DATABASE ? AS lib', [SOURCE]);

    for (const t of TABLES) {
        const [{ n }] = await q('all', `SELECT COUNT(*) AS n FROM main.${t}`);
        if (n > 0) throw new Error(`main.${t} already has ${n} rows — refusing to import over existing library data`);
    }
    const sourceIds = (await q('all', 'SELECT DISTINCT trusted_source_id AS id FROM lib.source_documents')).map(r => r.id);
    for (const id of sourceIds) {
        const row = (await q('all', 'SELECT id, source_key FROM main.trusted_sources WHERE id = ?', [id]))[0];
        if (!row) throw new Error(`trusted source ${id} is missing in the target — start the app once so it seeds its sources`);
        console.log(`Trusted source ${id} present in target: ${row.source_key}`);
    }

    await q('run', 'BEGIN IMMEDIATE');
    try {
        for (const t of TABLES) {
            const cols = (rows) => rows.map(r => r.name);
            const mainCols = cols(await q('all', `PRAGMA main.table_info(${t})`));
            const libCols = new Set(cols(await q('all', `PRAGMA lib.table_info(${t})`)));
            const shared = mainCols.filter(c => libCols.has(c));
            const missing = [...libCols].filter(c => !mainCols.includes(c));
            if (missing.length) throw new Error(`target ${t} lacks columns ${missing.join(', ')} — deploy the matching code first`);
            const list = shared.map(c => `"${c}"`).join(', ');
            const res = await q('run', `INSERT INTO main.${t} (${list}) SELECT ${list} FROM lib.${t}`);
            const [{ n: want }] = await q('all', `SELECT COUNT(*) AS n FROM lib.${t}`);
            if (res.changes !== want) throw new Error(`${t}: inserted ${res.changes}, expected ${want}`);
            console.log(`${t}: ${res.changes} rows`);
        }
        await q('run', 'COMMIT');
    } catch (err) {
        await q('run', 'ROLLBACK').catch(() => {});
        throw err;
    }

    const [summary] = await q('all', `SELECT COUNT(*) AS total,
        SUM(verification_status = 'AUTO_VERIFIED') AS auto FROM main.questions`);
    console.log(`Done. Library now holds ${summary.total} questions, ${summary.auto} auto-verified.`);
    db.close();
})().catch((err) => {
    console.error('IMPORT FAILED — nothing was changed:', err.message);
    db.close();
    process.exit(1);
});
