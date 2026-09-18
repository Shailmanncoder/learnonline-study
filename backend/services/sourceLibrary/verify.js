// ================================================================
// Automatic verification
// ----------------------------------------------------------------
// AUTO_VERIFIED is earned, not defaulted: every check below must pass,
// and each one tests the stored record against the stored document —
// never against anything a model produced. A failed check leaves the
// question UNVERIFIED with the reason recorded, for a human to review.
// ================================================================
const { normaliseForMatch } = require('./questionParser');
const { assertAllowedUrl, parseHostList } = require('./fetcher');

const MAX_QUESTION_CHARS = 1500;
const STATUS = Object.freeze({
    UNVERIFIED: 'UNVERIFIED',
    AUTO_VERIFIED: 'AUTO_VERIFIED',
    HUMAN_VERIFIED: 'HUMAN_VERIFIED',
    REJECTED: 'REJECTED'
});

// Exact characters with whitespace removed and dash variants unified, so a
// line break or a thin space in the PDF does not defeat the comparison.
function compact(text) {
    return String(text || '').toLowerCase().replace(/[–—−]/g, '-').replace(/_+/g, '_').replace(/\s+/g, '');
}

function onAllowedHost(url, allowedHosts) {
    try { assertAllowedUrl(url, allowedHosts); return true; } catch (e) { return false; }
}

/**
 * @param question  parsed question (questionNumber, questionText, kind, startPdfPage, sequenceConsistent)
 * @param doc       { status, content_hash, document_url, uploaded } plus allowedHosts
 * @param pageText  raw text of the question's start page, as stored
 */
function autoVerify(question, doc, pageText) {
    const allowedHosts = parseHostList(doc.allowedHosts);
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

    // Admin-uploaded material has no public URL to check; it can never be
    // auto-verified and always goes to a human.
    const uploaded = Boolean(doc.uploaded);
    add('official allowed domain', !uploaded && onAllowedHost(doc.document_url, allowedHosts),
        uploaded ? 'manually uploaded — needs human verification' : doc.document_url);
    add('document processed', doc.status === 'processed' && /^[a-f0-9]{64}$/.test(String(doc.content_hash || '')));
    add('source URL stored', !uploaded && Boolean(doc.document_url));

    const number = String(question.questionNumber || '');
    add('question number from document', /^\d{1,3}(?:\.\d{1,3})?$/.test(number));
    add('numbering in sequence', question.sequenceConsistent === true);

    const page = normaliseForMatch(pageText);
    const body = normaliseForMatch(question.questionText);
    // The opening words, long enough to be distinctive, short enough to sit on
    // the start page even for a question that continues onto the next page.
    const opening = body.split(' ').slice(0, 8).join(' ');
    // Symbol-heavy maths ("(– 25) × 30 = – 30 × ____") reduces to "25 30 30"
    // once punctuation is stripped — too short to count as evidence — so it
    // is also compared with its symbols kept and only whitespace removed.
    // That exact character run on the recorded page is stronger evidence
    // than matching words, not weaker.
    const compactOpening = compact(question.questionText).slice(0, 24);
    const wordsMatch = opening.length >= 12 && page.includes(opening);
    const symbolsMatch = compactOpening.length >= 10 && compact(pageText).includes(compactOpening);
    add('question text on recorded page', wordsMatch || symbolsMatch, wordsMatch ? opening : compactOpening);

    // The number must stand immediately before that text on the page.
    // Compared in normalised form: "2.13" becomes "2 13" on the page text.
    const label = question.kind === 'example' ? `example ${number}` : number.replace(/\./g, ' ');
    const firstWords = body.split(' ').slice(0, 3).join(' ');
    add('question number next to question', firstWords.length > 0 && page.includes(`${label} ${firstWords}`));

    // The text must say something beyond option labels. "(a) × (b) ×" is a
    // fraction question whose fractions were images: its citation would be
    // right, but the question shown would be meaningless.
    const substance = String(question.questionText || '')
        .replace(/\(\s*(?:[a-e]|[ivx]{1,4})\s*\)/gi, '')
        .replace(/\s+/g, '');
    add('question text readable', substance.length >= 6);
    // A "question" of several thousand characters is a question that swallowed
    // the activity boxes or chapter overview after it. Its number and page may
    // be right, but the text shown would not be the question.
    add('question text a plausible length', String(question.questionText || '').length <= MAX_QUESTION_CHARS);

    const passed = checks.every(c => c.ok);
    return {
        status: passed ? STATUS.AUTO_VERIFIED : STATUS.UNVERIFIED,
        checks,
        failed: checks.filter(c => !c.ok).map(c => c.name)
    };
}

module.exports = { autoVerify, STATUS };
