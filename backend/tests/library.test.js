// ================================================================
// Verified Source Library — tests
// The rule under test: a missing citation is acceptable, a fake one never is.
// ================================================================
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCitation, NOT_VERIFIED } = require('../services/sourceLibrary/citation');
const { parseQuestions } = require('../services/sourceLibrary/questionParser');
const { reconcilePrintedPages, readPageNumber } = require('../services/sourceLibrary/pdfLayout');
const { autoVerify, STATUS } = require('../services/sourceLibrary/verify');
const { assertAllowedUrl, parseRobots, robotsAllows } = require('../services/sourceLibrary/fetcher');
const { answerLibraryQuestion, detectIntent, stripFabricatedCitations } = require('../services/sourceLibrary/libraryAnswer');

const OFFICIAL = 'https://ncert.nic.in/pdf/publication/exemplarproblem/classVII/Mathematics/gemp101.pdf';
const record = (over = {}) => ({
    verification_status: STATUS.AUTO_VERIFIED,
    source_url: OFFICIAL,
    official_url: 'https://ncert.nic.in/exemplar-problems.php?ln=en',
    allowed_hosts: 'ncert.nic.in',
    publisher: 'NCERT',
    book_title: 'NCERT Exemplar Problems: Mathematics',
    class_level: '7', subject: 'Mathematics', chapter: 'Integers',
    section: 'Multiple Choice Questions', kind: 'exercise',
    question_number: '14', printed_page: 10, start_pdf_page: 10, end_pdf_page: 10,
    verified_at: '2026-09-18 10:00:00', redistribution_allowed: 0,
    ...over
});

// ── Part 18: the hallucinated-citation tests ─────────────────────────
test('a question that exists gets its real citation, every field from the record', () => {
    const c = buildCitation(record());
    assert.equal(c.verified, true);
    assert.equal(c.title, 'NCERT Exemplar Problems: Mathematics');
    // The section is part of the heading: some books restart numbering per section.
    assert.equal(c.line3, 'Multiple Choice Questions · Question 14 • Printed Page 10');
    assert.equal(c.exactPage.url, `${OFFICIAL}#page=10`);
    const f = Object.fromEntries(c.fields.map(x => [x.label, x.value]));
    assert.equal(f['Question number'], '14');
    assert.equal(f['PDF page'], '10');
    assert.equal(f['Printed page'], '10');
});

test('an unknown printed page is left out, never filled in', () => {
    const c = buildCitation(record({ printed_page: null }));
    assert.equal(c.verified, true);
    assert.equal(c.line3, 'Multiple Choice Questions · Question 14');
    assert.ok(!c.fields.some(x => x.label === 'Printed page'));
    // PDF page is still shown: it is known, and it is a different thing.
    assert.ok(c.fields.some(x => x.label === 'PDF page' && x.value === '10'));
});

test('an unknown question number is left out too', () => {
    const c = buildCitation(record({ question_number: null }));
    assert.equal(c.verified, true);
    assert.ok(!c.fields.some(x => /question/i.test(x.label)));
    assert.equal(c.line3, 'Printed Page 10');
});

test('printed pages are never inferred from neighbouring pages', () => {
    // The real Exemplar unit: footers readable on some pages only, and PDF page
    // 21 carries a stray "9" from a table. Neither gap nor stray may become a page.
    const r = reconcilePrintedPages([
        { pdfPageIndex: 1, value: null }, { pdfPageIndex: 2, value: null },
        { pdfPageIndex: 3, value: 3 }, { pdfPageIndex: 8, value: 8 }, { pdfPageIndex: 9, value: 9 },
        { pdfPageIndex: 18, value: 18 }, { pdfPageIndex: 21, value: 9 }
    ]);
    const printed = Object.fromEntries(r.pages.map(p => [p.pdfPageIndex, p.printed]));
    assert.equal(r.offset, 0);
    assert.equal(printed[1], null);
    assert.equal(printed[2], null);
    assert.equal(printed[3], 3);
    assert.equal(printed[21], null);
});

test('too few readings means no printed pages at all', () => {
    const r = reconcilePrintedPages([{ pdfPageIndex: 1, value: 1 }, { pdfPageIndex: 2, value: null }]);
    assert.equal(r.offset, null);
    assert.ok(r.pages.every(p => p.printed === null));
});

