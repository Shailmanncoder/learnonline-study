// Single-row publication keeps readers from seeing half-imported book chapters.
// MEDIUMTEXT works in MySQL and SQLite; application writes JSON explicitly.
function createStore(db) {
    let ready;
    function init() {
        return ready ||= (async () => {
            await db.run(`CREATE TABLE IF NOT EXISTS ncert_books (
                id VARCHAR(120) PRIMARY KEY, summary MEDIUMTEXT NOT NULL,
                payload MEDIUMTEXT NOT NULL, synced_at VARCHAR(40) NOT NULL
            )`);
            // Flat chapter index so a question can find its chapter without
            // loading every book payload — the payloads total ~20M chars.
            await db.run(`CREATE TABLE IF NOT EXISTS ncert_chapters (
                chapter_id VARCHAR(160) PRIMARY KEY,
                book_id VARCHAR(120) NOT NULL,
                book_name VARCHAR(400),
                chapter_name VARCHAR(400),
                grade VARCHAR(60),
                subject VARCHAR(120),
                medium VARCHAR(60),
                status VARCHAR(24),
                text_chars INTEGER DEFAULT 0,
                position INTEGER DEFAULT 0
            )`);
            await db.run('CREATE INDEX IF NOT EXISTS idx_ncert_ch_lookup ON ncert_chapters(grade, subject, medium, status)')
                .catch(() => {});
            await db.run('CREATE INDEX IF NOT EXISTS idx_ncert_ch_book ON ncert_chapters(book_id)').catch(() => {});
        })().catch(e => { ready = null; throw e; });
    }

    // Keeps the flat index in step with whatever was just written.
    async function reindex(book) {
        await db.run('DELETE FROM ncert_chapters WHERE book_id = ?', [book.id]);
        const grade = (book.grades || [])[0] || null;
        const subject = (book.subjects || [])[0] || null;
        const medium = (book.mediums || [])[0] || null;
        let position = 0;
        for (const ch of book.chapters || []) {
            const chars = ch.textChars != null
                ? ch.textChars
                : (ch.pages || []).reduce((n, p) => n + (p.text || '').length, 0);
            await db.run(
                `INSERT INTO ncert_chapters
                 (chapter_id, book_id, book_name, chapter_name, grade, subject, medium, status, text_chars, position)
                 VALUES (?,?,?,?,?,?,?,?,?,?)`,
                [ch.id, book.id, book.name || null, ch.name || ch.title || null,
                 grade, subject, medium, ch.status || 'pending', chars, position++]
            ).catch(() => {}); // a duplicate chapter id must not fail the book write
        }
    }
    return {
        async all() {
            await init();
            return (await db.all('SELECT summary FROM ncert_books ORDER BY id')).map(r => JSON.parse(r.summary));
        },
        async get(id) {
            await init();
            const row = await db.get('SELECT payload FROM ncert_books WHERE id = ?', [id]);
            return row ? JSON.parse(row.payload) : null;
        },
        async put(book) {
            await init();
            const { chapters, ...summary } = book;
            summary.chapters = chapters.map(({ pages, ...c }) => ({ ...c, pageCount: pages.length }));
            const values = [book.id, JSON.stringify(summary), JSON.stringify(book), new Date().toISOString()];
            if (Buffer.byteLength(values[2]) > 12 * 1024 * 1024) throw new Error('Book text exceeds storage limit');
            const update = db.dialect() === 'mysql'
                ? 'ON DUPLICATE KEY UPDATE summary=VALUES(summary),payload=VALUES(payload),synced_at=VALUES(synced_at)'
                : 'ON CONFLICT(id) DO UPDATE SET summary=excluded.summary,payload=excluded.payload,synced_at=excluded.synced_at';
            await db.run(`INSERT INTO ncert_books (id,summary,payload,synced_at) VALUES (?,?,?,?) ${update}`, values);
            await reindex(book);
        },
        async reindexAll() {
            await init();
            const rows = await db.all('SELECT payload FROM ncert_books');
            let n = 0;
            for (const r of rows) {
                try { await reindex(JSON.parse(r.payload)); n++; } catch (e) { /* skip unreadable row */ }
            }
            return n;
        },
        // Candidate chapters for a class/subject, cheapest query first.
        async findChapters({ grade, subject, medium, status = 'ready', limit = 400 }) {
            await init();
            const where = ['status = ?'];
            const params = [status];
            if (grade) { where.push('grade = ?'); params.push(grade); }
            if (subject) { where.push('LOWER(subject) = LOWER(?)'); params.push(subject); }
            if (medium) { where.push('LOWER(medium) = LOWER(?)'); params.push(medium); }
            params.push(limit);
            return db.all(
                `SELECT chapter_id, book_id, book_name, chapter_name, grade, subject, medium, text_chars
                 FROM ncert_chapters WHERE ${where.join(' AND ')}
                 ORDER BY position ASC LIMIT ?`, params);
        }
    };
}
module.exports = { createStore };
