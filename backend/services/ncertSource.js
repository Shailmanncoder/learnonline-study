const { createHash } = require('node:crypto');
const NCERT_CHANNEL = '0125196274181898243'; // Observed on NCERT's public DIKSHA catalog.
const HOSTS = new Set(['diksha.gov.in', 'obj.diksha.gov.in', 'files.odev.oci.diksha.gov.in', 'ncert.nic.in', 'www.ncert.nic.in']);
const hash = value => createHash('sha256').update(value).digest('hex');
const list = value => Array.isArray(value) ? value : value ? [value] : [];

function safeUrl(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) {
        throw new Error('Unapproved textbook source URL');
    }
    return url.href;
}

// A single total timeout punishes big files for being big: NCERT chapter
// PDFs reach ~57MB and take ~105s on a normal link, so a 120s cap failed
// them intermittently and stored them as zero-page chapters. Time out on
// *stalled* transfers instead — no bytes for STALL_MS — so a slow but
// healthy download is allowed to finish.
const CONNECT_MS = 60000;
const STALL_MS = 90000;

async function download(url, options = {}, maxBytes = 24 * 1024 * 1024) {
    safeUrl(url);
    for (let attempt = 0; attempt < 4; attempt++) {
        let response;
        const controller = new AbortController();
        let timer = setTimeout(() => controller.abort(), CONNECT_MS);
        const resetStall = () => {
            clearTimeout(timer);
            timer = setTimeout(() => controller.abort(), STALL_MS);
        };
        try {
            response = await fetch(url, { ...options, redirect: 'error', signal: controller.signal });
        } catch (error) {
            clearTimeout(timer);
            if (attempt === 3) throw error;
            await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
            continue;
        }
        if ((response.status === 429 || response.status >= 500) && attempt < 3) {
            clearTimeout(timer);
            const retry = Number(response.headers.get('retry-after'));
            await response.body?.cancel();
            await new Promise(r => setTimeout(r, Math.min(60000, Math.max(1000 * 2 ** attempt, (retry || 0) * 1000))));
            continue;
        }
        if (!response.ok) { clearTimeout(timer); await response.body?.cancel(); throw new Error(`Source HTTP ${response.status}`); }
        if (Number(response.headers.get('content-length')) > maxBytes) {
            clearTimeout(timer); await response.body?.cancel(); throw new Error('Source exceeds size limit');
        }
        const parts = []; let length = 0;
        try {
            resetStall();
            for await (const part of response.body) {
                resetStall();
                length += part.length;
                if (length > maxBytes) throw new Error('Source exceeds size limit');
                parts.push(part);
            }
        } finally {
            clearTimeout(timer);
        }
        return Buffer.concat(parts);
    }
}

async function api(path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.DIKSHA_TOKEN) headers.Authorization = `Bearer ${process.env.DIKSHA_TOKEN}`;
    const bytes = await download(`https://diksha.gov.in${path}`, {
        method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {})
    });
    const payload = JSON.parse(bytes.toString('utf8'));
    if (payload.responseCode !== 'OK' || !payload.result) throw new Error('Invalid DIKSHA response');
    return payload.result;
}

async function* discover(extraFilters = {}, request = api) {
    const seen = new Set(); let offset = 0;
    for (let page = 0; page < 10000; page++) {
        const result = await request('/api/content/v1/search', { request: {
            filters: { ...extraFilters, contentType: ['TextBook'], status: ['Live'], channel: NCERT_CHANNEL },
            limit: 100, offset, sort_by: { identifier: 'asc' }
        }});
        if (Number.isInteger(result.count) && result.count >= 0 && offset >= result.count && result.content === undefined) return;
        if (!Array.isArray(result.content)) throw new Error('Missing catalog page');
        if (!result.content.length) return;
        if (result.content.every(b => seen.has(b.identifier))) throw new Error('Pagination stalled');
        for (const book of result.content) {
            if (!book.identifier) throw new Error('Missing book ID');
            if (!seen.has(book.identifier)) { seen.add(book.identifier); yield book; }
        }
        offset += result.content.length;
    }
    throw new Error('Catalog page limit reached');
}

