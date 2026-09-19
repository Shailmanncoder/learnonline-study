// ================================================================
// Deterministic question extraction
// ----------------------------------------------------------------
// Input: pages of positioned lines (pdfLayout.extractPages).
// Output: questions whose numbers, sections, pages and text all come from
// the document. No model is involved; nothing here can invent a number.
//
// NCERT Exemplar books number questions in three different ways, all
// handled by the same rules:
//
//   A  one running sequence, ranges stated in instruction lines
//      (Maths: "In the Questions 1 to 25, …")
//   B  dotted chapter numbering under readable headings
//      (Physics: "MCQ I", then 2.1, 2.2 … 2.26)
//   C  numbering that restarts at 1 in each readable section
//      (Biology: MULTIPLE-CHOICE QUESTIONS 1–18, VERY SHORT ANSWER 1–…)
//
// Rules, each learned from a real unit:
//
//  * A question is accepted only in strict sequence — or as "1" at the start
//    of a readable section. Side boxes restart at "1." after an UNREADABLE
//    heading, so they are never mistaken for a new section.
//  * An out-of-sequence number indented past the question's own number is
//    part of that question (a numbered table); at or left of it, a box.
//  * A number that SKIPS ahead in the question column is recorded as a break:
//    a question was missed, and whatever follows cannot be trusted.
//  * Section names come only from readable headings or instruction lines.
//  * A row of unmapped glyphs in the body is a heading: it ends the current
//    question rather than having the next block appended to it.
//  * Page margins are ignored, so a question crossing a page break continues.
// ================================================================

// "7.1.8 Some important results" is a sub-section number, not question 7.
const PLAIN_START = /^(?:Q(?:uestion)?\s*\.?\s*)?(\d{1,3})\s*(?:\.(?!\d)|\))\s*(.*)$/i;
// "2.13 On the basis of dimensions, …" — requires a space after the number,
// so a wrapped line such as "10.1cm, respectively" is not a question.
const DOTTED_START = /^(\d{1,2})\.(\d{1,3})\s+(\S.*)$/;
// Capitalised only: "example 5 > 3, x ≤ 4" in an overview is running text.
const EXAMPLE_START = /^(?:Example|EXAMPLE)\s+(\d{1,3})\s*[:.]?\s*(.*)$/;
// The wording varies unit to unit — "In each of the following questions 1 to
// 12", "State whether the statements given in question 47 to 65 are True or
// False" — so the reliable signal is a question RANGE inside a line that is
// not itself a numbered question.
// "In each of the questions, 1 to 24, write…" (Class 8 Maths Unit 3) puts a comma
// before the range.
const INSTRUCTION = /\bquestions?[\s,:]+(?:nos?\.?\s*)?(\d{1,3})\s*(?:to|-|–|and)\s*(\d{1,3})\b[,.]?\s*(.*)$/i;
const NUMBERED_LINE = /^\(?\d{1,3}\s*[.)]/;
const SOLUTION = /^Solution\b/i;
const STOP_SECTION = /^\(?\s*(Puzzles?|Crossword|Answers?|Activities|Project)\s*\)?\s*(\d+)?\s*$/i;