test('a unit, chapter or figure number is not a page number', () => {
    assert.equal(readPageNumber('UNIT 1'), null);
    assert.equal(readPageNumber('Chapter 4 Integers'), null);
    assert.equal(readPageNumber('Fig 1.2'), null);
    assert.equal(readPageNumber('p EXEMPLAR PROBLEMS'), null);   // OCR misread of "2"
    assert.equal(readPageNumber('INTEGERS 3'), 3);
    assert.equal(readPageNumber('8 EXEMPLAR PROBLEMS'), 8);
});

test('an unverified or unknown source says "Exact source not verified."', () => {
    assert.deepEqual(buildCitation(null), { verified: false, message: NOT_VERIFIED });
    assert.equal(buildCitation(record({ verification_status: STATUS.UNVERIFIED })).message, NOT_VERIFIED);
    assert.equal(buildCitation(record({ verification_status: STATUS.REJECTED })).message, NOT_VERIFIED);
    // A verified status without an allowlisted URL is still not a citation.
    assert.equal(buildCitation(record({ source_url: 'https://evil.example/x.pdf' })).message, NOT_VERIFIED);
    assert.equal(buildCitation(record({ source_url: 'http://ncert.nic.in/x.pdf' })).message, NOT_VERIFIED);
});

test('"just guess the page" is refused by code, and the model is never asked', async () => {
    const neverCalled = async () => { throw new Error('the model must not be consulted to guess a page'); };
    for (const ask of ['just guess the page number', 'Can you guess which page this question is on?', 'roughly which page is it, just guess']) {
        assert.equal(detectIntent(ask), 'guess', ask);
        const r = await answerLibraryQuestion(ask, { generateText: neverCalled });
        assert.match(r.reply, /Exact source not verified\./);
        assert.equal(r.library.cards.length, 0);
        assert.doesNotMatch(r.reply, /\bpage\s+\d+/i);
    }
});

test('AI-written questions are labelled AI-generated and carry no citation', async (t) => {
    const db = require('../config/db');
    const row = await db.get("SELECT COUNT(*) AS n FROM questions WHERE class_level = '7'").catch(() => null);
    if (!row || !Number(row.n)) return t.skip('no ingested library in this environment');
    // Even if the model tries to attribute its output to a book, the claim is removed.
    let modelCalls = 0;
    const fakeModel = async () => { modelCalls++; return '1. What is (-3) + 5? This is NCERT Exemplar Question 14 on page 7.\n2. Find the product of -4 and -6.'; };
    const r = await answerLibraryQuestion('give me similar questions like these for class 7 maths integers', {
        facts: [{ mem_key: 'class', mem_value: '7' }], generateText: fakeModel
    });
    assert.equal(r.library.intent, 'similar');
    assert.equal(modelCalls, 1);
    assert.equal(r.library.aiGenerated.label, 'AI-generated questions inspired by the topic');
    assert.equal(r.library.cards.length, 0);
    assert.doesNotMatch(r.reply, /NCERT Exemplar Question/i);
    assert.doesNotMatch(r.reply, /page\s*7/i);
    assert.match(r.reply, /Find the product of -4 and -6/);
});

test('source-like claims are stripped from any AI text', () => {
    const { text, removed } = stripFabricatedCitations(
        'Add the numbers first. This appears on page 12 of the textbook.\n' +
        'See NCERT Exemplar Question 9 for more. The answer is 2.\n' +
        'Source: NCERT Class 7\nRead more at https://example.com/x');
    assert.equal(text, 'Add the numbers first.\nThe answer is 2.');
    assert.equal(removed.length, 4);
    // Ordinary maths is left alone.
    assert.equal(stripFabricatedCitations('Multiply 3 by 4 to get 12.').text, 'Multiply 3 by 4 to get 12.');
});

// ── Deterministic extraction ─────────────────────────────────────────
const L = (text, x, y, extra = {}) => ({ text, x, y, right: x + 300, h: 10, blank: !text, margin: false, ...extra });
const page = (n, lines) => ({ pdfPageIndex: n, width: 595, height: 821, lines, rawText: lines.filter(l => !l.blank).map(l => l.text).join('\n') });

