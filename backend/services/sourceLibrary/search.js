// ================================================================
// Library search — metadata first, then ranking
// ----------------------------------------------------------------
// A question like "Class 7 maths integers exemplar questions" is parsed
// into filters (class, subject, chapter, source type) that are applied in
// SQL BEFORE anything is ranked, so ranking can only reorder questions
// that genuinely belong to what was asked for.
//
// Ranking is transparent and every recommendation carries its reasons.
// Nothing here calls a question "important" or "likely in the exam":
// NCERT says no such thing, so neither do we.
// ================================================================
const db = require('../../config/db');
const { init } = require('./schema');
const { STATUS } = require('./verify');
const { normaliseForMatch } = require('./questionParser');
const { namesTitle } = require('../translit');

const SUBJECTS = [
    [/\b(maths?|mathematics|ganit)\b/i, 'Mathematics'],
    [/\b(physics|bhautiki)\b/i, 'Physics'],
    [/\b(chemistry|rasayan)\b/i, 'Chemistry'],
    [/\b(biology|jeev\s*vigyan)\b/i, 'Biology'],
    [/\b(science|vigyan)\b/i, 'Science']
];
const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12 };

function parseQuery(text, facts = []) {
    const t = String(text || '');
    const fact = (k) => (facts.find(f => f.mem_key === k) || {}).mem_value || '';
    let classLevel = null;
    const d = t.match(/\b(?:class|grade|std|kaksha)\s*[-–]?\s*(\d{1,2})\b/i) || t.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+(?:class|grade|std)\b/i);
    const r = t.match(/\b(?:class|grade|std)\s*[-–]?\s*(xii|xi|x|ix|viii|vii|vi|v|iv|iii|ii|i)\b/i);
    if (d && Number(d[1]) >= 1 && Number(d[1]) <= 12) classLevel = String(Number(d[1]));
    else if (r) classLevel = String(ROMAN[r[1].toLowerCase()]);
    else if (/^\d{1,2}$/.test(fact('class'))) classLevel = fact('class');

    let subject = null;
    for (const [re, name] of SUBJECTS) if (re.test(t)) { subject = name; break; }

    const sourceType = /\bexemplar\b/i.test(t) ? 'NCERT_EXEMPLAR' : null;
    const wantDifficult = /\b(difficult|hard|hardest|challenging|tough|higher order|hots|advanced)\b/i.test(t);
    const wantEasy = /\b(easy|basic|simple|beginner)\b/i.test(t);
    let section = null;
    if (/\b(mcq|multiple choice|objective)\b/i.test(t)) section = 'Multiple Choice Questions';
    else if (/\bfill(ing)? in the blanks?\b/i.test(t)) section = 'Fill in the Blanks';
    else if (/\btrue (or|\/) false\b/i.test(t)) section = 'True or False';
    const wantExamples = /\b(solved examples?|examples?)\b/i.test(t);
    // "2 difficult Class 7 integers questions" asks for two. The number may sit
    // several words before "questions", but never the class number itself.
    const countMatch = t.match(/(?<!(?:class|grade|std|kaksha)\s*)\b(\d{1,2})\s+(?:[a-z0-9]+\s+){0,5}?(?:questions|problems|mcqs?)\b/i);
    const limit = countMatch ? Math.min(20, Math.max(1, Number(countMatch[1]))) : 8;
    return { classLevel, subject, sourceType, wantDifficult, wantEasy, section, wantExamples, limit, raw: t };
}

// Chapters are matched against those actually in the library for the
// requested class and subject — never taken from the question text alone.
async function resolveChapter(query) {
    const where = ['q.verification_status <> ?'];
    const params = [STATUS.REJECTED];
    if (query.classLevel) { where.push('q.class_level = ?'); params.push(query.classLevel); }
    if (query.subject) { where.push('q.subject = ?'); params.push(query.subject); }
    const rows = await db.all(`SELECT DISTINCT q.chapter FROM questions q WHERE ${where.join(' AND ')} AND q.chapter IS NOT NULL`, params);
    let best = null;
    for (const r of rows) {
        const score = namesTitle(query.raw, r.chapter);
        if (score >= 0.6 && (!best || score > best.score)) best = { chapter: r.chapter, score };
    }
    return best ? best.chapter : null;
}

const CORE_TERM_CACHE = new Map();
// Terms from the chapter's own opening pages ("Main Concepts and Results"),
// used to tell whether a question exercises a core idea of the chapter.
async function coreTermsFor(documentId) {
    if (CORE_TERM_CACHE.has(documentId)) return CORE_TERM_CACHE.get(documentId);
    const page = await db.get('SELECT raw_text FROM document_pages WHERE document_id = ? AND pdf_page_index = 1', [documentId]);
    const words = normaliseForMatch(page ? page.raw_text : '').split(' ')
        .filter(w => w.length >= 6 && !/^(integers?|between|number|numbers|following|therefore|result|results)$/.test(w));
    const counts = new Map();
    words.forEach(w => counts.set(w, (counts.get(w) || 0) + 1));
    const terms = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([w]) => w);
    CORE_TERM_CACHE.set(documentId, terms);
    return terms;
}

/**
 * @returns { query, chapter, results: [{ row, reasons, score }], total }
 */