// Readable section headings. Short lines only, so a question that merely
// mentions "short answer" is never taken for one.
const HEADING = /^(?:[IVX]{1,4}\s*[.)]\s*|[A-F]\s*[.)]\s*|\([A-F]\)\s*)?(multiple[\s-]*choice(?:\s+type)?|mcq\s*[IVX]*|very[\s-]*short[\s-]*answer(?:\s+type)?|short[\s-]*answer(?:\s+type)?|long[\s-]*answer(?:\s+type)?|matching(?:\s+type)?|match\s+the\s+following|fill\s+in\s+the\s+blanks?|true\s*(?:or|\/|and)\s*false|assertion\s*(?:and|&|[-–])\s*reason(?:\s+type)?|vsa|sa|la|higher\s+order\s+thinking(?:\s+skills)?|hots)(?:\s*questions?)?(?:\s+with\s+reasoning)?(?:\s*\((?:type[\s-]*[IVX0-9]+|[IVX]+)\))?\s*[:.]?$/i;
const HEADING_MAX_CHARS = 70;
// Class 9 and 10 Maths number exercises "EXERCISE 1.1", "EXERCISE 1.2", each
// restarting at 1 under a type heading such as "(C) Short Answer Questions with
// Reasoning". The exercise number is what a student looks the question up by.
// Class 11 and 12 Maths number the parts of a chapter "2.1 Overview",
// "2.2 Solved Examples", "2.3 EXERCISE". Those are book sections, not dotted
// question numbers: read as "2.1 …" they switched the whole chapter to dotted
// numbering and every real "1.", "2.", "3." question was ignored.
const BOOK_SECTION = /^(?:overview|introduction|summary|solved\s+ex(?:am|ma)ples?|exercises?|points\s+to\s+remember|main\s+concepts(?:\s+and\s+results)?|answers?|hints?(?:\s+and\s+solutions?)?)\s*[:.]?$/i;
const OVERVIEW_SECTION = /^\d{1,2}\.\d{1,2}\s+(?:overview|introduction|main\s+concepts(?:\s+and\s+results)?)\s*[:.]?$/i;
// "5.2 Solved Exmaples" is how Class 11 Complex Numbers prints it.
const SOLVED_EXAMPLES_SECTION = /^(?:\d{1,2}\.\d{1,2}\s+)?solved\s+ex(?:am|ma)ples?\s*[:.]?$/i;
const NUMBERED_EXERCISE_SECTION = /^\d{1,2}\.\d{1,2}\s+exercises?\s*[:.]?$/i;
const EXERCISE_HEADING = /^exercise\s+(\d{1,2}(?:\.\d{1,2})?)\s*[:.]?$/i;
// An answer-key entry: a number followed only by option labels or True/False
// ("1. (ii)", "4. (a), (c)", "12. True"). Chemistry chapters end with a key set
// in columns that the parser otherwise reads as questions 1–43.
const ANSWER_KEY_ENTRY = /^(?:\(?\s*(?:[ivx]{1,4}|[a-e])\s*\)?(?:\s*(?:,|and|&|or)?\s*\(?\s*(?:[ivx]{1,4}|[a-e])\s*\)?)*|true|false|t|f|yes|no)\s*[.;]?$/i;

const INDENTED_LIST_GAP = 15;     // points right of the question number
const OUTDENT_TOLERANCE = 6;      // points left of the question number
const COLUMN_TOLERANCE = 12;      // same question column, relative to the page edge

function classifyInstruction(text) {
    const t = String(text || '').toLowerCase();
    if (/four options|correct (option|one|answer)|multiple choice/.test(t)) return 'Multiple Choice Questions';
    if (/fill in the (blank|box)/.test(t)) return 'Fill in the Blanks';
    if (/true or false|\(t\)|true \(t\)/.test(t)) return 'True or False';
    if (/match/.test(t)) return 'Matching';
    if (/very short answer/.test(t)) return 'Very Short Answer Questions';
    if (/short answer/.test(t)) return 'Short Answer Questions';
    if (/long answer/.test(t)) return 'Long Answer Questions';
    return null;   // a range we can see but cannot name is left unnamed
}

// Canonical section name from a heading, keeping any (Type-II) qualifier.
function headingName(text) {
    const t = String(text || '').replace(/^(?:[IVX]{1,4}|[A-F])\s*[.)]\s*|^\([A-F]\)\s*/i, '').trim();
    const type = (t.match(/\((type[\s-]*[IVX0-9]+|[IVX]+)\)/i) || [])[1];
    const low = t.toLowerCase();
    const mcq = low.match(/^mcq\s*([ivx]+)?/);
    let base;
    if (mcq) base = `Multiple Choice Questions${mcq[1] ? ' ' + mcq[1].toUpperCase() : ''}`;
    else if (/multiple/.test(low)) base = 'Multiple Choice Questions';
    else if (/very/.test(low) || low === 'vsa') base = 'Very Short Answer Questions';
    else if (/short/.test(low) && /reasoning/.test(low)) base = 'Short Answer Questions with Reasoning';
    else if (/short/.test(low) || low === 'sa') base = 'Short Answer Questions';
    else if (/long/.test(low) || low === 'la') base = 'Long Answer Questions';
    else if (/match/.test(low)) base = 'Matching';
    else if (/fill/.test(low)) base = 'Fill in the Blanks';
    else if (/true/.test(low)) base = 'True or False';
    else if (/assertion/.test(low)) base = 'Assertion and Reason';
    else base = 'Higher Order Thinking Skills';
    return type ? `${base} (${type.replace(/\s+/g, '-').replace(/^type/i, 'Type')})` : base;
}

