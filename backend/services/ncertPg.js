// ================================================================
// NCERT corpus on PostgreSQL + pgvector
// ----------------------------------------------------------------
// SQLite held the corpus as one JSON blob per book, which meant
// retrieval had to load a whole book to score it and could only match
// literal keywords. Here chapters are rows and chunks carry a 384-dim
// embedding, so "why do things fall" can reach GRAVITATION.
// ================================================================
const { Pool } = require('pg');

const DIMS = 384; // Xenova/all-MiniLM-L6-v2

function createPgCorpus(config = {}) {
    const pool = new Pool({
        connectionString: config.connectionString || process.env.NCERT_PG_URL,
        max: config.max || 8
    });

    async function init() {
        await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
        await pool.query(`CREATE TABLE IF NOT EXISTS ncert_books (
            id TEXT PRIMARY KEY,
            name TEXT, grade TEXT, subject TEXT, medium TEXT,
            publisher TEXT, license TEXT, revision TEXT, year TEXT,
            source TEXT, synced_at TIMESTAMPTZ DEFAULT now(),
            edition_rank INT DEFAULT 9
        )`);
        // Older databases predate the column.
        await pool.query('ALTER TABLE ncert_books ADD COLUMN IF NOT EXISTS edition_rank INT DEFAULT 9');
        await pool.query(`CREATE TABLE IF NOT EXISTS ncert_chapters (
            id TEXT PRIMARY KEY,
            book_id TEXT REFERENCES ncert_books(id) ON DELETE CASCADE,
            name TEXT, url TEXT, sha256 TEXT, license TEXT,
            status TEXT, page_count INT, readable_pages INT,
            text_chars INT, position INT
        )`);
        // grade/subject/medium are denormalised onto chunks so a filtered
        // vector search stays a single index scan.
        await pool.query(`CREATE TABLE IF NOT EXISTS ncert_chunks (
            id BIGSERIAL PRIMARY KEY,
            chapter_id TEXT REFERENCES ncert_chapters(id) ON DELETE CASCADE,
            book_id TEXT,
            grade TEXT, subject TEXT, medium TEXT,
            page INT, ord INT,
            text TEXT NOT NULL,
            embedding vector(${DIMS})
        )`);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_ncert_ch_book ON ncert_chapters(book_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_ncert_chunk_ch ON ncert_chunks(chapter_id)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_ncert_chunk_filter ON ncert_chunks(grade, subject, medium)');
    }

    // Built after loading: HNSW on an empty table is wasted work, and
    // building once at the end is far faster than maintaining it per-insert.
    async function buildVectorIndex() {
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_ncert_chunk_vec
            ON ncert_chunks USING hnsw (embedding vector_cosine_ops)`);
        await pool.query('ANALYZE ncert_chunks');
    }

    // Rank editions within each shelf so the current textbook wins.
    //
    // Year alone is a bad proxy for "the textbook". DIKSHA mixes several
    // kinds of book into one shelf, and the observed failures were all
    // ranking artefacts rather than data gaps:
    //   - Class 9 Science ships the SUPERSEDED syllabus titled "(NEW) Ncert
    //     Science Textbook For Class IX" carrying no year at all.
    //   - Class 10 Science put "Science Lab Manual" (2022) at rank 0 ahead of
    //     "Science Textbook for Class X", and listed a "Comic Book" with zero
    //     readable chapters above it.
    //   - Two Class 10 books are titled "Demo - Not For Regular Use".
    //
    // So rank on kind first, then content, then recency:
    //   1. real textbooks before manuals/supplements, demos last
    //   2. a book with no readable chapter can never be the current edition
    //   3. dated editions before undated ones
    //   4. more readable chapters, then most recently synced
    async function computeEditionRanks() {
        await pool.query(`
            UPDATE ncert_books b SET edition_rank = r.rank FROM (
                SELECT bk.id, (ROW_NUMBER() OVER (
                    PARTITION BY bk.grade, bk.subject, bk.medium
                    ORDER BY
                        CASE
                            WHEN bk.name ~* '(demo|not for regular use|sample only|test content)' THEN 3
                            WHEN bk.name ~* '(lab manual|laboratory|practical|comic|exemplar|workbook|question bank|handbook)' THEN 2
                            ELSE 0
                        END ASC,
                        (COALESCE(rc.n, 0) > 0) DESC,
                        NULLIF(regexp_replace(COALESCE(bk.year,''), '\\D', '', 'g'), '')::int DESC NULLS LAST,
                        COALESCE(rc.n, 0) DESC,
                        bk.synced_at DESC
                ) - 1) AS rank
                FROM ncert_books bk
                LEFT JOIN (
                    SELECT book_id, COUNT(*)::int AS n FROM ncert_chapters
                    WHERE status = 'ready' GROUP BY book_id
                ) rc ON rc.book_id = bk.id
            ) r WHERE b.id = r.id`);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_ncert_books_edition ON ncert_books(edition_rank)');
        const { rows } = await pool.query('SELECT COUNT(*) n FROM ncert_books WHERE edition_rank = 0');
        return Number(rows[0].n);
    }

    async function upsertBook(book) {
        const g = (book.grades || [])[0] || null;
        const s = (book.subjects || [])[0] || null;
        const m = (book.mediums || [])[0] || null;
        await pool.query(
            `INSERT INTO ncert_books (id,name,grade,subject,medium,publisher,license,revision,year,source,synced_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
             ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, grade=EXCLUDED.grade,
               subject=EXCLUDED.subject, medium=EXCLUDED.medium, revision=EXCLUDED.revision,
               synced_at=now()`,
            [book.id, book.name || null, g, s, m, book.publisher || null,
             book.license || null, book.revision || null,
             book.year ? String(book.year) : null, book.source || null]
        );
        return { grade: g, subject: s, medium: m };
    }

    async function upsertChapter(chapter, bookId, position) {
        await pool.query(
            `INSERT INTO ncert_chapters (id,book_id,name,url,sha256,license,status,page_count,readable_pages,text_chars,position)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status,
               page_count=EXCLUDED.page_count, readable_pages=EXCLUDED.readable_pages,
               text_chars=EXCLUDED.text_chars, sha256=EXCLUDED.sha256`,
            [chapter.id, bookId, chapter.name || null, chapter.url || null,
             chapter.sha256 || null, chapter.license || null, chapter.status || 'pending',
             (chapter.pages || []).length, chapter.readablePages ?? null,
             chapter.textChars ?? null, position]
        );
    }

    async function replaceChunks(chapterId, rows) {
        await pool.query('DELETE FROM ncert_chunks WHERE chapter_id = $1', [chapterId]);
        if (!rows.length) return;
        // One multi-row insert per chapter — far cheaper than a round trip each.
        const values = [];
        const params = [];
        rows.forEach((r, i) => {
            const b = i * 8;
            values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`);
            params.push(r.chapterId, r.bookId, r.grade, r.subject, r.medium, r.page, r.text,
                `[${r.embedding.join(',')}]`);
        });
        await pool.query(
            `INSERT INTO ncert_chunks (chapter_id,book_id,grade,subject,medium,page,text,embedding)
             VALUES ${values.join(',')}`, params);
    }

    // Nearest chunks by cosine distance, optionally scoped to a class.
    async function search({ embedding, grade, subject, medium, limit = 8, currentOnly = false, bookId = null, chapterId = null }) {
        // 'garbled' chapters extracted to structurally invalid text (a broken
        // Devanagari font map). Serving them lets the model answer confidently
        // from nonsense and cite a real page for it.
        const where = ["c.embedding IS NOT NULL", "ch.status <> 'garbled'"];
        const params = [`[${embedding.join(',')}]`];
        const add = (sql, val) => { params.push(val); where.push(sql.replace('$?', `$${params.length}`)); };
        // A book or chapter id is already the whole scope. Adding the profile's
        // subject on top filtered a chosen book out entirely: a Class 9
        // student with Science in their profile who picked Kaveri (English)
        // matched zero rows and was silently answered from Science books.
        const scoped = Boolean(chapterId || bookId);
        if (grade && !scoped) add('c.grade = $?', grade);
        if (subject && !scoped) add('LOWER(c.subject) = LOWER($?)', subject);
        if (medium && !scoped) add('LOWER(c.medium) = LOWER($?)', medium);
        // Restrict to the current edition of each shelf. Callers widen on
        // their own when this finds nothing relevant.
        // A locked chapter is the narrowest and strongest scope: nothing
        // outside it may reach the answer.
        if (chapterId) { params.push(chapterId); where.push(`c.chapter_id = $${params.length}`); }
        else if (bookId) { params.push(bookId); where.push(`c.book_id = $${params.length}`); }
        else if (currentOnly) where.push('b.edition_rank = 0');
        params.push(limit);
        // An HNSW scan returns its nearest neighbours and only THEN applies
        // the WHERE clause, so a class filter can eliminate every row the
        // index offered and the query returns nothing — while the answer
        // sits in the table. Observed live: "why do things fall down" scoped
        // to Class 9 returned 0 rows because the global nearest chunks were
        // all Class 6; exact search found GRAVITATION at 0.467. Across a
        // 36-query sweep, 13 returned empty. Iterative scans (pgvector 0.8+)
        // make the index keep walking until enough rows survive the filter.
        //
        // These are session settings, so they must be applied to the client
        // actually running the query: a pool 'connect' handler does not block
        // the first checkout, so its SETs race the query they are meant to
        // configure. Sequential awaits on one checked-out client are the only
        // ordering the pool guarantees.
        const client = await pool.connect();
        let rows;
        try {
            await client.query("SET hnsw.iterative_scan = 'relaxed_order'").catch(() => {});
            await client.query('SET hnsw.ef_search = 100').catch(() => {});
            ({ rows } = await client.query(
            `SELECT c.text, c.page, c.chapter_id, c.book_id,
                    ch.name AS chapter_name, ch.url, ch.sha256, ch.license,
                    b.name AS book_name, b.revision,
                    1 - (c.embedding <=> $1) AS score
             FROM ncert_chunks c
             JOIN ncert_chapters ch ON ch.id = c.chapter_id
             JOIN ncert_books b ON b.id = c.book_id
             WHERE ${where.join(' AND ')}
             ORDER BY c.embedding <=> $1
             LIMIT $${params.length}`, params));
        } finally {
            client.release();
        }
        return rows;
    }

    // The current textbook and its chapter list for a shelf. A question like
    // "what are the first three chapters" is a catalog lookup, not a content
    // lookup — vector search cannot answer it, and without the real list the
    // model recites whichever edition it was trained on.
    async function currentShelf({ grade, subject, medium, limit = 120, bookId = null }) {
        const params = [grade];
        const where = ['b.grade = $1'];
        if (bookId) { params.push(bookId); where.push(`b.id = $${params.length}`); }
        else where.push('b.edition_rank = 0');
        // With a book id the subject/medium filters can only exclude it.
        if (subject && !bookId) { params.push(subject); where.push(`LOWER(b.subject) = LOWER($${params.length})`); }
        if (medium && !bookId) { params.push(medium); where.push(`LOWER(b.medium) = LOWER($${params.length})`); }
        params.push(limit);
        const { rows } = await pool.query(
            `SELECT b.name AS book_name, b.year, ch.name AS chapter_name, ch.position
             FROM ncert_books b JOIN ncert_chapters ch ON ch.book_id = b.id
             WHERE ${where.join(' AND ')} AND ch.status = 'ready'
             ORDER BY b.name, ch.position LIMIT $${params.length}`, params);
        return rows;
    }

    // Subject-level view: what current books exist for a class. Listing
    // every chapter of all 30 subjects would truncate mid-way and read as
    // though the class only has a few subjects.
    async function currentSubjects({ grade, medium }) {
        const params = [grade];
        const where = ['b.edition_rank = 0', 'b.grade = $1', "ch.status = 'ready'"];
        if (medium) { params.push(medium); where.push(`LOWER(b.medium) = LOWER($${params.length})`); }
        const { rows } = await pool.query(
            `SELECT b.subject, b.name AS book_name, b.year, COUNT(ch.id)::int AS chapters
             FROM ncert_books b JOIN ncert_chapters ch ON ch.book_id = b.id
             WHERE ${where.join(' AND ')}
             GROUP BY b.subject, b.name, b.year
             HAVING COUNT(ch.id) > 0
             ORDER BY b.subject`, params);
        return rows;
    }

    // Does this shelf exist but have unusable text? A subject whose chapters
    // all failed the integrity check must not be answered from memory as if
    // the book were simply absent.
    async function shelfHealth({ grade, subject, medium }) {
        const params = [grade];
        const where = ['b.edition_rank = 0', 'b.grade = $1'];
        if (subject) { params.push(subject); where.push(`LOWER(b.subject) = LOWER($${params.length})`); }
        if (medium) { params.push(medium); where.push(`LOWER(b.medium) = LOWER($${params.length})`); }
        const { rows } = await pool.query(
            `SELECT COUNT(*) FILTER (WHERE ch.status = 'ready')::int   AS ready,
                    COUNT(*) FILTER (WHERE ch.status = 'garbled')::int AS garbled,
                    MAX(b.name) AS book_name
             FROM ncert_books b JOIN ncert_chapters ch ON ch.book_id = b.id
             WHERE ${where.join(' AND ')}`, params);
        return rows[0] || { ready: 0, garbled: 0, book_name: null };
    }

    // Every chapter on a shelf, whatever its edition or status. A student
    // asking about a real chapter that happens to sit in a demoted or garbled
    // book must not be told it does not exist.
    async function allChapters({ grade, subject, medium, limit = 400 }) {
        const params = [grade];
        const where = ['b.grade = $1'];
        if (subject) { params.push(subject); where.push(`LOWER(b.subject) = LOWER($${params.length})`); }
        if (medium) { params.push(medium); where.push(`LOWER(b.medium) = LOWER($${params.length})`); }
        params.push(limit);
        const { rows } = await pool.query(
            `SELECT ch.id AS chapter_id, ch.name AS chapter_name, ch.status,
                    b.id AS book_id, b.name AS book_name, b.year, b.edition_rank
             FROM ncert_books b JOIN ncert_chapters ch ON ch.book_id = b.id
             WHERE ${where.join(' AND ')}
             ORDER BY b.edition_rank, ch.position LIMIT $${params.length}`, params);
        return rows;
    }

    // Books on a shelf, newest first, for matching a title the student names.
    async function booksOn({ grade, subject, medium, limit = 60 }) {
        const params = [grade];
        const where = ['b.grade = $1'];
        if (subject) { params.push(subject); where.push(`LOWER(b.subject) = LOWER($${params.length})`); }
        if (medium) { params.push(medium); where.push(`LOWER(b.medium) = LOWER($${params.length})`); }
        params.push(limit);
        const { rows } = await pool.query(
            `SELECT b.id, b.name, b.year, b.edition_rank, b.grade, b.subject, b.medium,
                    COUNT(*) FILTER (WHERE ch.status = 'ready')::int AS ready
             FROM ncert_books b LEFT JOIN ncert_chapters ch ON ch.book_id = b.id
             WHERE ${where.join(' AND ')}
             GROUP BY b.id, b.name, b.year, b.edition_rank, b.grade, b.subject, b.medium
             ORDER BY b.edition_rank LIMIT $${params.length}`, params);
        return rows;
    }

    // The whole chapter, in reading order. Vocabulary lists and exercise
    // questions are spread across a chapter rather than clustered, so
    // top-k nearest chunks cannot answer "give me the word meanings".
    // Chunks overlap by CHUNK-STEP characters; the tail of each successive
    // chunk is appended so the text is not duplicated.
    const CHUNK_OVERLAP = 300;

    // An EVEN sample of the chapter, not its first N characters. Taking the
    // front of a 22-page chapter cut off the exercises and word lists, which
    // sit at ~89% through — so "give me all the questions" could never work.
    // Sampling at a stride covers the whole arc within the same budget.
    async function chapterSpread(chapterId, maxChars = 11000) {
        const { rows } = await pool.query(
            `SELECT c.page, c.text, ch.name AS chapter_name, ch.url, ch.sha256,
                    ch.license, b.name AS book_name, b.revision
             FROM ncert_chunks c
             JOIN ncert_chapters ch ON ch.id = c.chapter_id
             JOIN ncert_books b ON b.id = c.book_id
             WHERE c.chapter_id = $1 ORDER BY c.page, c.id`, [chapterId]);
        if (!rows.length) return null;

        // De-overlap first, so the budget is spent on distinct text.
        const distinct = [];
        let prevPage = null;
        for (const r of rows) {
            let text = r.text || '';
            if (r.page === prevPage && text.length > CHUNK_OVERLAP) text = text.slice(CHUNK_OVERLAP);
            prevPage = r.page;
            distinct.push({ page: r.page, text });
        }

        const total = distinct.reduce((n, d) => n + d.text.length, 0);
        let picked = distinct;
        if (total > maxChars) {
            const stride = Math.ceil(total / maxChars);
            picked = distinct.filter((_, i) => i % stride === 0);
            // Always keep the last piece: exercises and answers live there.
            if (picked[picked.length - 1] !== distinct[distinct.length - 1]) {
                picked.push(distinct[distinct.length - 1]);
            }
        }

        const meta = rows[0];
        return {
            chapterId,
            chapterName: meta.chapter_name,
            bookName: meta.book_name,
            revision: meta.revision,
            url: meta.url,
            sha256: meta.sha256,
            license: meta.license,
            pages: picked,
            truncated: total > maxChars,
            coverage: total ? picked.reduce((n, d) => n + d.text.length, 0) / total : 1
        };
    }

    // Every distinct chunk of one chapter. A chapter is ~40 rows, so the
    // caller can score them itself — which beats a vector search here:
    // all-MiniLM-L6-v2 is an English model and its Devanagari similarities
    // sit in a narrow band (0.60 unrelated vs 0.82 related), so top-k
    // ranking over Hindi text is close to random.
    async function chapterChunks(chapterId) {
        const { rows } = await pool.query(
            `SELECT c.page, c.text, ch.name AS chapter_name, ch.url, ch.sha256,
                    ch.license, b.name AS book_name, b.revision
             FROM ncert_chunks c
             JOIN ncert_chapters ch ON ch.id = c.chapter_id
             JOIN ncert_books b ON b.id = c.book_id
             WHERE c.chapter_id = $1 ORDER BY c.page, c.id`, [chapterId]);
        if (!rows.length) return null;
        const pieces = [];
        let prevPage = null;
        for (const r of rows) {
            let text = r.text || '';
            if (r.page === prevPage && text.length > CHUNK_OVERLAP) text = text.slice(CHUNK_OVERLAP);
            prevPage = r.page;
            pieces.push({ page: r.page, text });
        }
        const m = rows[0];
        return {
            chapterId, chapterName: m.chapter_name, bookName: m.book_name,
            revision: m.revision, url: m.url, sha256: m.sha256, license: m.license,
            pieces
        };
    }

    // Resolve a book id to its identity, for validating a remembered selection.
    async function bookMeta(bookId) {
        const { rows } = await pool.query(
            `SELECT b.id, b.name, b.year, b.edition_rank, b.grade, b.subject, b.medium,
                    COUNT(*) FILTER (WHERE ch.status = 'ready')::int AS ready
             FROM ncert_books b LEFT JOIN ncert_chapters ch ON ch.book_id = b.id
             WHERE b.id = $1
             GROUP BY b.id, b.name, b.year, b.edition_rank, b.grade, b.subject, b.medium`, [bookId]);
        return rows[0] || null;
    }

    // Resolve a chapter id to its identity, for validating a stored lock.
    async function chapterMeta(chapterId) {
        const { rows } = await pool.query(
            `SELECT ch.id, ch.name AS chapter_name, ch.status, b.name AS book_name,
                    b.grade, b.subject, b.medium
             FROM ncert_chapters ch JOIN ncert_books b ON b.id = ch.book_id
             WHERE ch.id = $1`, [chapterId]);
        return rows[0] || null;
    }

    async function stats() {
        const q = async (sql) => (await pool.query(sql)).rows[0];
        return {
            books: Number((await q('SELECT COUNT(*) n FROM ncert_books')).n),
            chapters: Number((await q('SELECT COUNT(*) n FROM ncert_chapters')).n),
            chunks: Number((await q('SELECT COUNT(*) n FROM ncert_chunks')).n),
            embedded: Number((await q('SELECT COUNT(*) n FROM ncert_chunks WHERE embedding IS NOT NULL')).n)
        };
    }

    return { pool, init, buildVectorIndex, computeEditionRanks, upsertBook, upsertChapter,
             replaceChunks, search, currentShelf, currentSubjects, shelfHealth,
             allChapters, booksOn, bookMeta, chapterSpread, chapterChunks, chapterMeta, stats, DIMS };
}

module.exports = { createPgCorpus, DIMS };
