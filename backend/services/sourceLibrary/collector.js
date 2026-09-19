// ================================================================
// Source collector
// ----------------------------------------------------------------
//   trusted source (registry) → discover documents on its official page
//   → validate domain → fetch → hash / de-duplicate → extract pages
//   → detect printed pages → extract questions → auto-verify → store
//
// Every provenance value written here comes from the registry entry a
// human configured, the official listing page, or the document itself.
// None comes from a language model.
// ================================================================
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('../../config/db');
const { init } = require('./schema');
const { safeFetch, assertAllowedUrl, parseHostList, FetchPolicyError } = require('./fetcher');
const { extractPages, detectPrintedPages } = require('./pdfLayout');
const { parseQuestions, normaliseForMatch, numberTrusted } = require('./questionParser');
const { autoVerify, STATUS } = require('./verify');

const STORE = path.join(__dirname, '..', '..', 'database', 'source-library');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// ── Registry ─────────────────────────────────────────────────────────
// Seeded sources. Adding a publisher is a deliberate act: a new entry here
// (or through the admin API) with the hosts we are permitted to fetch.
const SEED_SOURCES = [{
    source_key: 'ncert-exemplar',
    publisher: 'NCERT',
    source_type: 'NCERT_EXEMPLAR',
    title: 'NCERT Exemplar Problems',
    official_url: 'https://ncert.nic.in/exemplar-problems.php?ln=en',
    allowed_hosts: 'ncert.nic.in',
    // NCERT material is the publisher's copyright. Short question excerpts
    // are shown with a link to the official PDF; documents are not re-served.
    usage_mode: 'excerpt_link',
    license_status: 'publisher_copyright',
    redistribution_allowed: 0,
    notes: 'Official NCERT Exemplar listing. robots.txt returned 404 (no restrictions) when this entry was added.'
}];

