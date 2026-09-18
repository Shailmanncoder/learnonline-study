// ================================================================
// Verified Source Library — schema
// ----------------------------------------------------------------
// Relational tables in the application database (SQLite locally,
// MySQL where configured). Provenance lives in columns, never in a
// model's output: every citation field a student sees is read from
// here and written only by the ingestion pipeline or a logged admin
// edit.
// ================================================================
const db = require('../../config/db');

let ready;

function init() {
    return ready ||= (async () => {
        // The db wrapper reports 'mysql' until its connection settles, so the
        // dialect must be read only after db.ready() — reading it early once
        // produced a MySQL key on SQLite that never auto-incremented.
        await db.ready();
        const mysql = db.dialect() === 'mysql';
        const pk = mysql ? 'INT AUTO_INCREMENT PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
        const text = mysql ? 'MEDIUMTEXT' : 'TEXT';
        const ts = 'DATETIME DEFAULT CURRENT_TIMESTAMP';

        const tables = [
            // An origin we are permitted to collect from. official_url is the
            // listing page discovery starts at; allowed_hosts is the exact-host
            // allowlist every fetch and redirect is checked against.
            `CREATE TABLE IF NOT EXISTS trusted_sources (
                id ${pk},
                source_key VARCHAR(80) NOT NULL UNIQUE,
                publisher VARCHAR(160) NOT NULL,
                source_type VARCHAR(40) NOT NULL,
                title VARCHAR(255) NOT NULL,
                official_url VARCHAR(600) NOT NULL,
                allowed_hosts VARCHAR(600) NOT NULL,
                usage_mode VARCHAR(40) NOT NULL DEFAULT 'excerpt_link',
                license_status VARCHAR(80) NOT NULL DEFAULT 'publisher_copyright',
                redistribution_allowed INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL DEFAULT 1,
                notes VARCHAR(600),
                created_at ${ts},
                updated_at ${ts}
            )`,
            // One collected document (e.g. one Exemplar unit PDF).
            `CREATE TABLE IF NOT EXISTS source_documents (
                id ${pk},
                trusted_source_id INTEGER NOT NULL,
                publisher VARCHAR(160) NOT NULL,
                source_type VARCHAR(40) NOT NULL,
                book_title VARCHAR(255) NOT NULL,
                class_level VARCHAR(20),
                subject VARCHAR(80),
                unit_number INTEGER,
                chapter VARCHAR(255),
                edition VARCHAR(80),
                discovered_label VARCHAR(255),
                official_url VARCHAR(600),
                document_url VARCHAR(600) NOT NULL,
                final_url VARCHAR(600),
                content_hash VARCHAR(64),
                bytes INTEGER,
                pdf_pages INTEGER,
                printed_page_method VARCHAR(40),
                printed_page_offset INTEGER,
                status VARCHAR(20) NOT NULL DEFAULT 'discovered',
                error VARCHAR(600),
                usage_mode VARCHAR(40) NOT NULL DEFAULT 'excerpt_link',
                license_status VARCHAR(80) NOT NULL DEFAULT 'publisher_copyright',
                redistribution_allowed INTEGER NOT NULL DEFAULT 0,
                uploaded_by INTEGER,
                date_discovered ${ts},
                date_last_checked DATETIME,
                processed_at DATETIME,
                created_at ${ts},
                updated_at ${ts}
            )`,
            // Text of one PDF page, kept page by page. printed_page is NULL
            // unless it was read from the page itself and agreed with the rest
            // of the document — it is never assumed equal to pdf_page_index.
            `CREATE TABLE IF NOT EXISTS document_pages (
                id ${pk},
                document_id INTEGER NOT NULL,
                pdf_page_index INTEGER NOT NULL,
                printed_page INTEGER,
                printed_page_evidence VARCHAR(120),
                page_width REAL,
                page_height REAL,
                raw_text ${text},
                lines_json ${text},
                created_at ${ts}
            )`,
            `CREATE TABLE IF NOT EXISTS questions (
                id ${pk},
                document_id INTEGER NOT NULL,
                kind VARCHAR(20) NOT NULL DEFAULT 'exercise',
                publisher VARCHAR(160) NOT NULL,
                book_title VARCHAR(255) NOT NULL,
                class_level VARCHAR(20),
                subject VARCHAR(80),
                chapter VARCHAR(255),
                section VARCHAR(120),
                exercise VARCHAR(120),
                question_number VARCHAR(20),
                question_text ${text} NOT NULL,
                start_pdf_page INTEGER NOT NULL,
                end_pdf_page INTEGER NOT NULL,
                printed_page INTEGER,
                bbox_json VARCHAR(600),
                source_url VARCHAR(600),
                source_type VARCHAR(40) NOT NULL,
                verification_status VARCHAR(20) NOT NULL DEFAULT 'UNVERIFIED',
                verification_notes VARCHAR(1000),
                difficulty_score REAL,
                content_hash VARCHAR(64) NOT NULL,
                verified_by INTEGER,
                verified_at DATETIME,
                created_at ${ts},
                updated_at ${ts}
            )`,
            // Answers carry their OWN provenance. Nothing here is created for
            // AI explanations — those are labelled at render time and never
            // stored as if they came from a book.
            `CREATE TABLE IF NOT EXISTS answer_sources (
                id ${pk},
                question_id INTEGER NOT NULL,
                answer_text ${text} NOT NULL,
                document_id INTEGER,
                pdf_page_index INTEGER,
                printed_page INTEGER,
                source_url VARCHAR(600),
                verification_status VARCHAR(20) NOT NULL DEFAULT 'UNVERIFIED',
                created_at ${ts}
            )`,
            `CREATE TABLE IF NOT EXISTS ingestion_jobs (
                id ${pk},
                trusted_source_id INTEGER,
                document_id INTEGER,
                kind VARCHAR(30) NOT NULL,
                params_json VARCHAR(1000),
                status VARCHAR(20) NOT NULL DEFAULT 'queued',
                progress INTEGER NOT NULL DEFAULT 0,
                message VARCHAR(600),
                log_text ${text},
                started_by INTEGER,
                created_at ${ts},
                started_at DATETIME,
                finished_at DATETIME
            )`,
            `CREATE TABLE IF NOT EXISTS verification_logs (
                id ${pk},
                question_id INTEGER NOT NULL,
                admin_user_id INTEGER,
                action VARCHAR(20) NOT NULL,
                from_status VARCHAR(20),
                to_status VARCHAR(20),
                changes_json VARCHAR(2000),
                note VARCHAR(600),
                created_at ${ts}
            )`
        ];
        for (const sql of tables) await db.run(sql);

        const indexes = [
            'CREATE INDEX IF NOT EXISTS idx_srcdoc_lookup ON source_documents(class_level, subject, source_type)',
            'CREATE UNIQUE INDEX IF NOT EXISTS idx_srcdoc_url ON source_documents(document_url)',
            'CREATE INDEX IF NOT EXISTS idx_srcdoc_hash ON source_documents(content_hash)',
            'CREATE UNIQUE INDEX IF NOT EXISTS idx_docpage ON document_pages(document_id, pdf_page_index)',
            'CREATE INDEX IF NOT EXISTS idx_q_filter ON questions(class_level, subject, chapter, source_type, verification_status)',
            'CREATE INDEX IF NOT EXISTS idx_q_doc ON questions(document_id, kind, question_number)',
            'CREATE INDEX IF NOT EXISTS idx_q_hash ON questions(content_hash)',
            'CREATE INDEX IF NOT EXISTS idx_ans_q ON answer_sources(question_id)',
            'CREATE INDEX IF NOT EXISTS idx_vlog_q ON verification_logs(question_id)',
            'CREATE INDEX IF NOT EXISTS idx_jobs_status ON ingestion_jobs(status)'
        ];
        // MySQL has no "IF NOT EXISTS" on CREATE INDEX; an existing index errors
        // harmlessly there and is ignored.
        for (const sql of indexes) {
            await db.run(mysql ? sql.replace(' IF NOT EXISTS', '') : sql).catch(() => {});
        }
    })().catch((e) => { ready = null; throw e; });
}

module.exports = { init };
