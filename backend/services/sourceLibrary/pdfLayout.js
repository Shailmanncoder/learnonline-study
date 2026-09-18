// ================================================================
// PDF layout extraction — page by page, with coordinates
// ----------------------------------------------------------------
// Never flattens a document: every line keeps its PDF page index and
// its position on that page, so a question can later be traced to
// exactly where it was printed.
//
// Printed page numbers are NOT taken from the text layer on faith.
// In the NCERT Exemplar PDFs the footer page number is drawn in a font
// with no Unicode map — it extracts as empty strings — while bare
// numbers such as "8" and "9" sit inside tables near the margin on PDF
// pages 18 and 21. A text-layer detector would have stamped "printed
// page 8" onto PDF page 18. Printed pages therefore come from OCR of
// the footer band, and are kept only for pages whose reading agrees
// with the page offset the rest of the document shows.
// ================================================================

// Rows of text items within this many PDF points share a line.
const LINE_TOLERANCE = 3;
// A later item this far right of the previous one, starting with "24.", is a
// second question on the same row (two-column exercises).
const COLUMN_GAP = 30;
const NUMBER_TOKEN = /^\d{1,3}\.(?:\s|$)/;

function median(values) {
    if (!values.length) return 10;
    const v = [...values].sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
}

// Group positioned text items into lines, keeping maths notation.
//
// Superscripts are separate, smaller items drawn a few points ABOVE the
// baseline. Grouped by exact height they became a line of their own and the
// exponents vanished: Exemplar Class 7 Exponents Q23, (–2)^31 × (–2)^13, was
// stored as "(–2) × (–2) = (–2)", which is simply false. They are attached to
// the row they belong to and written with a caret. Subscripts (below the
// baseline, as in H2O) are appended directly.
function groupLines(items, pageHeight) {
    const all = items.map((it) => ({
        str: unshiftGlyphs(String(it.str || '')),
        x: it.transform[4],
        y: it.transform[5],
        w: it.width || 0,
        h: Math.abs(it.transform[3]) || it.height || 10
    }));
    const body = median(all.filter(p => p.str.trim()).map(p => p.h));
    const small = (p) => p.str.trim() && p.h < body * 0.8;

    const rows = [];
    for (const p of all.filter(p => !small(p))) {
        let row = rows.find(r => Math.abs(r.y - p.y) <= LINE_TOLERANCE);
        if (!row) { row = { y: p.y, parts: [] }; rows.push(row); }
        row.parts.push({ ...p, role: 'text' });
    }
    // A superscript or subscript is SHORT and sits right against the character
    // before it. Without both conditions, option text set in a smaller font
    // (Class 11 Chemistry) was glued onto the line above as an "exponent":
    // "(ii)^Results of both the students…".
    // "Right against" allows the exponent to overlap its base a little, as
    // printed exponents often do, but not to float far to its right.
    const attachedTo = (p, r) => r.parts.some(q => q.str.trim() && p.x > q.x && p.x - (q.x + q.w) <= 6);
    for (const p of all.filter(small)) {
        const script = p.str.trim().length <= 4;
        const above = script && rows.filter(r => p.y - r.y >= 1.5 && p.y - r.y <= body * 0.75 && attachedTo(p, r))
            .sort((a, b) => (p.y - a.y) - (p.y - b.y))[0];
        const below = script && rows.filter(r => r.y - p.y >= 1.5 && r.y - p.y <= body * 0.5 && attachedTo(p, r))
            .sort((a, b) => (a.y - p.y) - (b.y - p.y))[0];
        if (above) above.parts.push({ ...p, role: 'sup' });
        else if (below) below.parts.push({ ...p, role: 'sub' });
        else {
            let row = rows.find(r => Math.abs(r.y - p.y) <= LINE_TOLERANCE);
            if (!row) { row = { y: p.y, parts: [] }; rows.push(row); }
            row.parts.push({ ...p, role: 'text' });
        }
    }

    const lines = [];
    for (const r of rows.sort((a, b) => b.y - a.y)) {
        r.parts.sort((a, b) => a.x - b.x);
        // Split a row where a second question starts after a wide gap.
        const segments = [[]];
        let prevRight = null;
        for (const part of r.parts) {
            const seg = segments[segments.length - 1];
            const hasVisible = seg.some(q => q.str.trim());
            if (part.role === 'text' && hasVisible && NUMBER_TOKEN.test(part.str.trim() + ' ') &&
                prevRight !== null && part.x - prevRight >= COLUMN_GAP) {
                segments.push([part]);
            } else {
                seg.push(part);
            }
            if (part.str.trim()) prevRight = part.x + part.w;
        }
        for (const seg of segments) {
            let text = '';
            let supOpen = false;
            for (const part of seg) {
                const t = part.str;
                if (part.role === 'sup' && t.trim()) {
                    text = text.replace(/\s+$/, '') + (supOpen ? '' : '^') + t.trim();
                    supOpen = true;
                    continue;
                }
                if (part.role === 'sub' && t.trim()) { text = text.replace(/\s+$/, '') + t.trim(); supOpen = false; continue; }
                if (t.trim()) supOpen = false;
                text += (supOpen || !text || /\s$/.test(text) ? '' : ' ') + t;
            }
            text = text.replace(/\s+/g, ' ').trim();
            const visible = seg.filter(q => q.str.trim());
            const x = visible.length ? visible[0].x : seg[0].x;
            const right = seg.reduce((m, q) => Math.max(m, q.x + q.w), 0);
            const h = seg.reduce((m, q) => Math.max(m, q.h), 0);
            lines.push({
                text,
                x: Math.round(x * 10) / 10,
                y: Math.round(r.y * 10) / 10,
                right: Math.round(right * 10) / 10,
                h: Math.round(h * 10) / 10,
                hasSuperscript: seg.some(q => q.role === 'sup' && q.str.trim()),
                // A row made only of unmapped glyphs: a heading or running head
                // drawn in a font with no Unicode map. Its position still counts.
                blank: isUnreadableHeading(text),
                margin: r.y > pageHeight - 90 || r.y < 85
            });
        }
    }
    return reclaimBodyInMargins(lines, pageHeight);
}