test('question numbers come only from the document, in strict sequence', () => {
    const { questions } = parseQuestions([page(1, [
        L('In the Questions 1 to 3, there are four options, out of which only one', 138, 700),
        L('is correct. Write the correct one.', 138, 685),
        L('1. First question text here?', 156, 660),
        L('(a) 1 (b) 2 (c) 3 (d) 4', 177, 645),
        L('2. Second question text here?', 156, 620),
        L('', 148, 600),                                   // box heading in an unmapped font
        L('1. Box item that restarts numbering', 148, 585),
        L('2. Another box item', 148, 570),
        L('3. Third question text here?', 156, 540)
    ])]);
    const ex = questions.filter(q => q.kind === 'exercise');
    assert.deepEqual(ex.map(q => q.questionNumber), ['1', '2', '3']);
    assert.doesNotMatch(ex[1].questionText, /Box item/);
    assert.equal(ex[0].section, 'Multiple Choice Questions');
});

test('a numbered list indented inside a question stays part of it', () => {
    const { questions } = parseQuestions([page(1, [
        L('In Questions 1 to 2, fill in the blanks to make the statements true.', 138, 700),
        L('1. Complete the table:', 147, 660),
        L('1. first row', 205, 645),
        L('2. second row', 205, 630),
        L('2. Next question?', 147, 600)
    ])]);
    const ex = questions.filter(q => q.kind === 'exercise');
    assert.deepEqual(ex.map(q => q.questionNumber), ['1', '2']);
    assert.match(ex[0].questionText, /first row/);
    assert.equal(ex[0].section, 'Fill in the Blanks');
});

test('a question crossing a page break keeps both pages and ignores margins', () => {
    const { questions } = parseQuestions([
        page(8, [
            L('In the Questions 1 to 2, there are four options, out of which only one', 138, 700),
            L('1. A long question that starts here and', 156, 120),
            L('', 95, 59, { margin: true }),                  // footer
            L('15-04-2018', 517, 29, { margin: true })
        ]),
        page(9, [
            L('', 480, 746, { margin: true }),                 // running head
            L('continues on the next page.', 99, 712),        // odd page: different margin
            L('(a) x (b) y (c) z (d) w', 99, 690),
            L('2. Second question?', 77, 660)
        ])
    ]);
    const q1 = questions.find(q => q.questionNumber === '1');
    assert.equal(q1.startPdfPage, 8);
    assert.equal(q1.endPdfPage, 9);
    assert.match(q1.questionText, /continues on the next page/);
    assert.doesNotMatch(q1.questionText, /15-04-2018/);
});

test('a range with no readable instruction gets no section name', () => {
    const { questions } = parseQuestions([page(1, [
        L('In the Questions 1 to 1, there are four options, out of which only one', 138, 700),
        L('1. Only MCQ.', 156, 660),
        L('2. Question with no instruction line?', 156, 620)
    ])]);
    assert.equal(questions.find(q => q.questionNumber === '2').section, null);
});

// ── Verification ────────────────────────────────────────────────────
const doc = { status: 'processed', content_hash: 'a'.repeat(64), document_url: OFFICIAL, allowedHosts: 'ncert.nic.in' };
const q14 = { kind: 'exercise', questionNumber: '14', questionText: 'Which of the folllowing is not the additive inverse of a ?\n(a) – (– a )', sequenceConsistent: true };
const page10 = '13. (– 10) × (– 5) + (– 7) is equal to\n14. Which of the folllowing is not the additive inverse of a ?\n(a) – (– a ) (b) a × ( – 1)';

test('AUTO_VERIFIED requires every check to pass', () => {
    assert.equal(autoVerify(q14, doc, page10).status, STATUS.AUTO_VERIFIED);
    assert.equal(autoVerify(q14, { ...doc, document_url: 'https://evil.example/x.pdf' }, page10).status, STATUS.UNVERIFIED);
    assert.equal(autoVerify(q14, { ...doc, status: 'failed' }, page10).status, STATUS.UNVERIFIED);
    assert.equal(autoVerify(q14, doc, 'a different page entirely').status, STATUS.UNVERIFIED);
    assert.equal(autoVerify({ ...q14, questionNumber: '15' }, doc, page10).status, STATUS.UNVERIFIED);
    assert.equal(autoVerify({ ...q14, sequenceConsistent: false }, doc, page10).status, STATUS.UNVERIFIED);
});