async function searchQuestions(text, { facts = [], weakTopics = [], limit } = {}) {
    await init();
    const query = parseQuery(text, facts);
    const chapter = await resolveChapter(query);
    const where = ['q.verification_status <> ?'];
    const params = [STATUS.REJECTED];
    if (query.classLevel) { where.push('q.class_level = ?'); params.push(query.classLevel); }
    if (query.subject) { where.push('q.subject = ?'); params.push(query.subject); }
    if (chapter) { where.push('q.chapter = ?'); params.push(chapter); }
    if (query.sourceType) { where.push('q.source_type = ?'); params.push(query.sourceType); }
    if (query.section) { where.push('q.section = ?'); params.push(query.section); }
    where.push(query.wantExamples ? "q.kind = 'example'" : "q.kind = 'exercise'");

    const rows = await db.all(
        `SELECT q.*, d.official_url, d.edition, d.redistribution_allowed, d.usage_mode, s.allowed_hosts
         FROM questions q
         JOIN source_documents d ON d.id = q.document_id
         LEFT JOIN trusted_sources s ON s.id = d.trusted_source_id
         WHERE ${where.join(' AND ')}`, params);

    // Words already used as filters (class, subject, chapter name) say nothing
    // about which question fits better, so they do not earn "matches" credit.
    const chapterWords = new Set(normaliseForMatch(chapter || '').split(' ').flatMap(w => [w, w.replace(/s$/, '')]));
    const terms = normaliseForMatch(text).split(' ').filter(w => w.length >= 4 &&
        !chapterWords.has(w) && !chapterWords.has(w.replace(/s$/, '')) &&
        !/^(class|maths?|mathematics|science|ncert|exemplar|questions?|give|important|practice|difficult|challenging|chapter|from|with|some|show|find|easy|hard|recommended|hardest|problems?)$/.test(w));
    const weak = weakTopics.map(w => normaliseForMatch(w.topic || w)).filter(Boolean);

    const scored = [];
    for (const row of rows) {
        const reasons = [];
        let score = 0;
        const body = normaliseForMatch(row.question_text);

        if (row.verification_status === STATUS.HUMAN_VERIFIED) { score += 3; reasons.push('Checked by a teacher/admin'); }
        else if (row.verification_status === STATUS.AUTO_VERIFIED) { score += 2; reasons.push('Source automatically verified'); }

        const termHits = terms.filter(t => body.includes(t)).length;
        if (termHits) { score += termHits * 2; reasons.push('Matches what you asked about'); }

        const core = await coreTermsFor(row.document_id);
        const coreHits = core.filter(t => body.includes(t)).length;
        if (coreHits) { score += Math.min(3, coreHits); reasons.push(`Uses a core idea of ${row.chapter || 'the chapter'}`); }

        const difficulty = Number(row.difficulty_score || 0);
        if (query.wantDifficult) { score += difficulty * 6; if (difficulty >= 0.55) reasons.push('One of the more demanding questions here'); }
        else if (query.wantEasy) { score += (1 - difficulty) * 6; if (difficulty <= 0.3) reasons.push('A good warm-up question'); }
        else { score += difficulty * 2; }

        if (row.source_type === 'NCERT_EXEMPLAR') reasons.push('From NCERT Exemplar practice material');
        if (weak.some(w => w && (body.includes(w) || normaliseForMatch(row.chapter).includes(w)))) {
            score += 3; reasons.push('Targets a topic you found hard before');
        }
        scored.push({ row, score, reasons: [...new Set(reasons)] });
    }

    // Stable, explainable order; spread across sections so a list is not all MCQs.
    scored.sort((a, b) => b.score - a.score || Number(a.row.question_number) - Number(b.row.question_number));
    const take = limit || query.limit;
    const picked = [];
    const perSection = new Map();
    for (const s of scored) {
        const key = s.row.section || 'Other';
        if (!query.section && (perSection.get(key) || 0) >= Math.ceil(take / 2)) continue;
        picked.push(s);
        perSection.set(key, (perSection.get(key) || 0) + 1);
        if (picked.length >= take) break;
    }
    return { query, chapter, results: picked, total: rows.length };
}

// "Where is this question from?" — find the stored question a pasted text
// matches. Students paste a stem without its options, so the score is how
// much of the PASTED text the stored question contains. The match must also
// be unambiguous: a short paste like "which of the following" fits many
// questions, and picking one of them would be exactly the wrong citation.
const TRACE_MIN = 0.9;
const TRACE_MIN_WORDS = 5;
const TRACE_MIN_SHARE = 0.3;

async function findSourceOfText(questionText) {
    await init();
    const target = normaliseForMatch(questionText);
    const want = [...new Set(target.split(' ').filter(Boolean))];
    if (want.length < TRACE_MIN_WORDS) return null;
    const probe = want.filter(w => w.length >= 4).sort((a, b) => b.length - a.length)[0];
    if (!probe) return null;
    const candidates = await db.all(
        `SELECT q.*, d.official_url, d.edition, d.redistribution_allowed, d.usage_mode, s.allowed_hosts
         FROM questions q JOIN source_documents d ON d.id = q.document_id
         LEFT JOIN trusted_sources s ON s.id = d.trusted_source_id
         WHERE q.verification_status <> ? AND LOWER(q.question_text) LIKE ?`, [STATUS.REJECTED, `%${probe}%`]);

    const scored = candidates.map((c) => {
        const have = new Set(normaliseForMatch(c.question_text).split(' ').filter(Boolean));
        const matched = want.filter(w => have.has(w)).length;
        // Containment alone lets a huge stored text "contain" any sentence built
        // from common words. The pasted text must also be a real share of the
        // stored question.
        return { row: c, score: matched / want.length, share: have.size ? matched / have.size : 0 };
    }).filter(x => x.share >= TRACE_MIN_SHARE).sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best || best.score < TRACE_MIN) return null;
    const rival = scored[1];
    if (rival && best.score - rival.score < 0.1) return { ambiguous: true, count: scored.filter(x => x.score >= TRACE_MIN).length };
    return best;
}

module.exports = { parseQuery, searchQuestions, findSourceOfText, resolveChapter };