// Some Class 10 Science chapters embed a font whose character codes are all
// shifted down by 29: "$W\u0003QRRQ" is "At noon", with U+0003 as the space.
// Plain text never contains those control characters, so an item that does is
// decoded by adding the shift back. The same rule applies to the whole item,
// so what is decoded is exactly what the printed page shows.
const GLYPH_SHIFT = 29;
function unshiftGlyphs(str) {
    if (!/[\u0003-\u001f]/.test(str)) return str;
    const decoded = [...str].map((c) => {
        const cp = c.codePointAt(0);
        if (c === ' ' || cp < 0x03 || cp + GLYPH_SHIFT > 0x7e) return c;
        return String.fromCharCode(cp + GLYPH_SHIFT);
    }).join('');
    return decoded;
}

// Symbol fonts put box titles in the Private Use Area: "Magic Squares" in
// Class 8 Maths Unit 3 came through as U+F04D U+F061… (letters shifted by
// 0xF000), and was glued onto Q3 with the whole box under it. The same range
// also carries big brackets and fraction bars INSIDE questions, so a
// private-use line is a heading only when it decodes to a word.
function isUnreadableHeading(text) {
    if (!text) return true;
    if (text.replace(/[\s\uE000-\uF8FF]/g, '')) return false;
    const decoded = [...text].map((c) => {
        const cp = c.codePointAt(0);
        return cp >= 0xF020 && cp <= 0xF07E ? String.fromCharCode(cp - 0xF000) : ' ';
    }).join('');
    return /[A-Za-z]{3,}/.test(decoded);
}