test('symbol-heavy maths is verified by its exact characters', () => {
    const q = { kind: 'exercise', questionNumber: '33', questionText: '(–157) × (–19) + 157 = ___________', sequenceConsistent: true };
    assert.equal(autoVerify(q, doc, '33. (–157) × (–19) + 157 = ___________').status, STATUS.AUTO_VERIFIED);
});

test('a formula too short to be distinctive goes to a human', () => {
    const q = { kind: 'exercise', questionNumber: '99', questionText: 'a × b = b × a', sequenceConsistent: true };
    assert.equal(autoVerify(q, doc, '99. a × b = b × a').status, STATUS.UNVERIFIED);
});

test('an uploaded document can never be auto-verified', () => {
    assert.equal(autoVerify(q14, { ...doc, uploaded: true, document_url: null }, page10).status, STATUS.UNVERIFIED);
});

// ── Collection safety ───────────────────────────────────────────────
test('only exact allowlisted hosts over https are fetched', () => {
    const hosts = ['ncert.nic.in'];
    assert.doesNotThrow(() => assertAllowedUrl(OFFICIAL, hosts));
    for (const bad of [
        'http://ncert.nic.in/x.pdf',                  // plaintext
        'https://ncert.nic.in.evil.test/x.pdf',       // suffix trick
        'https://evil.test/ncert.nic.in/x.pdf',
        'https://user:pw@ncert.nic.in/x.pdf',         // credentials
        'https://ncert.nic.in:8443/x.pdf',            // odd port
        'https://n20.ncert.org.in/x.pdf',             // real off-site link on the NCERT page
        'https://169.254.169.254/latest/meta-data',   // SSRF to cloud metadata
        'https://127.0.0.1/admin',
        'file:///etc/passwd'
    ]) assert.throws(() => assertAllowedUrl(bad, hosts), undefined, bad);
});

test('robots.txt rules are honoured, with longest match winning', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /pdf/\nAllow: /pdf/publication/\n');
    assert.equal(robotsAllows(rules, '/pdf/private/x.pdf'), false);
    assert.equal(robotsAllows(rules, '/pdf/publication/exemplarproblem/x.pdf'), true);
    assert.equal(robotsAllows(parseRobots(''), '/anything'), true);
});

test('library admin access is denied when no allowlist is configured', async () => {
    const saved = process.env.LIBRARY_ADMINS;
    delete process.env.LIBRARY_ADMINS;
    const gate = require('../middleware/libraryAdmin');
    let status = 0;
    await gate({ user: { id: 1, role: 'admin' } }, { status(s) { status = s; return { json() {} }; } }, () => { status = 200; });
    assert.equal(status, 403, 'a role claim in the token alone must not grant admin');
    if (saved !== undefined) process.env.LIBRARY_ADMINS = saved;
});

// ── Against the real ingested unit, when present ────────────────────
test('real library: an existing question traces to its recorded source', async (t) => {
    const db = require('../config/db');
    const row = await db.get("SELECT COUNT(*) AS n FROM questions WHERE verification_status = 'AUTO_VERIFIED'").catch(() => null);
    if (!row || !Number(row.n)) return t.skip('no ingested library in this environment');
    const r = await answerLibraryQuestion('where did this question come from: "Which of the folllowing is not the additive inverse of a ?"');
    assert.equal(r.library.cards.length, 1);
    assert.equal(r.library.cards[0].citation.verified, true);
    assert.match(r.library.cards[0].citation.line3, /\bQuestion 14\b/);

    const none = await answerLibraryQuestion('where did this question come from: "What is the capital city of France and why?"');
    assert.equal(none.library.cards.length, 0);
    assert.match(none.reply, /Exact source not verified\./);

    const vague = await answerLibraryQuestion('where did this question come from: "Which of the following statements is not true?"');
    assert.equal(vague.library.cards.length, 0, 'an ambiguous match must not be cited');
});

