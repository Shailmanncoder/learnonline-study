// ================================================================
// Citations
// ----------------------------------------------------------------
// The ONLY place a citation shown to a student is assembled, and it
// reads nothing but stored database fields. A field that is null is
// omitted — never filled in, never estimated. A record that is not
// verified gets no citation at all, only "Exact source not verified."
//
// Nothing produced by a language model reaches this function.
// ================================================================
const { STATUS } = require('./verify');
const { assertAllowedUrl, parseHostList } = require('./fetcher');

const NOT_VERIFIED = 'Exact source not verified.';

const present = (v) => v !== null && v !== undefined && String(v).trim() !== '';

function isVerifiedStatus(s) {
    return s === STATUS.AUTO_VERIFIED || s === STATUS.HUMAN_VERIFIED;
}

function safeOfficialUrl(url, allowedHosts) {
    if (!present(url)) return null;
    try { return assertAllowedUrl(url, parseHostList(allowedHosts)).href; } catch (e) { return null; }
}

/**
 * @param q    questions row joined with its document:
 *             { verification_status, source_url, publisher, book_title, edition,
 *               class_level, subject, chapter, section, kind, question_number,
 *               printed_page, start_pdf_page, end_pdf_page, verified_at, updated_at,
 *               official_url, allowed_hosts, redistribution_allowed, usage_mode }
 */
function buildCitation(q) {
    const sourceUrl = safeOfficialUrl(q && q.source_url, q && q.allowed_hosts);
    // Verified means a verified status AND a real allowlisted URL. The one
    // exception is an authorised upload an administrator checked by hand: it
    // has no public URL, so it is citable only once HUMAN_VERIFIED, and it
    // never gets "view original" links.
    const humanCheckedUpload = q && q.verification_status === STATUS.HUMAN_VERIFIED && !present(q.source_url);
    if (!q || !isVerifiedStatus(q.verification_status) || (!sourceUrl && !humanCheckedUpload)) {
        return { verified: false, message: NOT_VERIFIED };
    }

    const fields = [];
    const add = (label, value) => { if (present(value)) fields.push({ label, value: String(value) }); };
    add('Publisher', q.publisher);
    add('Book', q.book_title);
    add('Edition', q.edition);
    add('Class', q.class_level ? `Class ${q.class_level}` : null);
    add('Subject', q.subject);
    add('Chapter', q.chapter);
    add('Section', q.section);
    if (present(q.question_number)) {
        add(q.kind === 'example' ? 'Example' : 'Question number', q.question_number);
    }
    add('Printed page', q.printed_page);
    if (present(q.start_pdf_page)) {
        add('PDF page', q.end_pdf_page && q.end_pdf_page !== q.start_pdf_page
            ? `${q.start_pdf_page}–${q.end_pdf_page}` : q.start_pdf_page);
    }
    if (sourceUrl) add('Official URL', safeOfficialUrl(q.official_url, q.allowed_hosts) || sourceUrl);
    add('Verification level', q.verification_status === STATUS.HUMAN_VERIFIED ? 'Human verified' : 'Automatically verified');
    add('Last verified', q.verified_at || q.updated_at);

    // The section is part of the identity whenever a book restarts numbering
    // in each section: "Question 5" alone would point at several questions.
    const heading = [];
    if (present(q.question_number)) {
        const label = q.kind === 'example' ? `Example ${q.question_number}` : `Question ${q.question_number}`;
        heading.push(q.kind !== 'example' && present(q.section) ? `${q.section} · ${label}` : label);
    }
    if (present(q.printed_page)) heading.push(`Printed Page ${q.printed_page}`);

    // A "#page=N" fragment is understood by PDF viewers only, and only for a
    // direct PDF URL. Anything else gets a plain link, labelled honestly.
    const isPdf = Boolean(sourceUrl) && /\.pdf(?:$|[?#])/i.test(sourceUrl);
    const exactPage = isPdf && present(q.start_pdf_page)
        ? { url: `${sourceUrl.split('#')[0]}#page=${q.start_pdf_page}`, label: 'View exact page', note: `Opens the official PDF at PDF page ${q.start_pdf_page} (supported by most browser PDF viewers).` }
        : null;

    return {
        verified: true,
        badge: q.verification_status === STATUS.HUMAN_VERIFIED ? 'VERIFIED SOURCE · HUMAN CHECKED' : 'VERIFIED SOURCE',
        title: q.book_title,
        line1: [q.class_level ? `Class ${q.class_level}` : null, q.subject].filter(present).join(' • '),
        line2: present(q.chapter) ? q.chapter : null,
        line3: heading.join(' • ') || null,
        fields,
        original: sourceUrl ? { url: sourceUrl.split('#')[0], label: 'View original' } : null,
        exactPage,
        // Rendering the document inside the app is allowed only when the
        // licence permits redistribution; otherwise students link out.
        embedAllowed: Number(q.redistribution_allowed) === 1
    };
}

module.exports = { buildCitation, isVerifiedStatus, NOT_VERIFIED };