function textbookChapters(root) {
    const chapters = [];
    function visit(node, parents = [], ancestors = new Set()) {
        if (!node.identifier || ancestors.has(node.identifier)) throw new Error('Invalid/cyclic hierarchy');
        if (node.children !== undefined && !Array.isArray(node.children)) throw new Error('Malformed hierarchy children');
        const lineage = [...parents, node];
        // Only explicit eTextbook containers qualify, never arbitrary linked PDF worksheets.
        const marker = value => /(?:^|[\s(])e[ -]?text\s?book(?:$|[\s)])/i.test(value || '');
        const containerIndex = parents.findIndex((p, i) => i > 0 && marker(p.name));
        const explicitResource = marker(node.primaryCategory);
        if (node.mimeType === 'application/pdf' && (containerIndex >= 0 || explicitResource)) {
            // Chapter names are multilingual and often start with a number, not 'Chapter'.
            const chapter = containerIndex > 1 ? parents[containerIndex - 1]
                : parents.length > 1 ? parents[1] : node;
            if (chapter && node.artifactUrl) chapters.push({
                id: `${chapter.identifier}:${node.identifier}`, name: chapter.name,
                nodeId: chapter.identifier, resourceId: node.identifier,
                url: safeUrl(node.artifactUrl), license: node.license || root.license || null,
                resourceVersion: String(node.pkgVersion || node.lastUpdatedOn || ''),
                status: 'pending', pages: []
            });
        }
        for (const child of node.children || []) visit(child, lineage, new Set([...ancestors, node.identifier]));
    }
    visit(root);
    return [...new Map(chapters.map(c => [c.id, c])).values()];
}

// Grading a chapter is a judgement about usability, not a purity test.
// The previous rule required EVERY page to carry >=40 chars, so a single
// full-page illustration or title page condemned an otherwise perfect
// chapter — 175 already-downloaded chapters (2.6M chars of clean text)
// were sitting in review because of it.
//
//   ready        - enough of the chapter extracted to teach from
//   needs_review - real text, but gaps a human should look at
//   unavailable  - image-only/scanned; needs OCR, not review
const READABLE_PAGE_CHARS = 40;
const READY_PAGE_RATIO = 0.6;
const READY_MIN_CHARS = 1500;
const PARTIAL_PAGE_RATIO = 0.1;
const PARTIAL_MIN_CHARS = 400;
// A short chapter is not a broken chapter. NCERT Lab Manual activities and
// vocational units run 1-3 pages; the 1500-char floor alone flagged 97 of
// them for review despite every page extracting cleanly. When nearly every
// page is readable, judge density instead of total length — the only things
// that fail this are heading/TOC stubs (~110 chars/page against a median of
// 616 across the chapters this rule recovers).
const COMPLETE_PAGE_RATIO = 0.9;
const COMPLETE_CHARS_PER_PAGE = 250;


// ---------------------------------------------------------------------
// Indic script integrity
// ---------------------------------------------------------------------
// Many DIKSHA PDFs in Devanagari carry a broken font-to-Unicode map, so
// extraction yields text that looks like Hindi but is not: "बातीें होतीी हैं"
// for "बातें होती हैं", "मक" for "कि", "अहधकार" for "अंधकार". It reads as
// plausible prose to a model, which then answers confidently from nonsense
// and cites a real page number for it — the worst possible failure.
//
// A dependent vowel sign must follow a consonant. Two in a row, or one
// after a space, cannot occur in correct text. Measured: clean Devanagari
// scores 0.000, corrupted pages 0.08-0.17.
const DEVA_CONSONANT = /[\u0915-\u0939\u0958-\u095F\u0978-\u097F]/;
const DEVA_MATRA = /[\u093E-\u094C\u094E\u0955-\u0957\u0962\u0963]/;
const DEVA_ANY = /[\u0900-\u097F]/;
const DEVA_VIRAMA = '\u094D';
const DEVA_NUKTA = '\u093C';

// Below this share of Devanagari characters the sample is too small to judge.
const DEVA_MIN_CHARS = 200;
const DEVA_BAD_RATIO = 0.02;

function scanIndic(text) {
    const src = text || '';
    let deva = 0, bad = 0;
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (DEVA_ANY.test(ch)) deva++;
        if (DEVA_MATRA.test(ch)) {
            const prev = src[i - 1] || '';
            if (DEVA_MATRA.test(prev)) bad++;
            else if (!(DEVA_CONSONANT.test(prev) || prev === DEVA_NUKTA)) bad++;
        } else if (ch === DEVA_VIRAMA) {
            const next = src[i + 1] || '';
            if (!next || next === ' ' || next === '\n') bad++;
        }
    }
    const ratio = deva ? bad / deva : 0;
    return {
        deva, bad, ratio,
        garbled: deva >= DEVA_MIN_CHARS && ratio >= DEVA_BAD_RATIO
    };
}