// ── Document integrity ──────────────────────────────────────────────
// The Triangles unit (Class 7, Unit 6) says "In each of the questions 1 to 49".
// The first instruction pattern missed that wording, the parser never found
// question 1, and a stray "1." inside a table on PDF page 26 became
// "Question 1" — and was auto-verified, because a "1." really did sit next to
// that text. These tests pin both the wording and the guard behind it.
const { checkIntegrity } = require('../services/sourceLibrary/questionParser');

test('"In each of the questions 1 to 49" is recognised as an instruction', () => {
    const { sections } = parseQuestions([page(7, [
        L('In each of the questions 1 to 2, four options are given, out of which', 60, 700),
        L('only one is correct. Choose the correct one.', 60, 685),
        L('1. First?', 77, 660),
        L('2. Second?', 77, 630)
    ])]);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].from, 1);
    assert.equal(sections[0].section, 'Multiple Choice Questions');
});

test('a document whose stated numbering is not fully extracted fails integrity', () => {
    // Reproduces Unit 6: the 1-49 instruction is missed, extraction picks up
    // a table row as "Question 1", and the stated 50-69 range is never found.
    const { questions, integrity } = parseQuestions([
        page(15, [
            L('In questions 50 to 51, fill in the blanks to make the statements true.', 60, 700),
            L('50. The triangle always has altitude outside itself.', 69, 680),
            L('51. The sum of an exterior angle is ___.', 69, 660)
        ]),
        page(26, [L('1. 5, 3.6, 3.9', 69, 500)])
    ]);
    assert.equal(integrity.ok, false);
    assert.ok(integrity.problems.some(p => /50–51/.test(p)));
    assert.ok(integrity.problems.some(p => /starts at 50, not 1/.test(p)));
    // The bogus "Question 1" exists in the parse — which is exactly why the
    // collector must refuse to auto-verify anything from such a document.
    assert.ok(questions.some(q => q.questionNumber === '1' && /3\.6/.test(q.questionText)));
});

test('a complete document passes integrity', () => {
    const ok = checkIntegrity(
        [1, 2, 3].map(n => ({ kind: 'exercise', questionNumber: String(n) })).concat([{ kind: 'example', questionNumber: '1' }]),
        [{ from: 1, to: 2, section: 'Multiple Choice Questions', page: 8 }, { from: 3, to: 3, section: 'Fill in the Blanks', page: 9 }]);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.problems, []);
    assert.equal(ok.exerciseTrustedBelow, Infinity);
    assert.equal(ok.exampleTrustedBelow, Infinity);
});

test('out-of-order solved examples fail integrity', () => {
    const r = checkIntegrity([{ kind: 'example', questionNumber: '1' }, { kind: 'example', questionNumber: '3' }], []);
    assert.equal(r.ok, false);
});

test('a break in examples does not distrust exercise questions, and vice versa', () => {
    const { numberTrusted } = require('../services/sourceLibrary/questionParser');
    const results = [
        ...[1, 2, 3, 4, 5].map(n => ({ kind: 'exercise', questionNumber: String(n) })),
        ...[1, 2, 3, 5].map(n => ({ kind: 'example', questionNumber: String(n) }))     // example 4 missing
    ];
    const r = checkIntegrity(results, [{ from: 1, to: 5, section: 'Multiple Choice Questions', page: 8 }]);
    assert.equal(r.ok, false);
    assert.equal(numberTrusted({ kind: 'exercise', questionNumber: '5' }, r), true);
    assert.equal(numberTrusted({ kind: 'example', questionNumber: '2' }, r), true);
    // The example just before the break may have swallowed the missing one.
    assert.equal(numberTrusted({ kind: 'example', questionNumber: '3' }, r), false);
    assert.equal(numberTrusted({ kind: 'example', questionNumber: '5' }, r), false);
});

test('only questions before an exercise break are trusted, minus the one before it', () => {
    const { numberTrusted } = require('../services/sourceLibrary/questionParser');
    const results = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => ({ kind: 'exercise', questionNumber: String(n) }));
    const r = checkIntegrity(results, [{ from: 1, to: 12, section: null, page: 8 }]);   // 11, 12 never found
    assert.equal(numberTrusted({ kind: 'exercise', questionNumber: '9' }, r), true);
    assert.equal(numberTrusted({ kind: 'exercise', questionNumber: '10' }, r), false);
});