// Footers and running heads live in the top and bottom bands, but a question
// can be printed there too: Class 6 Maths Unit 1 set Q65 at y=78, so treating
// the whole band as margin dropped it and broke the numbering of everything
// after it. A band line is body text only when it reads like a sentence (not
// a page number, date, spaced-caps running head or copyright notice) AND it
// sits at the body's own line spacing from the nearest body line. Footers are
// set apart by a wider gap, so they stay in the margin.
const FOOTER_TEXT = /republish|©|copyright|reprint|^\s*\d{4}\s*[-–]\s*\d{2,4}\s*$|exemplar\s*problems|^\d{1,4}$|\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b|^(?:unit|chapter)\s+\d+/i;
function readsLikeBody(text) {
    if (!text || FOOTER_TEXT.test(text) || /(?:\b[A-Z]\s){2,}/.test(text)) return false;
    // A numbered question or option label counts even when the rest is pure
    // notation: "58. 1 + 2 + 3 _______ (–1) + (–2) + (–3)".
    if (/^(?:\d{1,3}[.)]|\((?:[a-h]|[ivx]{1,4})\))\s+\S/i.test(text)) return true;
    return (text.match(/\b[a-z]{2,}\b/g) || []).length >= 2;
}
function reclaimBodyInMargins(lines, pageHeight) {
    const body = lines.filter(l => !l.margin && !l.blank).sort((a, b) => b.y - a.y);
    if (body.length < 3) return lines;
    const gaps = [];
    for (let i = 1; i < body.length; i++) {
        const g = body[i - 1].y - body[i].y;
        if (g > 2) gaps.push(g);
    }
    if (!gaps.length) return lines;
    const limit = median(gaps) * 1.3;
    const lowest = body[body.length - 1].y;
    const highest = body[0].y;
    // Walk outward from the body, gathering the lines that keep the body's line
    // spacing, and reclaim them as a block when the block reads like body text.
    // Line by line, a wrapped question at the top of a page (Class 11 Chemistry:
    // "4. The interaction energy … / of the distance … / upon") stopped at its
    // one-word last line and the whole question was lost.
    const reclaim = (band, startEdge, gap) => {
        const block = [];
        let edge = startEdge;
        for (const l of band) {
            if (l.blank) continue;
            if (gap(edge, l) > limit || FOOTER_TEXT.test(l.text) || /(?:\b[A-Z]\s){2,}/.test(l.text)) break;
            block.push(l); edge = l.y;
        }
        if (block.some(l => readsLikeBody(l.text))) block.forEach((l) => { l.margin = false; });
    };
    reclaim(lines.filter(l => l.margin && l.y < lowest).sort((a, b) => b.y - a.y), lowest, (e, l) => e - l.y);
    reclaim(lines.filter(l => l.margin && l.y > highest && l.y < pageHeight).sort((a, b) => a.y - b.y), highest, (e, l) => l.y - e);
    return lines;
}

async function extractPages(buffer) {
    const { getDocumentProxy } = await import('unpdf');
    const doc = await getDocumentProxy(new Uint8Array(buffer));
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const vp = page.getViewport({ scale: 1 });
        const tc = await page.getTextContent();
        const lines = groupLines(tc.items, vp.height);
        pages.push({
            pdfPageIndex: i,
            width: Math.round(vp.width),
            height: Math.round(vp.height),
            lines,
            rawText: lines.filter(l => !l.blank).map(l => l.text).join('\n')
        });
    }
    markRunningHeads(pages);
    return pages;
}

// Running heads outside the fixed margin band. Class 9 Maths pages are 720pt
// tall and carry "NUMBER SYSTEMS 5" at y=623, below the band, so it was glued
// onto question 16. A line near the top or bottom that is a page number beside
// head text recurring on other pages is a running head wherever it sits.
function markRunningHeads(pages) {
    const heads = readRunningHeads(pages.map(p => ({
        pdfPageIndex: p.pdfPageIndex,
        lines: p.lines.map(l => ({ ...l, margin: !l.blank && (l.y > p.height * 0.8 || l.y < p.height * 0.2) }))
    })));
    pages.forEach((p, i) => {
        if (heads[i].value === null) return;
        for (const l of p.lines) {
            if (l.text.replace(/\s+/g, ' ').trim() === heads[i].ocr && (l.y > p.height * 0.8 || l.y < p.height * 0.2)) l.margin = true;
        }
    });
}