// Left content edge of a page, used to compare positions across pages
// (odd and even pages have different margins).
function contentEdge(page) {
    const xs = page.lines.filter(l => !l.blank && !l.margin && l.text.length >= 3).map(l => l.x).sort((a, b) => a - b);
    return xs.length ? xs[0] : null;
}

function joinQuestionLines(lines) {
    // Options and sub-parts start their own line; wrapped prose is rejoined.
    const out = [];
    for (const l of lines) {
        const t = l.trim();
        if (!t) continue;
        if (!out.length || /^\([a-z0-9ivx]+\)/i.test(t) || /^[ivx]{1,4}\.\s/i.test(t)) out.push(t);
        else out[out.length - 1] += ' ' + t;
    }
    return out.join('\n').replace(/[ \t]+/g, ' ').trim();
}

function parseQuestions(pages) {
    const results = [];
    const ranges = [];
    const headings = [];
    const breaks = [];
    let mode = 'preamble';          // preamble | examples | exercise | stopped
    let current = null;
    let last = 0;                   // last accepted exercise number in the running sequence
    let lastExample = 0;
    let section = null;
    let typeHeading = null;         // last readable question-type heading
    let inSolvedSection = false;    // inside a "2.2 Solved Examples" book section
    let inOverview = false;         // inside a "2.1 Overview" book section
    let sectionStart = false;       // a readable heading was just seen: "1" may restart
    let restarts = 0;
    let dottedPrefix = null;
    let skipping = false;           // inside a side box / after a heading
    let previousEdge = null;
    let questionColumn = null;      // relative x of accepted question numbers
    let order = 0;

    const close = () => {
        if (!current) return;
        const text = joinQuestionLines(current.lines);
        if (text) {
            results.push({
                kind: current.kind,
                questionNumber: current.label,
                section: current.section,
                questionText: text,
                startPdfPage: current.startPage,
                endPdfPage: current.endPage,
                bbox: current.bbox,
                orderIndex: current.orderIndex,
                sequenceConsistent: current.sequenceConsistent
            });
        }
        current = null;
    };

    const extendBox = (page, line) => {
        const b = current.bbox;
        if (!b.start) b.start = { page: page.pdfPageIndex, top: line.y + line.h, bottom: line.y, left: line.x, right: line.right, pageHeight: page.height, pageWidth: page.width };
        if (page.pdfPageIndex === b.start.page) {
            b.start.bottom = Math.min(b.start.bottom, line.y);
            b.start.left = Math.min(b.start.left, line.x);
            b.start.right = Math.max(b.start.right, line.right);
        } else {
            if (!b.end || b.end.page !== page.pdfPageIndex) {
                b.end = { page: page.pdfPageIndex, top: line.y + line.h, bottom: line.y, left: line.x, right: line.right, pageHeight: page.height, pageWidth: page.width };
            }
            b.end.bottom = Math.min(b.end.bottom, line.y);
            b.end.left = Math.min(b.end.left, line.x);
            b.end.right = Math.max(b.end.right, line.right);
        }
    };

    // Read a question number from a line: dotted "2.13 …" or plain "13. …".
    const readNumber = (text) => {
        const d = text.match(DOTTED_START);
        if (d && BOOK_SECTION.test(d[3].trim())) return null;
        if (d && (dottedPrefix === null ? Number(d[2]) === 1 && last === 0 : Number(d[1]) === dottedPrefix)) {
            return { n: Number(d[2]), prefix: Number(d[1]), rest: d[3] };
        }
        if (dottedPrefix !== null) return null;       // this document numbers questions as "2.x"
        const p = text.match(PLAIN_START);
        return p ? { n: Number(p[1]), prefix: null, rest: p[2] } : null;
    };

    for (const page of pages) {
        const edge = contentEdge(page);
        // Rows holding two or more answer-like entries side by side: an answer
        // key set in columns. A single "107. (a) (b)" is a question whose
        // fractions did not extract, not an answer key.
        const answerRows = new Set();
        const byRow = new Map();
        for (const l of page.lines) {
            const m = !l.margin && !l.blank && l.text.match(PLAIN_START);
            if (m && ANSWER_KEY_ENTRY.test(String(m[2] || '').trim())) {
                const key = Math.round(l.y);
                byRow.set(key, (byRow.get(key) || 0) + 1);
            }
        }
        for (const [y, count] of byRow) if (count >= 2) answerRows.add(y);
        if (current && previousEdge !== null && edge !== null) current.numberX += edge - previousEdge;
        if (edge !== null) previousEdge = edge;
        const rel = (x) => x - (edge ?? 0);

        for (const line of page.lines) {
            if (mode === 'stopped') break;
            // A question can start in the margin band above a large figure, too far
            // from the body to be reclaimed by line spacing (Class 10 Science,
            // Carbon Q5). Only the exact next number, followed by words, counts.
            if (line.margin) {
                const m = mode === 'exercise' && last > 0 && !line.blank && line.text.match(PLAIN_START);
                if (!(m && Number(m[1]) === last + 1 && /[A-Za-z]{3,}/.test(m[2] || ''))) continue;
            }

            // A heading drawn in an unmapped font: ends whatever came before.
            if (line.blank) {
                if (current) close();
                skipping = mode === 'exercise';
                continue;
            }
            const text = line.text;

            if (STOP_SECTION.test(text) && mode !== 'preamble') { close(); mode = 'stopped'; break; }

            // Numbered notes in a chapter overview ("1. Use permutations if…") are
            // not the start of the exercise.
            if (OVERVIEW_SECTION.test(text)) { close(); inOverview = true; continue; }
            if (SOLVED_EXAMPLES_SECTION.test(text)) { close(); mode = 'examples'; inSolvedSection = true; inOverview = false; continue; }
            if (NUMBERED_EXERCISE_SECTION.test(text)) {
                close();
                mode = 'exercise';
                inSolvedSection = false;
                inOverview = false;
                section = null;
                typeHeading = null;
                skipping = false;
                continue;
            }

            if (text.length <= HEADING_MAX_CHARS && HEADING.test(text)) {
                close();
                // Solved examples grouped under "Short Answer Type" use the same
                // headings the exercise uses later; they are not a second section.
                if (inSolvedSection && mode === 'examples') continue;
                const name = headingName(text);
                // A chapter has each section once. The same heading again marks
                // an answers or hints block that reuses the question headings.
                if (headings.some(h => h.name === name)) { mode = 'stopped'; break; }
                mode = 'exercise';
                section = name;
                typeHeading = name;
                headings.push({ name: section, page: page.pdfPageIndex });
                sectionStart = true;
                skipping = false;
                continue;
            }

            const exh = text.match(EXERCISE_HEADING);
            if (exh) {
                close();
                const name = `Exercise ${exh[1]}`;
                if (headings.some(h => h.name === name)) { mode = 'stopped'; break; }
                mode = 'exercise';
                section = typeHeading ? `${name} · ${typeHeading}` : name;
                headings.push({ name, page: page.pdfPageIndex });
                sectionStart = true;
                skipping = false;
                continue;
            }

            // Only a line that is not itself a numbered question, and only while
            // the range reads forwards, is an instruction.
            const instr = !NUMBERED_LINE.test(text) && !DOTTED_START.test(text) && text.match(INSTRUCTION);
            if (instr && Number(instr[2]) >= Number(instr[1])) {
                close();
                mode = 'exercise';
                skipping = false;
                // An instruction names ONLY the range it states. Carrying its name
                // forward labelled Q26–30 of the Integers unit as "Multiple Choice"
                // although no line of the document says so; those are assigned by
                // range after parsing instead, and stay unnamed outside any range.
                ranges.push({ from: Number(instr[1]), to: Number(instr[2]), section: classifyInstruction(text), page: page.pdfPageIndex });
                section = null;
                continue;
            }

            const ex = text.match(EXAMPLE_START);
            if (ex && mode !== 'exercise') {
                const n = Number(ex[1]);
                close();
                mode = 'examples';
                current = {
                    kind: 'example', number: n, label: String(n), section: 'Solved Examples', lines: ex[2] ? [ex[2]] : [],
                    startPage: page.pdfPageIndex, endPage: page.pdfPageIndex, numberX: line.x, bbox: {},
                    orderIndex: n, sequenceConsistent: n === lastExample + 1
                };
                lastExample = n;
                extendBox(page, line);
                continue;
            }
            if (mode === 'examples' && SOLUTION.test(text)) { close(); continue; }

            // A book that opens straight into its questions under an unreadable
            // heading (Class 10 Science): "1." before any examples starts them.
            const num = readNumber(text);
            if (mode === 'preamble' && !inOverview && lastExample === 0 && num && num.n === 1) mode = 'exercise';

            if (mode === 'exercise' && num) {
                const { n, prefix, rest } = num;
                // Answers, not questions: stop before the key becomes "questions".
                if (answerRows.has(Math.round(line.y))) { close(); mode = 'stopped'; break; }
                const continues = n === last + 1;
                const restartsSection = n === 1 && last > 0 && sectionStart;
                // A number that skips ahead in the question column means a question
                // was missed. Record the break ONCE, then carry on from the new
                // number: everything from here is untrusted, but still extracted
                // for a human to review — rejecting it lost 73 real questions of
                // the Algebraic Expressions unit after one unreadable "28.".
                // Straight after a heading, a bare "13 ." with no text is part of a
                // worked sample answer (Class 9 Maths Number Systems), not a question.
                const bareAfterHeading = sectionStart && !/[A-Za-z]{2,}/.test(String(rest || ''));
                const skipsAhead = !continues && !restartsSection && !bareAfterHeading && n > last + 1 && last > 0 &&
                    questionColumn !== null && Math.abs(rel(line.x) - questionColumn) <= COLUMN_TOLERANCE &&
                    !(current && line.x > current.numberX + INDENTED_LIST_GAP);
                if (skipsAhead) {
                    breaks.push({ expected: last + 1, found: n, page: page.pdfPageIndex, atOrder: order, section });
                }
                if (continues || restartsSection || skipsAhead) {
                    close();
                    if (restartsSection) restarts++;
                    if (prefix !== null) dottedPrefix = prefix;
                    skipping = false;
                    sectionStart = false;
                    questionColumn = rel(line.x);
                    current = {
                        kind: 'exercise', number: n, label: prefix !== null ? `${prefix}.${n}` : String(n),
                        section, lines: rest ? [rest] : [],
                        startPage: page.pdfPageIndex, endPage: page.pdfPageIndex,
                        numberX: line.x, bbox: {}, orderIndex: order++, sequenceConsistent: !skipsAhead
                    };
                    last = n;
                    extendBox(page, line);
                    continue;
                }
                // Out of sequence: an indented list inside the question…
                if (current && line.x > current.numberX + INDENTED_LIST_GAP) {
                    current.lines.push(text);
                    current.endPage = page.pdfPageIndex;
                    extendBox(page, line);
                    continue;
                }
                // …or a side box.
                close();
                skipping = true;
                continue;
            }

            if (skipping || !current) continue;

            // Text left of the question number belongs to something else.
            if (mode === 'exercise' && line.x < current.numberX - OUTDENT_TOLERANCE) {
                close();
                skipping = true;
                continue;
            }
            current.lines.push(text);
            current.endPage = page.pdfPageIndex;
            extendBox(page, line);
        }
    }
    close();

    // Instruction ranges name sections where no readable heading did.
    for (const r of results) {
        if (r.kind !== 'exercise' || r.section) continue;
        const n = Number(r.questionNumber);
        const range = ranges.find(g => n >= g.from && n <= g.to);
        r.section = range ? range.section : null;
    }
    const scheme = dottedPrefix !== null ? 'dotted' : (restarts > 0 ? 'per_section' : 'running');
    return {
        questions: results,
        sections: ranges,
        headings,
        scheme,
        integrity: checkIntegrity(results, ranges, { breaks, scheme })
    };
}