test('numbering that starts mid-way trusts nothing', () => {
    const { numberTrusted } = require('../services/sourceLibrary/questionParser');
    const r = checkIntegrity([{ kind: 'exercise', questionNumber: '1' }], [{ from: 50, to: 51, section: null, page: 15 }]);
    assert.equal(numberTrusted({ kind: 'exercise', questionNumber: '1' }, r), false);
});

test('questions under a readable heading before the first stated range are trusted', () => {
    const { numberTrusted } = require('../services/sourceLibrary/questionParser');
    const q = (n, section) => ({ kind: 'exercise', questionNumber: String(n), section, orderIndex: n - 1 });
    const headed = [q(1, 'Multiple Choice Questions (Type-I)'), q(2, 'Multiple Choice Questions (Type-I)'), q(3, 'Matching'), q(4, 'Matching')];
    const r = checkIntegrity(headed, [{ from: 3, to: 4, section: 'Matching', page: 2 }]);
    assert.equal(numberTrusted(headed[0], r), true);
    // Same numbers with no heading behind them: nothing vouches for 1 and 2.
    const bare = [q(1, null), q(2, null), q(3, 'Matching'), q(4, 'Matching')];
    const r2 = checkIntegrity(bare, [{ from: 3, to: 4, section: 'Matching', page: 2 }]);
    assert.equal(numberTrusted(bare[0], r2), false);
});

test('superscripts are kept, not dropped from the question text', () => {
    const { groupLines } = require('../services/sourceLibrary/pdfLayout');
    const item = (str, x, y, h) => ({ str, transform: [h, 0, 0, h, x, y], width: str.length * h * 0.5 });
    // Exemplar Class 7 Exponents, Q23 and Q24 side by side on one row.
    const lines = groupLines([
        item('23.', 147, 384, 12), item('(–2)', 177, 384, 12), item('31', 198, 388, 7),
        item('× (–2)', 211, 384, 12), item('13', 239, 388, 7), item('= (–2)', 254, 384, 12),
        item('24.', 372, 384, 12), item('(–3)', 397, 384, 12), item('8', 417, 388, 7),
        item('÷', 426, 384, 12), item('(–3)', 437, 384, 12), item('5', 457, 388, 7), item('= (–3)', 466, 384, 12),
        item('Some ordinary body text on another line', 147, 350, 12)
    ], 821);
    const texts = lines.map(l => l.text);
    assert.ok(texts.includes('23. (–2)^31 × (–2)^13 = (–2)'), texts.join(' | '));
    assert.ok(texts.includes('24. (–3)^8 ÷ (–3)^5 = (–3)'), texts.join(' | '));
});

test('a question printed in the bottom band is kept, but the footer below it is not', () => {
    const { groupLines } = require('../services/sourceLibrary/pdfLayout');
    const item = (str, x, y, h = 12) => ({ str, transform: [h, 0, 0, h, x, y], width: str.length * h * 0.5 });
    // Exemplar Class 6 Maths Unit 1, PDF page 10: Q65 sits at y=78.
    const lines = groupLines([
        item('62. Of the given two natural numbers, the one having more digits is', 111, 169),
        item('greater.', 140, 151),
        item('63. Natural numbers are closed under addition.', 111, 127),
        item('64. Natural numbers are not closed under multiplication.', 111, 103),
        item('65. Natural numbers are closed under subtraction.', 111, 78),
        item('58. 1 + 2 + 3 _______ (–1) + (–2) + (–3)', 111, 54),
        item('10 E XEMPLAR P ROBLEMS', 63, 20),
        item('11.4.2018', 479, 8)
    ], 821);
    const kept = lines.filter(l => !l.margin).map(l => l.text);
    assert.ok(kept.includes('65. Natural numbers are closed under subtraction.'), kept.join(' | '));
    assert.ok(kept.includes('58. 1 + 2 + 3 _______ (–1) + (–2) + (–3)'), kept.join(' | '));
    assert.ok(!kept.some(t => /EXEMPLAR|XEMPLAR|2018/.test(t)), kept.join(' | '));
});