// ── Printed page detection ───────────────────────────────────────────
// Reads digits from a footer/header OCR string. Only a number standing next
// to a running head ("EXEMPLAR PROBLEMS", the chapter name) or alone in the
// band is accepted; anything else is noise.
// Words that label a number as something other than a page: "UNIT 1" on a
// chapter opener would otherwise read as printed page 1.
const NOT_A_PAGE = /\b(unit|chapter|exercise|example|fig|figure|table|class|question|q|activity|puzzle|part|section|lesson)\s*\d{1,3}\b/i;

function readPageNumber(ocrText) {
    const t = String(ocrText || '').replace(/\s+/g, ' ').trim();
    if (!t || NOT_A_PAGE.test(t)) return null;
    const m = t.match(/^(\d{1,3})\s+[A-Za-z]/) || t.match(/[A-Za-z]\s+(\d{1,3})$/) || t.match(/^(\d{1,3})$/);
    return m ? Number(m[1]) : null;
}

// Given per-page readings, keep only those that agree with the dominant
// offset (printed - pdfIndex). Pages with no reading, or a reading that
// disagrees, stay null: a gap is acceptable, an inferred number is not.
function reconcilePrintedPages(readings, { minAgreement = 0.6, minReadings = 3 } = {}) {
    const usable = readings.filter(r => Number.isInteger(r.value));
    if (usable.length < minReadings) {
        return { offset: null, pages: readings.map(r => ({ ...r, printed: null, evidence: null })) };
    }
    const counts = new Map();
    for (const r of usable) {
        const off = r.value - r.pdfPageIndex;
        counts.set(off, (counts.get(off) || 0) + 1);
    }
    const [offset, votes] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (votes / usable.length < minAgreement) {
        return { offset: null, pages: readings.map(r => ({ ...r, printed: null, evidence: null })) };
    }
    return {
        offset,
        pages: readings.map((r) => {
            const agrees = Number.isInteger(r.value) && r.value - r.pdfPageIndex === offset;
            return {
                ...r,
                printed: agrees ? r.value : null,
                evidence: agrees ? `${r.band === 'running head' ? 'running head text' : 'footer OCR'} "${String(r.ocr).slice(0, 60)}" (offset ${offset}, ${votes}/${usable.length} pages agree)` : null
            };
        })
    };
}

// Running heads from the text layer. Science books print the page number
// white-on-red in the header, which OCR cannot read, but their text layer
// carries it beside the running head ("2 EXEMPLAR PROBLEMS"). Only that
// shape counts: a number attached to running-head text that recurs on other
// pages of the document. A bare "8" in a table, or a sentence that happens to
// end in a number, never qualifies.
function readRunningHeads(pages) {
    const candidates = pages.map((p) => {
        const out = [];
        for (const l of p.lines || []) {
            if (!l.margin || l.blank) continue;
            const t = l.text.replace(/\s+/g, ' ').trim();
            if (t.length < 8 || NOT_A_PAGE.test(t)) continue;
            const m = t.match(/^(\d{1,3})\s+([A-Za-z].*)$/) || t.match(/^(.*[A-Za-z])\s+(\d{1,3})$/);
            if (!m) continue;
            const value = Number(/^\d/.test(m[1]) ? m[1] : m[2]);
            const head = (/^\d/.test(m[1]) ? m[2] : m[1]).toLowerCase().replace(/[^a-z]+/g, '');
            if (head.length >= 5) out.push({ value, head, text: t });
        }
        return out;
    });
    const pagesWithHead = new Map();
    candidates.forEach((list) => new Set(list.map(c => c.head)).forEach(h => pagesWithHead.set(h, (pagesWithHead.get(h) || 0) + 1)));
    return pages.map((p, i) => {
        const hit = candidates[i].find(c => pagesWithHead.get(c.head) >= 2);
        return { pdfPageIndex: p.pdfPageIndex, value: hit ? hit.value : null, ocr: hit ? hit.text : '', band: 'running head' };
    });
}

