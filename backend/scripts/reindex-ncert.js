#!/usr/bin/env node
// Rebuild the flat chapter index from stored books. Safe to re-run; the
// importer keeps it current on its own via store.put().
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const db = require('../config/db');
const { createStore } = require('../services/ncertStore');

(async () => {
    const n = await createStore(db).reindexAll();
    const [{ c: total }] = await db.all('SELECT COUNT(*) AS c FROM ncert_chapters');
    const [{ c: ready }] = await db.all("SELECT COUNT(*) AS c FROM ncert_chapters WHERE status='ready'");
    console.log(`indexed ${n} books — ${total} chapters (${ready} ready)`);
    process.exit(0);
})().catch(e => { console.error('[REINDEX ERROR]', e.message); process.exit(1); });