test('a running footer set apart by a wide gap stays in the margin', () => {
    const { groupLines } = require('../services/sourceLibrary/pdfLayout');
    const item = (str, x, y, h = 12) => ({ str, transform: [h, 0, 0, h, x, y], width: str.length * h * 0.5 });
    const lines = groupLines([
        item('1. First question about fractions and decimals?', 100, 220),
        item('2. Second question about fractions and decimals?', 100, 196),
        item('3. Third question about fractions and decimals?', 100, 172),
        item('Reprint for classroom use only', 100, 60)
    ], 821);
    assert.ok(lines.find(l => l.text.startsWith('Reprint')).margin);
});

test('printed pages from running heads need a recurring head; bare table numbers never count', () => {
    const { readRunningHeads, reconcilePrintedPages } = require('../services/sourceLibrary/pdfLayout');
    const m = (text) => ({ text, margin: true, blank: false });
    const pages = [
        { pdfPageIndex: 1, lines: [m('8'), m('Area of the rectangle is 8')] },
        { pdfPageIndex: 2, lines: [m('2 EXEMPLAR PROBLEMS')] },
        { pdfPageIndex: 3, lines: [m('FOOD: WHERE DOES IT COME FROM 3')] },
        { pdfPageIndex: 4, lines: [m('4 EXEMPLAR PROBLEMS')] },
        { pdfPageIndex: 5, lines: [m('FOOD: WHERE DOES IT COME FROM 5'), m('UNIT 9')] }
    ];
    const readings = readRunningHeads(pages);
    assert.equal(readings[0].value, null);
    const r = reconcilePrintedPages(readings);
    assert.equal(r.offset, 0);
    assert.deepEqual(r.pages.map(p => p.printed), [null, 2, 3, 4, 5]);
});

test('page numbers are dropped entirely when running heads and footer OCR disagree', () => {
    const { combinePrintedPages } = require('../services/sourceLibrary/pdfLayout');
    const side = (offset) => ({ offset, pages: [1, 2, 3].map(i => ({ pdfPageIndex: i, printed: i + offset, evidence: 'x' })) });
    const conflict = combinePrintedPages(side(0), side(4), 3);
    assert.deepEqual(conflict.pages.map(p => p.printed), [null, null, null]);
    const agree = combinePrintedPages(side(4), { offset: null, pages: [] }, 3);
    assert.deepEqual(agree.pages.map(p => p.printed), [5, 6, 7]);
});

test('a box title in a symbol font ends the question, but a symbol-font bracket inside it does not', () => {
    const { groupLines } = require('../services/sourceLibrary/pdfLayout');
    const item = (str, x, y, h = 12) => ({ str, transform: [h, 0, 0, h, x, y], width: str.length * h * 0.5 });
    const puaWord = [...'Magic  Squares'].map(c => String.fromCharCode(0xF000 + c.charCodeAt(0))).join('');
    const bracket = String.fromCharCode(0xF0E6) + ' ' + String.fromCharCode(0xF0F6);
    const lines = groupLines([item(puaWord, 150, 360), item(bracket, 150, 300), item('Body text line here', 150, 200)], 821);
    assert.equal(lines.find(l => l.y === 360).blank, true);
    assert.equal(lines.find(l => l.y === 300).blank, false);
});

test('an instruction with a comma before its range still starts the exercise', () => {
    const { questions } = parseQuestions([
        page(1, [L('Example 33 : Find the smallest number.', 80, 714), L('Solution : It is 5.', 80, 660),
            L('In each of the questions, 1 to 24, write the correct answer from the', 139, 525),
            L('1. 196 is the square of', 153, 491), L('2. Which of the following is a square of an even number?', 153, 450)])
    ]);
    const ex = questions.filter(q => q.kind === 'exercise').map(q => q.questionNumber);
    assert.deepEqual(ex, ['1', '2']);
});

test('text in a font shifted by 29 code points is decoded; ordinary text is untouched', () => {
    const { unshiftGlyphs } = require('../services/sourceLibrary/pdfLayout');
    const shifted = [...'4. At noon the sun appears white as'].map(c => String.fromCharCode(c.charCodeAt(0) - 29)).join('');
    assert.equal(unshiftGlyphs(shifted), '4. At noon the sun appears white as');
    assert.equal(unshiftGlyphs('5. Which of the following (a) 2 + 3'), '5. Which of the following (a) 2 + 3');
});