// Does what was extracted agree with what the document says about itself?
// A lost sequence can attach real question numbers to the wrong text (the
// Triangles unit's "Question 1" was a table fragment), so trust ends at the
// first sign of one:
//   * a stated range ("In questions 50 to 69") not fully extracted,
//   * numbering that begins somewhere other than 1,
//   * a number that skipped ahead in the question column while parsing.
//
// Trust is measured in EXTRACTION ORDER, which works for every numbering
// scheme — including sections that restart at 1. Exercise questions and
// solved examples are judged separately, and the question just before a
// break is not trusted either: a missed "24." leaves question 24's text
// appended to question 23.
function checkIntegrity(results, ranges, { breaks = [] } = {}) {
    const problems = [];
    const exercise = results.filter(r => r.kind === 'exercise')
        .map((r, i) => ({ ...r, orderIndex: Number.isInteger(r.orderIndex) ? r.orderIndex : i }));
    let breakOrder = Infinity;

    for (const b of breaks) {
        problems.push(`question ${b.expected}${b.section ? ` in ${b.section}` : ''} was not found — numbering jumped to ${b.found} on PDF page ${b.page}`);
        breakOrder = Math.min(breakOrder, b.atOrder);
    }

    if (ranges.length) {
        const numbers = new Map(exercise.map(r => [Number(r.questionNumber), r.orderIndex]));
        const firstRange = Math.min(...ranges.map(g => g.from));
        // Questions before the first stated range are vouched for only when a
        // readable section heading introduced them and 1…(from−1) came out in
        // order (Class 11 Chemistry opens "I. Multiple Choice Questions (Type-I)"
        // and states no range until question 14). Otherwise nothing is trusted:
        // the Triangles unit's only "question 1" was a stray "1." in a table.
        const opening = exercise.filter(r => Number(r.questionNumber) < firstRange);
        const headedOpening = opening.length === firstRange - 1 &&
            opening.every((r, i) => Number(r.questionNumber) === i + 1 && r.section && r.orderIndex === i);
        if (firstRange !== 1 && !headedOpening) {
            problems.push(`the first stated question range starts at ${firstRange}, not 1`);
            breakOrder = 0;
        }
        let firstMissing = Infinity;
        for (const g of ranges) {
            const missing = [];
            for (let n = g.from; n <= g.to; n++) if (!numbers.has(n)) missing.push(n);
            if (missing.length) {
                problems.push(`instruction on PDF page ${g.page} states questions ${g.from}–${g.to}, but ${missing.length} of them were not extracted (e.g. ${missing.slice(0, 5).join(', ')})`);
                firstMissing = Math.min(firstMissing, missing[0]);
            }
        }
        // Place the break at the SMALLEST missing number across every range.
        // Looking up the question before each range's own first gap failed when
        // that question was itself missing ("33–52" when 28 was the real gap),
        // and fell back to trusting nothing at all.
        if (firstMissing !== Infinity) {
            const before = numbers.get(firstMissing - 1);
            breakOrder = Math.min(breakOrder, before === undefined ? 0 : before + 1);
        }
        const statedMax = Math.max(...ranges.map(g => g.to));
        const extractedMax = numbers.size ? Math.max(...numbers.keys()) : 0;
        if (extractedMax < statedMax) {
            problems.push(`the document states questions up to ${statedMax}, but extraction stopped at ${extractedMax}`);
            breakOrder = Math.min(breakOrder, exercise.length);
        }
    }

    const exampleNums = results.filter(r => r.kind === 'example').map(r => Number(r.questionNumber));
    let exampleBreak = Infinity;
    exampleNums.forEach((n, i) => {
        if (n !== i + 1 && exampleBreak === Infinity) {
            problems.push(`solved example ${i + 1} is missing or out of order (found ${n})`);
            exampleBreak = i + 1;
        }
    });

    const trustedBelow = (brk) => (brk === Infinity ? Infinity : Math.max(0, brk - 1));
    return {
        ok: problems.length === 0,
        problems,
        exerciseTrustedBelow: trustedBelow(breakOrder),   // extraction-order index
        exampleTrustedBelow: trustedBelow(exampleBreak)   // example number
    };
}

// Is this question inside the trusted part of its document?
function numberTrusted(question, integrity) {
    if (question.kind === 'example') {
        const n = Number(question.questionNumber);
        return Number.isFinite(n) && n < integrity.exampleTrustedBelow;
    }
    const at = Number.isInteger(question.orderIndex) ? question.orderIndex : Number(question.questionNumber) - 1;
    return Number.isFinite(at) && at < integrity.exerciseTrustedBelow;
}

// Normalise text for "does this question really appear on that page".
function normaliseForMatch(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[–—−]/g, '-')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

module.exports = {
    parseQuestions, checkIntegrity, numberTrusted, classifyInstruction, headingName,
    normaliseForMatch, joinQuestionLines, PLAIN_START, DOTTED_START, INSTRUCTION, HEADING
};