async function detectPrintedPages(buffer, pageCount, { pageHeight = 821, pages = null } = {}) {
    const fromText = pages ? reconcilePrintedPages(readRunningHeads(pages)) : { offset: null, pages: [] };
    const fromOcr = await readFooterOcr(buffer, pageCount, pageHeight);
    return combinePrintedPages(fromText, fromOcr, pageCount);
}

// Both readers must tell the same story. When each finds a steady offset and
// the offsets differ, one of them is reading something that is not a page
// number, and neither is trusted.
function combinePrintedPages(a, b, pageCount) {
    const empty = () => ({ offset: null, pages: Array.from({ length: pageCount }, (_, i) => ({ pdfPageIndex: i + 1, printed: null, evidence: null })) });
    if (a.offset === null && b.offset === null) return b.pages.length ? b : empty();
    if (a.offset !== null && b.offset !== null && a.offset !== b.offset) return { ...empty(), conflict: [a.offset, b.offset] };
    const offset = a.offset !== null ? a.offset : b.offset;
    const pick = (list, i) => (list.find(p => p.pdfPageIndex === i) || {});
    return {
        offset,
        pages: Array.from({ length: pageCount }, (_, k) => {
            const i = k + 1;
            const pa = a.offset !== null ? pick(a.pages, i) : {};
            const pb = b.offset !== null ? pick(b.pages, i) : {};
            const hit = pa.printed != null ? pa : pb.printed != null ? pb : null;
            return { pdfPageIndex: i, printed: hit ? hit.printed : null, evidence: hit ? hit.evidence : null };
        })
    };
}

async function readFooterOcr(buffer, pageCount, pageHeight) {
    const { renderPageAsImage } = await import('unpdf');
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const { createWorker } = require('tesseract.js');
    const worker = await createWorker('eng');
    const scale = 3;
    const readings = [];
    try {
        for (let i = 1; i <= pageCount; i++) {
            // pdf.js detaches the buffer it is given; each render gets a copy.
            // A page the renderer cannot draw (Class 8 Maths Unit 12: "Make line
            // dash path effect failed") simply has no reading.
            let img;
            try {
                const png = await renderPageAsImage(new Uint8Array(buffer), i, {
                    canvasImport: () => import('@napi-rs/canvas'), scale
                });
                img = await loadImage(Buffer.from(png));
            } catch (err) {
                readings.push({ pdfPageIndex: i, value: null, ocr: '', band: 'footer', error: String(err.message || err).slice(0, 80) });
                continue;
            }
            // Footer band only. NCERT maths books print the page number at the
            // bottom in a font with no Unicode map; the header carries unit and
            // chapter titles, whose numbers are not pages.
            const top = Math.max(0, Math.round((pageHeight - 85) * scale));
            const h = Math.min(img.height - top, Math.round(45 * scale));
            const c = createCanvas(img.width, h);
            c.getContext('2d').drawImage(img, 0, top, img.width, h, 0, 0, img.width, h);
            const { data } = await worker.recognize(c.toBuffer('image/png'));
            const text = String(data.text || '').replace(/\s+/g, ' ').trim();
            readings.push({ pdfPageIndex: i, value: readPageNumber(text), ocr: text, band: 'footer' });
        }
    } finally {
        await worker.terminate().catch(() => {});
    }
    return reconcilePrintedPages(readings);
}

module.exports = { extractPages, groupLines, unshiftGlyphs, detectPrintedPages, reconcilePrintedPages, readPageNumber, readRunningHeads, combinePrintedPages };