test('a question starting in the margin band is kept only when it is the next number', () => {
    const lines = (arr) => arr.map(([text, x, y, margin]) => ({ text, x, y, right: x + 300, h: 12, blank: false, margin: Boolean(margin) }));
    const pg = (i, arr) => ({ pdfPageIndex: i, width: 612, height: 792, lines: lines(arr) });
    const { questions } = parseQuestions([
        pg(1, [['I. Multiple Choice Questions', 75, 700], ['4. Buckminsterfullerene is an allotropic form of', 75, 191]]),
        pg(2, [['5. Which of the following are correct structural isomers of butane?', 75, 715, true],
               ['9. Running head that is not the next number', 75, 740, true],
               ['6. Which of these reactions is an oxidation?', 75, 497]])
    ].map((p, i) => i === 0 ? { ...p, lines: [{ ...p.lines[0] }, { ...p.lines[1], text: '1. Buckminsterfullerene is an allotropic form of' },
        { text: '2. Second question text here', x: 75, y: 150, right: 375, h: 12, blank: false, margin: false },
        { text: '3. Third question text here', x: 75, y: 120, right: 375, h: 12, blank: false, margin: false },
        { text: '4. Fourth question text here', x: 75, y: 100, right: 375, h: 12, blank: false, margin: false }] } : p));
    const nums = questions.filter(q => q.kind === 'exercise').map(q => q.questionNumber);
    assert.deepEqual(nums, ['1', '2', '3', '4', '5', '6']);
});

// ── Answer keys and unreadable questions ────────────────────────────
test('an answer key set in columns ends extraction instead of becoming questions', () => {
    // Class 11 Chemistry ends with "1. (ii)  2. (iii)  3. (iii) …" in columns.
    const { questions } = parseQuestions([
        page(1, [L('I. Multiple Choice Questions (Type-I)', 91, 740), L('1. First real question?', 92, 700), L('2. Second real question?', 92, 660)]),
        page(9, [L('1. (ii)', 109, 700), L('2. (iii)', 172, 700), L('3. (iii)', 238, 700)])
    ]);
    assert.deepEqual(questions.map(q => q.questionNumber), ['1', '2']);
});

test('a single question that only shows option labels is kept, not mistaken for an answer key', () => {
    // Class 7 Rational Numbers Q107: its fractions are images, leaving "(a) (b)".
    const { questions } = parseQuestions([page(22, [
        L('In questions 1 to 3, fill in the boxes.', 61, 740),
        L('1. A real question with words?', 61, 700),
        L('2. (a) (b)', 61, 660),
        L('3. What is the error in this working?', 61, 620)
    ])]);
    assert.deepEqual(questions.map(q => q.questionNumber), ['1', '2', '3']);
});

test('a question with no readable text is never auto-verified', () => {
    const q = { kind: 'exercise', questionNumber: '107', questionText: '(a) × (b) ×', sequenceConsistent: true };
    const v = autoVerify(q, doc, '107 . (a) × (b) ×');
    assert.equal(v.status, STATUS.UNVERIFIED);
    assert.ok(v.failed.includes('question text readable'));
});

test('a single missing question number recovers the rest for review without trusting them', () => {
    const { questionParser } = { questionParser: require('../services/sourceLibrary/questionParser') };
    const r = questionParser.parseQuestions([page(11, [
        L('In questions 1 to 5, fill in the blanks.', 60, 740),
        L('1. One?', 69, 700), L('2. Two?', 69, 680), L('3. Three?', 69, 660),
        // "4." did not extract
        L('5. Five?', 69, 620), L('6. Six?', 69, 600)
    ])]);
    const nums = r.questions.map(q => q.questionNumber);
    assert.deepEqual(nums, ['1', '2', '3', '5', '6']);            // 5 and 6 recovered, not lost
    const trusted = r.questions.filter(q => questionParser.numberTrusted(q, r.integrity)).map(q => q.questionNumber);
    assert.deepEqual(trusted, ['1', '2']);                        // 3 may hold 4's text; 5+ are after the gap
    assert.equal(r.integrity.problems.filter(p => /was not found/.test(p)).length, 1, 'one break, reported once');
});