// A second, entirely different corruption: some PDFs embed legacy 8-bit
// Devanagari fonts (Kruti Dev, Chanakya, Shusha) where the bytes ARE Latin
// and only the font makes them look like Hindi. Extracted, क्षितिज भाग-1 reads
// "dkO; [kaM ... & rqylhnkl" — that is "काव्य खंड ... तुलसीदास".
//
// scanIndic() scored these 0.000 and passed them: it counts faults per
// Devanagari character, and there are no Devanagari characters at all. They
// shipped as `ready` and the model answered from them, inventing authors.
// 1,149 chapters were affected, 925 of them Hindi.
const LATIN_LETTER = /[A-Za-z]/g;
const INDIC_LETTER = /[\u0900-\u0DFF]/g;
// Mediums whose text must not be predominantly Latin. Urdu is excluded: it
// is Arabic script, and English obviously.
const INDIC_SCRIPT_MEDIUM = new Set([
    'Hindi', 'Sanskrit', 'Marathi', 'Nepali', 'Dogri', 'Maithili', 'Konkani',
    'Bodo', 'Sindhi', 'Santhali', 'Santali', 'Kashmiri', 'Manipuri', 'Bengali',
    'Assamese', 'Punjabi', 'Gujarati', 'Tamil', 'Telugu', 'Kannada',
    'Malayalam', 'Oriya', 'Odia'
]);
const LEGACY_MIN_LETTERS = 300;
const LEGACY_LATIN_SHARE = 0.8;

function looksLegacyEncoded(text, medium) {
    if (!medium || !INDIC_SCRIPT_MEDIUM.has(medium)) return false;
    const src = text || '';
    const latin = (src.match(LATIN_LETTER) || []).length;
    if (latin < LEGACY_MIN_LETTERS) return false;
    const indic = (src.match(INDIC_LETTER) || []).length;
    return latin / (latin + indic) >= LEGACY_LATIN_SHARE;
}

function gradeChapter(pages, medium) {
    const list = pages || [];
    const readablePages = list.filter(p => (p.text || '').length >= READABLE_PAGE_CHARS).length;
    const chars = list.reduce((n, p) => n + (p.text || '').length, 0);
    const ratio = list.length ? readablePages / list.length : 0;

    // Text that extracted but is structurally corrupt must never be taught
    // from, however much of it there is.
    const joined = list.map(p => p.text || '').join(' ');
    const indic = scanIndic(joined);

    let status;
    if (indic.garbled || looksLegacyEncoded(joined, medium)) status = 'garbled';
    else if (!list.length || (ratio < PARTIAL_PAGE_RATIO && chars < PARTIAL_MIN_CHARS)) status = 'unavailable';
    else if (ratio >= READY_PAGE_RATIO && chars >= READY_MIN_CHARS) status = 'ready';
    else if (ratio >= COMPLETE_PAGE_RATIO && chars / list.length >= COMPLETE_CHARS_PER_PAGE) status = 'ready';
    else status = 'needs_review';

    return { status, readablePages, chars, pageCount: list.length, indicRatio: Number(indic.ratio.toFixed(4)) };
}

async function extractChapter(chapter) {
    const bytes = await download(chapter.url, {}, 128 * 1024 * 1024);
    if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('Source is not a PDF');
    const { extractText, getDocumentProxy } = require('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    try {
        const { text } = await extractText(pdf, { mergePages: false });
        const pages = text.map((value, i) => ({ page: i + 1, text: value.trim() }));
        const { status, readablePages, chars } = gradeChapter(pages);
        return {
            ...chapter, sha256: hash(bytes), pages, status,
            readablePages, textChars: chars,
            fetchedAt: new Date().toISOString()
        };
    } finally { await pdf.loadingTask.destroy(); }
}

module.exports = { scanIndic, looksLegacyEncoded, NCERT_CHANNEL, safeUrl, hash, list, api, discover, textbookChapters, extractChapter, gradeChapter };