async function seedTrustedSources() {
    await init();
    for (const s of SEED_SOURCES) {
        const existing = await db.get('SELECT id FROM trusted_sources WHERE source_key = ?', [s.source_key]);
        if (existing) continue;
        await db.run(
            `INSERT INTO trusted_sources (source_key, publisher, source_type, title, official_url, allowed_hosts,
                usage_mode, license_status, redistribution_allowed, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [s.source_key, s.publisher, s.source_type, s.title, s.official_url, s.allowed_hosts,
             s.usage_mode, s.license_status, s.redistribution_allowed, s.notes]);
    }
}

async function getSource(idOrKey) {
    await init();
    return /^\d+$/.test(String(idOrKey))
        ? db.get('SELECT * FROM trusted_sources WHERE id = ?', [idOrKey])
        : db.get('SELECT * FROM trusted_sources WHERE source_key = ?', [idOrKey]);
}

async function addTrustedSource(input) {
    await init();
    const hosts = parseHostList(input.allowed_hosts);
    if (!hosts.length) throw new Error('At least one allowed host is required.');
    for (const h of hosts) {
        if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)) throw new Error(`Invalid host: ${h}`);
    }
    // The official page must itself be on the allowlist it declares.
    assertAllowedUrl(input.official_url, hosts);
    const key = String(input.source_key || '').trim();
    if (!/^[a-z0-9-]{3,80}$/.test(key)) throw new Error('source_key must be 3-80 lowercase letters, digits or dashes.');
    await db.run(
        `INSERT INTO trusted_sources (source_key, publisher, source_type, title, official_url, allowed_hosts,
            usage_mode, license_status, redistribution_allowed, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [key, String(input.publisher).slice(0, 160), String(input.source_type).slice(0, 40),
         String(input.title).slice(0, 255), input.official_url, hosts.join(','),
         ['metadata_only', 'excerpt_link', 'licensed_full_text', 'authorized_upload'].includes(input.usage_mode) ? input.usage_mode : 'metadata_only',
         String(input.license_status || 'unknown').slice(0, 80),
         input.redistribution_allowed ? 1 : 0, input.notes ? String(input.notes).slice(0, 600) : null]);
    return getSource(key);
}

// ── Discovery adapters ──────────────────────────────────────────────
// How to read a particular official listing page. Each adapter returns
// candidates with the label and link exactly as the page shows them.
const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12 };

// NCERT folder names vary in case and form ("Mathematics", "mathematics",
// "science", "mathematics(hindi)"). Stored as-is, a filter for "Mathematics"
// silently missed every Class 8 maths question. One canonical name per subject,
// with the edition language kept separately in the name only when it is not English.
function canonicalSubject(raw) {
    const s = String(raw || '').trim();
    const hindi = /\(\s*hindi\s*\)/i.test(s);
    const base = s.replace(/\(.*?\)/g, '').trim().toLowerCase();
    const names = { mathematics: 'Mathematics', maths: 'Mathematics', math: 'Mathematics', science: 'Science',
        physics: 'Physics', chemistry: 'Chemistry', biology: 'Biology' };
    const name = names[base] || (base ? base[0].toUpperCase() + base.slice(1) : s);
    return hindi ? `${name} (Hindi)` : name;
}
const toRoman = (n) => Object.keys(ROMAN).find(k => ROMAN[k] === Number(n));

function decodeEntities(s) {
    return String(s || '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

const ADAPTERS = {
    NCERT_EXEMPLAR: {
        // The listing groups documents in one tab per class: id="pills-classvii".
        discover(html, pageUrl, { classLevel, subject }) {
            const roman = toRoman(classLevel);
            if (!roman) throw new Error(`Unsupported class: ${classLevel}`);
            const start = html.indexOf(`id="pills-class${roman}"`);
            if (start < 0) return { candidates: [], rejected: [], note: `No section for Class ${classLevel} on the official page.` };
            const nextTab = html.slice(start + 20).search(/id="pills-class[ivx]+"/);
            const section = nextTab > 0 ? html.slice(start, start + 20 + nextTab) : html.slice(start);

            const candidates = [];
            const rejected = [];
            const anchor = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
            let m;
            while ((m = anchor.exec(section))) {
                const label = decodeEntities(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
                let url;
                try { url = new URL(decodeEntities(m[1]), pageUrl).href; } catch (e) { continue; }
                if (!/\.pdf(?:$|\?)/i.test(url)) continue;
                // Class and subject are read from the official path, not assumed:
                // /exemplarproblem/classVII/Mathematics/gemp101.pdf
                const p = url.match(/\/class([IVX]+)\/([^/]+)\/[^/]+\.pdf/i);
                if (!p) { rejected.push({ label, url, reason: 'unrecognised path' }); continue; }
                const docClass = ROMAN[p[1].toLowerCase()];
                const rawSubject = decodeURIComponent(p[2]);
                const docSubject = canonicalSubject(rawSubject);
                if (docClass !== Number(classLevel)) continue;
                if (subject && docSubject !== canonicalSubject(subject) && rawSubject.toLowerCase() !== String(subject).toLowerCase()) continue;
                // Chapter labels come in three shapes on the official page:
                // "Unit 1(Integers)", "16.Garbage in, Garbage out" and
                // "Chapter 2 (Units and Measurements)". Sample papers,
                // appendices and answer keys are not chapters and are not
                // treated as ones.
                const unit = label.match(/^Unit\s+(\d+)\s*\((.+)\)\s*$/i)
                    || label.match(/^(\d+)\s*[.:]\s*(\S.*)$/)
                    || label.match(/^Chapter\s+(\d+)\s*\(\s*(.+?)\s*\)\s*$/i)
                    || label.match(/^Chapter\s+(\d+)\s*[:.-]?\s*(\S.*)$/i);
                // Back matter is sometimes listed as a numbered unit: Class 11 Physics
                // shows "Unit 16 (Answers)" and "Unit 17 (Design of Question Paper)".
                // Parsed as questions, an answer key would be stored as questions.
                const chapterName = unit ? unit[2] : label;
                // "Solutions" alone is a real Class 12 Chemistry chapter, so only an
                // explicit answers / hints label counts ("ANSWERS TO MULTIPLE CHOICE
                // QUESTIONS", "MODEL ANSWERS TO DESCRIPTIVE QUESTIONS" in Class 11 Biology).
                const isAnswers = /\banswers?\b|\bhints?\b/i.test(chapterName) || /^\(?\s*answers?\s*\)?$/i.test(label);
                const isBackMatter = /\b(?:design\s+of\s+(?:the\s+)?question\s+paper|sample\s+(?:question\s+)?papers?|question\s+paper|appendi(?:x|ces)|glossary|bibliography|index|syllabus|blue\s*print)\b/i.test(chapterName);
                candidates.push({
                    label, url,
                    classLevel: docClass,
                    subject: docSubject,
                    unitNumber: unit ? Number(unit[1]) : null,
                    // The chapter name exactly as the official page labels it.
                    chapter: unit ? unit[2].trim() : null,
                    documentKind: isAnswers ? 'answers' : isBackMatter ? 'other' : (unit ? 'unit' : 'other')
                });
            }
            return { candidates, rejected };
        }
    }
};

async function discover(sourceIdOrKey, { classLevel, subject }) {
    const source = await getSource(sourceIdOrKey);
    if (!source) throw new Error('Trusted source not found.');
    if (!Number(source.enabled)) throw new Error('This trusted source is disabled.');
    const adapter = ADAPTERS[source.source_type];
    if (!adapter) throw new Error(`No discovery adapter for ${source.source_type}; upload documents manually.`);
    const hosts = parseHostList(source.allowed_hosts);
    const { buffer, finalUrl } = await safeFetch(source.official_url, { allowedHosts: hosts, kind: 'html' });
    const result = adapter.discover(buffer.toString('utf8'), finalUrl, { classLevel, subject });
    // Every discovered link is re-checked against the allowlist; off-site links
    // on an official page are reported, never followed.
    const allowed = [];
    for (const c of result.candidates) {
        try { assertAllowedUrl(c.url, hosts); allowed.push(c); }
        catch (e) { result.rejected.push({ label: c.label, url: c.url, reason: e.message }); }
    }
    return { source, pageUrl: finalUrl, candidates: allowed, rejected: result.rejected, note: result.note };
}

// ── Jobs ─────────────────────────────────────────────────────────────
// One job at a time, in-process: ingestion is slow, rate-limited, and must
// not compete with student requests on a small server.
const queue = [];
let running = false;

async function createJob(kind, params, userId) {
    await init();
    const r = await db.run(
        'INSERT INTO ingestion_jobs (kind, params_json, status, trusted_source_id, document_id, started_by) VALUES (?, ?, ?, ?, ?, ?)',
        [kind, JSON.stringify(params).slice(0, 1000), 'queued', params.sourceId || null, params.documentId || null, userId || null]);
    queue.push(r.lastID);
    if (!running) drain();
    return r.lastID;
}

async function jobLog(jobId, message, progress) {
    const line = `[${nowIso()}] ${message}`;
    const job = await db.get('SELECT log_text FROM ingestion_jobs WHERE id = ?', [jobId]);
    const log = ((job && job.log_text) ? job.log_text + '\n' : '') + line;
    await db.run('UPDATE ingestion_jobs SET log_text = ?, message = ?, progress = COALESCE(?, progress) WHERE id = ?',
        [log.slice(-20000), String(message).slice(0, 600), progress ?? null, jobId]);
}

async function drain() {
    running = true;
    while (queue.length) {
        const jobId = queue.shift();
        const job = await db.get('SELECT * FROM ingestion_jobs WHERE id = ?', [jobId]);
        if (!job || job.status !== 'queued') continue;
        await db.run("UPDATE ingestion_jobs SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = ?", [jobId]);
        try {
            const params = JSON.parse(job.params_json || '{}');
            if (job.kind === 'ingest_discovered') await runIngestDiscovered(jobId, params);
            else if (job.kind === 'process_document') await processDocument(params.documentId, (m, p) => jobLog(jobId, m, p));
            else throw new Error(`Unknown job kind ${job.kind}`);
            await db.run("UPDATE ingestion_jobs SET status = 'done', progress = 100, finished_at = CURRENT_TIMESTAMP WHERE id = ?", [jobId]);
        } catch (e) {
            await jobLog(jobId, `FAILED: ${e.message}`);
            await db.run("UPDATE ingestion_jobs SET status = 'failed', finished_at = CURRENT_TIMESTAMP WHERE id = ?", [jobId]);
        }
    }
    running = false;
}

async function resumeJobs() {
    await init();
    // A job interrupted by a restart is re-queued from the start; processing
    // is idempotent (documents de-duplicate by URL and hash).
    await db.run("UPDATE ingestion_jobs SET status = 'queued' WHERE status = 'running'");
    const rows = await db.all("SELECT id FROM ingestion_jobs WHERE status = 'queued' ORDER BY id");
    rows.forEach(r => queue.push(r.id));
    if (queue.length && !running) drain();
}

// Discover, then fetch and process the selected documents.
async function runIngestDiscovered(jobId, { sourceId, classLevel, subject, units = [], includeAnswers = false }) {
    const log = (m, p) => jobLog(jobId, m, p);
    await log(`Discovering Class ${classLevel} ${subject || ''} on the official listing…`, 2);
    const found = await discover(sourceId, { classLevel, subject });
    await log(`Official page ${found.pageUrl}: ${found.candidates.length} documents on allowed hosts, ${found.rejected.length} links rejected`, 5);
    for (const r of found.rejected.slice(0, 5)) await log(`  rejected: ${r.label || ''} ${r.url} — ${r.reason}`);

    let selected = found.candidates.filter(c => c.documentKind === 'unit');
    if (units.length) selected = selected.filter(c => units.includes(c.unitNumber));
    if (includeAnswers) selected = selected.concat(found.candidates.filter(c => c.documentKind === 'answers'));
    if (!selected.length) throw new Error('No matching documents on the official page.');

    for (let i = 0; i < selected.length; i++) {
        const c = selected[i];
        const base = 5 + Math.round((i / selected.length) * 90);
        await log(`[${i + 1}/${selected.length}] ${c.label} — ${c.url}`, base);
        const docId = await registerDocument(found.source, found.pageUrl, c);
        try {
            await processDocument(docId, (m) => log(`  ${m}`), { fetch: true });
        } catch (err) {
            // processDocument has already marked the document failed; carry on
            // with the rest of the book.
            await log(`  FAILED: ${String(err.message || err).slice(0, 200)}`);
        }
    }
}

async function registerDocument(source, officialUrl, c) {
    const existing = await db.get('SELECT id FROM source_documents WHERE document_url = ?', [c.url]);
    const title = `${source.title}: ${c.subject}`;          // registry title + subject from the official path
    if (existing) {
        await db.run(
            `UPDATE source_documents SET discovered_label = ?, chapter = ?, unit_number = ?, official_url = ?,
                date_last_checked = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [c.label, c.chapter, c.unitNumber, officialUrl, existing.id]);
        return existing.id;
    }
    const r = await db.run(
        `INSERT INTO source_documents (trusted_source_id, publisher, source_type, book_title, class_level, subject,
            unit_number, chapter, discovered_label, official_url, document_url, status, usage_mode, license_status,
            redistribution_allowed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?, ?)`,
        [source.id, source.publisher, source.source_type, title, String(c.classLevel), c.subject,
         c.unitNumber, c.chapter, c.label, officialUrl, c.url,
         source.usage_mode, source.license_status, source.redistribution_allowed]);
    return r.lastID;
}

// ── Processing one document ─────────────────────────────────────────
async function processDocument(documentId, log = async () => {}, { fetch: doFetch = false } = {}) {
    await init();
    const doc = await db.get(
        `SELECT d.*, s.allowed_hosts FROM source_documents d
         LEFT JOIN trusted_sources s ON s.id = d.trusted_source_id WHERE d.id = ?`, [documentId]);
    if (!doc) throw new Error(`Document ${documentId} not found`);
    if (doc.status === 'excluded') {
        await log(`Excluded — ${doc.error || 'not a question document'}; not processed`);
        return { excluded: true };
    }
    const file = path.join(STORE, `${doc.id}.pdf`);
    const uploaded = Boolean(doc.uploaded_by);

    try {
        let buffer;
        if (doFetch || !fs.existsSync(file)) {
            if (uploaded) throw new Error('Uploaded document file is missing; upload it again.');
            await log(`Fetching ${doc.document_url}`);
            const res = await safeFetch(doc.document_url, { allowedHosts: parseHostList(doc.allowed_hosts), kind: 'pdf' });
            buffer = res.buffer;
            const hash = sha256(buffer);
            // Same bytes as last time and already processed: nothing to redo.
            // (An explicit reprocess goes through the stored file instead.)
            if (hash === doc.content_hash && doc.status === 'processed') {
                await db.run('UPDATE source_documents SET date_last_checked = CURRENT_TIMESTAMP WHERE id = ?', [doc.id]);
                await log('Unchanged since last processing (same SHA-256) — skipped');
                return;
            }
            const dup = await db.get("SELECT id FROM source_documents WHERE content_hash = ? AND id <> ? AND status = 'processed'", [hash, doc.id]);
            if (dup) {
                await db.run("UPDATE source_documents SET status = 'duplicate', content_hash = ?, error = ?, date_last_checked = CURRENT_TIMESTAMP WHERE id = ?",
                    [hash, `Identical to document ${dup.id}`, doc.id]);
                await log(`Identical bytes to document ${dup.id} — not processed twice`);
                return;
            }
            fs.mkdirSync(STORE, { recursive: true });
            fs.writeFileSync(file, buffer);
            await db.run(
                `UPDATE source_documents SET content_hash = ?, bytes = ?, final_url = ?, date_last_checked = CURRENT_TIMESTAMP,
                    status = 'fetched', error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                [hash, buffer.length, res.finalUrl, doc.id]);
            doc.content_hash = hash;
            await log(`Downloaded ${buffer.length} bytes, SHA-256 ${hash.slice(0, 16)}…`);
        } else {
            buffer = fs.readFileSync(file);
            doc.content_hash = sha256(buffer);
        }

        await log('Extracting text page by page');
        const pages = await extractPages(buffer);
        await log(`${pages.length} PDF pages`);

        // Whatever the listing called it, a document that opens with an answers
        // heading is an answer key, and its entries must never become questions.
        const opening = (pages[0] ? pages[0].lines : []).filter(l => !l.margin && !l.blank).slice(0, 6).map(l => l.text.trim());
        const answerHeading = opening.find(t => /^(?:model\s+)?answers?\b|^hints?\s*(?:and|&)\s*solutions?\b/i.test(t) && t.length <= 60);
        if (answerHeading && !uploaded) {
            await db.run('DELETE FROM verification_logs WHERE question_id IN (SELECT id FROM questions WHERE document_id = ?)', [doc.id]);
            await db.run('DELETE FROM answer_sources WHERE question_id IN (SELECT id FROM questions WHERE document_id = ?)', [doc.id]);
            await db.run('DELETE FROM questions WHERE document_id = ?', [doc.id]);
            await db.run("UPDATE source_documents SET status = 'excluded', error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                [`Opens with "${answerHeading.slice(0, 60)}" — an answer key, not a question chapter`, doc.id]);
            await log(`Excluded — opens with "${answerHeading}", an answer key`);
            return { excluded: true };
        }

        await log('Reading printed page numbers (running heads, then footer OCR)');
        const printed = await detectPrintedPages(buffer, pages.length, { pageHeight: pages[0] ? pages[0].height : 821, pages });
        const printedCount = printed.pages.filter(p => p.printed !== null).length;
        await log(printed.conflict
            ? `Running heads and footer OCR disagree on page offset (${printed.conflict.join(' vs ')}) — printed pages left empty`
            : printed.offset === null
            ? 'No consistent printed page numbering found — printed pages left empty'
            : `Printed pages confirmed on ${printedCount}/${pages.length} pages (offset ${printed.offset}); the rest left empty`);

        await db.run('DELETE FROM document_pages WHERE document_id = ?', [doc.id]);
        for (const p of pages) {
            const pr = printed.pages.find(x => x.pdfPageIndex === p.pdfPageIndex) || {};
            await db.run(
                `INSERT INTO document_pages (document_id, pdf_page_index, printed_page, printed_page_evidence,
                    page_width, page_height, raw_text, lines_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [doc.id, p.pdfPageIndex, pr.printed ?? null, pr.evidence ? String(pr.evidence).slice(0, 120) : null,
                 p.width, p.height, p.rawText,
                 JSON.stringify(p.lines.filter(l => !l.blank).map(({ text, x, y, right, h }) => ({ text, x, y, right, h })))]);
        }

        await log('Extracting questions (deterministic parser)');
        const { questions, sections, integrity } = parseQuestions(pages);
        await log(`${questions.filter(q => q.kind === 'exercise').length} exercise questions, ${questions.filter(q => q.kind === 'example').length} solved examples; ${sections.length} labelled section ranges`);
        if (!integrity.ok) {
            const lim = (v) => (v === Infinity ? 'all' : `below ${v}`);
            await log(`NUMBERING INCOMPLETE — trusting exercise questions ${lim(integrity.exerciseTrustedBelow)} and examples ${lim(integrity.exampleTrustedBelow)}; the rest are held for human review:`);
            for (const p of integrity.problems.slice(0, 6)) await log(`  · ${p}`);
        }

        await db.run("UPDATE source_documents SET status = 'processed', pdf_pages = ?, printed_page_method = ?, printed_page_offset = ?, error = ?, processed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            [pages.length, printed.offset === null ? null : 'footer_ocr', printed.offset,
             integrity.ok ? null : `Numbering incomplete: ${integrity.problems[0]}`.slice(0, 600), doc.id]);
        const verifyDoc = { status: 'processed', content_hash: doc.content_hash, document_url: doc.document_url, allowedHosts: doc.allowed_hosts, uploaded };

        // Reprocessing keeps a human decision when the question is unchanged.
        const previous = await db.all('SELECT id, content_hash, verification_status, verified_by, verified_at FROM questions WHERE document_id = ?', [doc.id]);
        const kept = new Map(previous.filter(q => q.verification_status === STATUS.HUMAN_VERIFIED || q.verification_status === STATUS.REJECTED).map(q => [q.content_hash, q]));
        await db.run('DELETE FROM questions WHERE document_id = ?', [doc.id]);

        let auto = 0;
        for (const q of questions) {
            const startPage = pages.find(p => p.pdfPageIndex === q.startPdfPage);
            const pr = printed.pages.find(x => x.pdfPageIndex === q.startPdfPage) || {};
            const hash = sha256(Buffer.from([doc.content_hash, q.kind, q.questionNumber, normaliseForMatch(q.questionText)].join('|')));
            const v = autoVerify(q, verifyDoc, startPage ? startPage.rawText : '');
            // A document whose numbering does not add up cannot vouch for any
            // of its question numbers, however well each one checks locally.
            const trusted = numberTrusted(q, integrity);
            v.checks.push({ name: 'numbering intact up to this question', ok: trusted });
            if (!trusted) v.status = STATUS.UNVERIFIED;
            const prior = kept.get(hash);
            const status = prior ? prior.verification_status : v.status;
            if (status === STATUS.AUTO_VERIFIED) auto++;
            await db.run(
                `INSERT INTO questions (document_id, kind, publisher, book_title, class_level, subject, chapter, section,
                    exercise, question_number, question_text, start_pdf_page, end_pdf_page, printed_page, bbox_json,
                    source_url, source_type, verification_status, verification_notes, difficulty_score, content_hash,
                    verified_by, verified_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [doc.id, q.kind, doc.publisher, doc.book_title, doc.class_level, doc.subject, doc.chapter, q.section,
                 q.kind === 'exercise' ? 'Exercise' : null, q.questionNumber, q.questionText,
                 q.startPdfPage, q.endPdfPage, pr.printed ?? null, JSON.stringify(q.bbox).slice(0, 600),
                 uploaded ? null : doc.document_url, doc.source_type, status,
                 JSON.stringify(v.checks.map(c => ({ n: c.name, ok: c.ok }))).slice(0, 1000),
                 difficultyOf(q), hash,
                 prior ? prior.verified_by : null, prior ? prior.verified_at : (status === STATUS.AUTO_VERIFIED ? nowIso() : null)]);
        }
        await log(`Stored ${questions.length} questions — ${auto} auto-verified, ${questions.length - auto} need review`);
    } catch (e) {
        const msg = e instanceof FetchPolicyError ? `Blocked by collection policy: ${e.message}` : e.message;
        await db.run("UPDATE source_documents SET status = 'failed', error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [String(msg).slice(0, 600), doc.id]);
        throw new Error(msg);
    }
}

// A transparent difficulty estimate from the question's own shape. It ranks
// practice; it is never presented as the publisher's judgement.
function difficultyOf(q) {
    const text = String(q.questionText || '');
    let score = Math.min(1, text.length / 450);
    if (/\b(explain|justify|prove|show that|why|find|calculate|how many|what is the)\b/i.test(text)) score += 0.2;
    if ((text.match(/\n\(/g) || []).length >= 4 && !/\(a\)[\s\S]*\(d\)/.test(text)) score += 0.15;    // multi-part, not MCQ options
    if (/\(a\)[\s\S]*\(b\)[\s\S]*\(c\)[\s\S]*\(d\)/.test(text)) score -= 0.15;                           // MCQ
    if (q.section === 'True or False' || q.section === 'Fill in the Blanks') score -= 0.1;
    return Math.round(Math.max(0, Math.min(1, score)) * 100) / 100;
}

// Admin upload of material we are authorised to index. It can never be
// AUTO_VERIFIED (there is no official URL to check), so every question from
// it waits for a human.
async function registerUpload(buffer, meta, userId) {
    await init();
    if (!buffer || !buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('Only PDF files can be uploaded.');
    const hash = sha256(buffer);
    const dup = await db.get('SELECT id FROM source_documents WHERE content_hash = ?', [hash]);
    if (dup) throw new Error(`This exact file is already in the library (document ${dup.id}).`);
    let source = await getSource('admin-uploads');
    if (!source) {
        await db.run(
            `INSERT INTO trusted_sources (source_key, publisher, source_type, title, official_url, allowed_hosts,
                usage_mode, license_status, redistribution_allowed, enabled, notes)
             VALUES ('admin-uploads', 'Admin upload', 'AUTHORIZED_UPLOAD', 'Authorised uploads', 'https://learnonline.study', 'learnonline.study',
                'authorized_upload', 'see document', 0, 1, 'Documents uploaded by an administrator who confirmed permission to index them.')`);
        source = await getSource('admin-uploads');
    }
    const clean = (v, n) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n));
    if (!clean(meta.publisher, 160) || !clean(meta.book_title, 255)) throw new Error('Publisher and book title are required.');
    if (!clean(meta.license_status, 80)) throw new Error('State the licence or permission under which this document may be indexed.');
    const r = await db.run(
        `INSERT INTO source_documents (trusted_source_id, publisher, source_type, book_title, class_level, subject,
            unit_number, chapter, edition, discovered_label, document_url, content_hash, bytes, status, usage_mode,
            license_status, redistribution_allowed, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fetched', ?, ?, ?, ?)`,
        [source.id, clean(meta.publisher, 160), clean(meta.source_type, 40) || 'AUTHORIZED_UPLOAD', clean(meta.book_title, 255),
         clean(meta.class_level, 20), clean(meta.subject, 80), meta.unit_number ? Number(meta.unit_number) : null,
         clean(meta.chapter, 255), clean(meta.edition, 80), clean(meta.filename, 255),
         `upload://${hash}`, hash, buffer.length,
         ['metadata_only', 'excerpt_link', 'licensed_full_text', 'authorized_upload'].includes(meta.usage_mode) ? meta.usage_mode : 'authorized_upload',
         clean(meta.license_status, 80), meta.redistribution_allowed ? 1 : 0, userId || null]);
    fs.mkdirSync(STORE, { recursive: true });
    fs.writeFileSync(path.join(STORE, `${r.lastID}.pdf`), buffer);
    return r.lastID;
}

module.exports = {
    seedTrustedSources, getSource, addTrustedSource, discover, createJob, resumeJobs,
    processDocument, registerUpload, difficultyOf, canonicalSubject, ADAPTERS, STORE
};
