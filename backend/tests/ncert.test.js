const test = require('node:test');
const assert = require('node:assert/strict');
const { safeUrl, discover, textbookChapters, gradeChapter } = require('../services/ncertSource');
const { createTutor, createAutoTutor, retrieve, rankChapters } = require('../services/ncertTutor');
const { createStore } = require('../services/ncertStore');
const pdf = { identifier: 'pdf', mimeType: 'application/pdf', artifactUrl: 'https://obj.diksha.gov.in/chapter.pdf' };
const root = { identifier: 'book', children: [{ identifier: 'ch1', name: 'Chapter-1 Cells', children: [
    { identifier: 'etext', name: 'eTextbook', children: [pdf] },
    { identifier: 'exercises', name: 'Worksheet', children: [{ ...pdf, identifier: 'worksheet' }] }
]}] };
const chapter = { ...textbookChapters(root)[0], status: 'ready', sha256: 'abc', pages: [{ page: 1, text: 'Cells are the basic structural units of life.' }] };
const book = { id: 'book', name: 'Science', revision: 'r1', chapters: [chapter] };

test('only PDFs within explicit textbook containers qualify', () => {
    assert.equal(textbookChapters(root).length, 1);
    assert.equal(textbookChapters(root)[0].resourceId, 'pdf');
});
test('cyclic or incomplete hierarchy fails', () => {
    assert.throws(() => textbookChapters({ identifier: 'b', children: [{ identifier: 'b' }] }));
    assert.throws(() => textbookChapters({ identifier: 'b', children: {} }));
});
test('untrusted asset hosts, credentials and ports rejected', () => {
    for (const url of ['http://obj.diksha.gov.in/x', 'https://127.0.0.1/x', 'https://obj.diksha.gov.in.evil.test/x',
        'https://u:p@obj.diksha.gov.in/x', 'https://obj.diksha.gov.in:3000/x']) assert.throws(() => safeUrl(url));
});
test('pagination continues past server-capped short pages and deduplicates', async () => {
    const offsets = [];
    const pages = [[{identifier:'a'}], [{identifier:'a'},{identifier:'b'}], []];
    const results = [];
    for await (const b of discover({}, async (_, payload) => {
        offsets.push(payload.request.offset); return { content: pages.shift() };
    })) results.push(b.identifier);
    assert.deepEqual(results, ['a','b']); assert.deepEqual(offsets, [0,1,3]);
});
test('repeated or malformed pages cannot report success', async () => {
    await assert.rejects(async () => { for await (const b of discover({}, async () => ({ content: [{identifier:'a'}] }))) void b; });
    await assert.rejects(async () => { for await (const b of discover({}, async () => ({}))) void b; });
});
test('not-ready and wrong-chapter requests never invoke the model', async () => {
    const answer = createTutor({ store: { get: async () => ({...book,chapters:[{...chapter,status:'pending'}]}) }, generateJSON: () => assert.fail('model invoked') });
    assert.equal((await answer({ bookId:'book',chapterId:'wrong',question:'cells' })).status,404);
    assert.equal((await answer({ bookId:'book',chapterId:chapter.id,question:'cells' })).status,409);
});
test('unsupported questions do not invoke model', async () => {
    assert.deepEqual(retrieve(chapter, 'astronomy planets'), []);
    const answer = createTutor({ store: { get: async () => book }, generateJSON: () => assert.fail('model invoked') });
    assert.equal((await answer({bookId:'book',chapterId:chapter.id,question:'astronomy planets'})).body.grounded,false);
});
test('invented citation IDs are refused', async () => {
    const answer = createTutor({ store:{get:async()=>book}, generateJSON:async()=>({ answer:'unsupported',sourceIds:['p999'] }) });
    assert.equal((await answer({bookId:'book',chapterId:chapter.id,question:'cells'})).body.grounded,false);
});
test('valid answers return selected chapter provenance', async () => {
    const answer = createTutor({ store:{get:async()=>book}, generateJSON:async()=>({ answer:'Cells are units of life.',sourceIds:['p1-0'] }) });
    const result = await answer({bookId:'book',chapterId:chapter.id,question:'cells'});
    assert.equal(result.body.sources[0].page,1);
    assert.equal(result.body.sources[0].revision,'r1');
    assert.equal(result.body.sources[0].url,'https://obj.diksha.gov.in/chapter.pdf#page=1');
});
test('book replacement is idempotent and removes old chapter data using real SQLite', async () => {
    const { DatabaseSync } = require('node:sqlite');
    const sql = new DatabaseSync(':memory:');
    const db = { dialect:()=> 'sqlite', run:async(s,p=[])=>sql.prepare(s).run(...p),
        get:async(s,p=[])=>sql.prepare(s).get(...p), all:async(s,p=[])=>sql.prepare(s).all(...p) };
    const store = createStore(db);
    try {
        await store.put(book); await store.put(book);
        assert.equal((await store.all()).length,1);
        assert.equal((await store.all())[0].chapters[0].pages,undefined);
        await store.put({...book,revision:'r2',chapters:[]});
        assert.deepEqual((await store.get('book')).chapters,[]);
    } finally { sql.close(); }
});

test('DIKSHA explicit zero-count response completes discovery', async () => {
    const books = [];
    for await (const b of discover({}, async () => ({count:0}))) books.push(b);
    assert.deepEqual(books, []);
});

test('DIKSHA total-count-only final page completes after reaching total', async () => {
    const pages = [{count:1, content:[{identifier:'a'}]}, {count:1}];
    const books = [];
    for await (const b of discover({}, async () => pages.shift())) books.push(b.identifier);
    assert.deepEqual(books, ['a']);
});

test('numbered and Urdu textbook containers preserve chapter identity', () => {
    const translated = structuredClone(root);
    translated.children[0].name = '1-بیوہ';
    translated.children[0].children[0].name = 'ای ٹیکسٹ بک (eTextBook)';
    assert.equal(textbookChapters(translated)[0].name, '1-بیوہ');
});
test('explicit eTextbook resource category supports direct chapter PDFs', () => {
    const direct = {identifier:'b',children:[{identifier:'c',name:'1-Unit 1',children:[{...pdf,primaryCategory:'eTextbook'}]}]};
    assert.equal(textbookChapters(direct)[0].nodeId,'c');
});

// --- chapter grading -------------------------------------------------
const body = (n) => 'x'.repeat(n);

test('a chapter is not condemned by one illustration or title page', () => {
    // Regression: the old rule required EVERY page to carry >=40 chars, so a
    // single picture page pushed a fully readable chapter into needs_review.
    const pages = [{ text: '' }, ...Array.from({ length: 18 }, () => ({ text: body(3000) }))];
    assert.equal(gradeChapter(pages).status, 'ready');
});
test('a mostly blank chapter still needs review, not silent acceptance', () => {
    const pages = [...Array.from({ length: 12 }, () => ({ text: '' })), { text: body(900) }, { text: body(900) }];
    assert.equal(gradeChapter(pages).status, 'needs_review');
});
test('scanned image-only chapters are unavailable, not review', () => {
    // These need OCR; asking a human to "review" them is busywork.
    assert.equal(gradeChapter(Array.from({ length: 20 }, () => ({ text: '' }))).status, 'unavailable');
    assert.equal(gradeChapter([]).status, 'unavailable');
});
test('grading reports the evidence it judged on', () => {
    const g = gradeChapter([{ text: body(100) }, { text: '' }]);
    assert.equal(g.pageCount, 2);
    assert.equal(g.readablePages, 1);
    assert.equal(g.chars, 100);
});

// --- automatic chapter selection -------------------------------------
const candidates = [
    { chapter_id: 'c1', book_id: 'b', chapter_name: 'Chapter-1 Motion', book_name: 'Science', text_chars: 5000 },
    { chapter_id: 'c2', book_id: 'b', chapter_name: 'Chapter-2 Cell: The Building Block', book_name: 'Science', text_chars: 4000 }
];
test('question routes to the chapter whose title matches', () => {
    assert.equal(rankChapters(candidates, 'what is a cell made of')[0].chapter_id, 'c2');
    assert.equal(rankChapters(candidates, 'explain motion and speed')[0].chapter_id, 'c1');
});
test('a question with no usable terms still returns candidates', () => {
    assert.equal(rankChapters(candidates, '???').length, 2);
});
test('auto tutor asks for a class before guessing a textbook', async () => {
    const auto = createAutoTutor({ store: {}, generateJSON: async () => null, answerChapter: async () => {} });
    assert.equal((await auto({ question: 'what is a cell' })).status, 400);
});
test('auto tutor reports honestly when nothing is imported for that class', async () => {
    const auto = createAutoTutor({
        store: { findChapters: async () => [] },
        generateJSON: async () => null,
        answerChapter: async () => { throw new Error('must not be called'); }
    });
    const res = await auto({ grade: 'Class 4', subject: 'Science', question: 'what is a cell' });
    assert.equal(res.status, 200);
    assert.equal(res.body.grounded, false);
});
test('auto tutor returns the first grounded chapter and names it', async () => {
    const auto = createAutoTutor({
        store: { findChapters: async () => candidates },
        generateJSON: async () => null,
        answerChapter: async ({ chapterId }) => chapterId === 'c2'
            ? { status: 200, body: { result: 'A cell has a membrane.', grounded: true, sources: [] } }
            : { status: 200, body: { result: 'not here', grounded: false, sources: [] } }
    });
    const res = await auto({ grade: 'Class 9', subject: 'Science', question: 'what is a cell made of' });
    assert.equal(res.body.grounded, true);
    assert.equal(res.body.matchedChapter, 'Chapter-2 Cell: The Building Block');
});

// --- semantic (pgvector) tutor ---------------------------------------
const { createVectorTutor, MIN_SCORE } = require('../services/ncertTutor');
const vecHit = (score, text) => ({
    score, text, page: 5, chapter_id: 'c1', book_id: 'b',
    chapter_name: '10 - Gravitation', book_name: 'Science',
    url: 'https://obj.diksha.gov.in/chapter.pdf', sha256: 'abc',
    revision: 'r1', license: 'CC BY 4.0'
});
const fakeEmbed = async () => new Array(4).fill(0.5);

test('a shelf with no relevant chapter is not answered from the nearest noise', async () => {
    // Every chunk has SOME nearest neighbour; answering from a 0.15 match is
    // exactly the confident-but-wrong failure the threshold exists to stop.
    const tutor = createVectorTutor({
        corpus: { search: async () => [vecHit(MIN_SCORE - 0.05, 'unrelated history text')] },
        embedOne: fakeEmbed,
        generateJSON: () => assert.fail('model invoked on noise')
    });
    const res = await tutor({ grade: 'Class 9', question: 'why do things fall' });
    assert.equal(res.body.grounded, false);
});

test('semantic tutor refuses invented citation ids', async () => {
    const tutor = createVectorTutor({
        corpus: { search: async () => [vecHit(0.7, 'Objects fall because of gravity.')] },
        embedOne: fakeEmbed,
        generateJSON: async () => ({ answer: 'Gravity pulls them.', sourceIds: ['s99'] })
    });
    assert.equal((await tutor({ grade: 'Class 9', question: 'why do things fall' })).body.grounded, false);
});

test('the named chapter is the one cited, not the top retrieval hit', async () => {
    // Live case: the nearest chunk was FORCE AND LAWS OF MOTION while the
    // model answered from GRAVITATION. Naming the nearest hit would label
    // the answer with a chapter its own citation link contradicts.
    const near = { ...vecHit(0.71, 'nearest but unused'), chapter_name: '8-FORCE AND LAWS OF MOTION' };
    const cited = { ...vecHit(0.45, 'Objects fall because of gravity.'), chapter_name: '9-GRAVITATION' };
    const tutor = createVectorTutor({
        corpus: { search: async () => [near, cited] },
        embedOne: fakeEmbed,
        generateJSON: async () => ({ answer: 'Gravity pulls them down.', sourceIds: ['s1'] })
    });
    const res = await tutor({ grade: 'Class 9', question: 'why do things fall down' });
    assert.equal(res.body.matchedChapter, '9-GRAVITATION');
    assert.equal(res.body.sources.length, 1);
    assert.equal(res.body.sources[0].excerpt, 'Objects fall because of gravity.');
});

test('semantic tutor returns provenance for the chunks it actually cited', async () => {
    const tutor = createVectorTutor({
        corpus: { search: async () => [vecHit(0.71, 'Objects fall because of gravity.'), vecHit(0.4, 'other')] },
        embedOne: fakeEmbed,
        generateJSON: async () => ({ answer: 'Gravity pulls them down. (s0)', sourceIds: ['s0'] })
    });
    const res = await tutor({ grade: 'Class 9', subject: 'Science', question: 'why do things fall' });
    assert.equal(res.body.grounded, true);
    assert.equal(res.body.sources.length, 1);
    assert.equal(res.body.sources[0].url, 'https://obj.diksha.gov.in/chapter.pdf#page=5');
    assert.equal(res.body.sources[0].revision, 'r1');
    assert.equal(res.body.matchedChapter, '10 - Gravitation');
    // The internal chunk id must not leak into the prose.
    assert.equal(res.body.result, 'Gravity pulls them down.');
});

test('semantic tutor asks for a class rather than searching every grade', async () => {
    const tutor = createVectorTutor({
        corpus: { search: () => assert.fail('searched without a class') },
        embedOne: fakeEmbed, generateJSON: async () => null
    });
    assert.equal((await tutor({ question: 'why do things fall' })).status, 400);
});

test('an empty shelf reports honestly instead of guessing', async () => {
    const tutor = createVectorTutor({
        corpus: { search: async () => [] }, embedOne: fakeEmbed,
        generateJSON: () => assert.fail('model invoked')
    });
    const res = await tutor({ grade: 'Class 4', question: 'what is a cell' });
    assert.equal(res.body.grounded, false);
    assert.match(res.body.result, /finished importing/);
});

test('a short but complete chapter is ready, not held for review', () => {
    // NCERT Lab Manual activities run 2-3 pages. The 1500-char floor alone
    // flagged 97 fully-readable chapters as needing human review.
    const pages = [{ text: body(508) }, { text: body(87) }, { text: body(904) }];
    assert.equal(gradeChapter(pages).status, 'ready');
});
test('a heading-only stub is still not ready', () => {
    // ~110 chars/page: a unit title and nothing to teach from.
    assert.equal(gradeChapter([{ text: body(100) }, { text: body(100) }]).status, 'needs_review');
});

// --- edition preference ----------------------------------------------
// DIKSHA ships the superseded Class 9 Science book titled "(NEW) Ncert
// Science Textbook For Class IX" with no year field, alongside the current
// "Exploration" (2026). Answering from whichever chunk scored highest taught
// the previous syllabus — the observed failure was a chapter tour of MATTER
// IN OUR SURROUNDINGS when the current book opens with EXPLORATION.
const edition = (score, name, current) => ({ ...vecHit(score, 'text of ' + name), chapter_name: name, _current: current });

test('the current edition wins even when an older one scores higher', async () => {
    const tutor = createVectorTutor({
        corpus: {
            search: async ({ currentOnly }) => currentOnly
                ? [edition(0.52, '2-Cell: The Building Block', true)]
                : [edition(0.61, '1-MATTER IN OUR SURROUNDINGS', false),
                   edition(0.52, '2-Cell: The Building Block', true)]
        },
        embedOne: fakeEmbed,
        generateJSON: async () => ({ answer: 'A cell is the unit of life.', sourceIds: ['s0'] })
    });
    const res = await tutor({ grade: 'Class 9', subject: 'Science', question: 'what is a cell' });
    assert.equal(res.body.matchedChapter, '2-Cell: The Building Block');
});

test('an older edition is still used when the current one has nothing', async () => {
    // A superseded chapter beats answering from model memory.
    const tutor = createVectorTutor({
        corpus: {
            search: async ({ currentOnly }) => currentOnly
                ? [edition(0.10, 'unrelated current chapter', true)]
                : [edition(0.58, '3-ATOMS AND MOLECULES', false)]
        },
        embedOne: fakeEmbed,
        generateJSON: async () => ({ answer: 'A mole is 6.022e23 particles.', sourceIds: ['s0'] })
    });
    const res = await tutor({ grade: 'Class 9', subject: 'Science', question: 'what is a mole' });
    assert.equal(res.body.grounded, true);
    assert.equal(res.body.matchedChapter, '3-ATOMS AND MOLECULES');
});

test('falling back never lowers the grounding bar', async () => {
    // Neither edition is relevant: widening must not turn noise into an answer.
    const tutor = createVectorTutor({
        corpus: { search: async () => [edition(0.12, 'nothing relevant', false)] },
        embedOne: fakeEmbed,
        generateJSON: () => assert.fail('model invoked on noise')
    });
    assert.equal((await tutor({ grade: 'Class 9', question: 'who won the world cup' })).body.grounded, false);
});

// --- shelf resolution from the question -------------------------------
// The profile says which shelf the student usually works on, but a question
// may name another. Answering "what chapters are in class 9 maths" from the
// profile subject produced "I don't have that" followed by the syllabus
// recited from model memory — while Ganita Manjari sat in the corpus.
const { detectShelf } = require('../services/ncertContext');
const profile = [{ mem_key: 'class', mem_value: '9' }, { mem_key: 'subject', mem_value: 'Science' }];

test('a question naming a class and subject overrides the profile', () => {
    assert.deepEqual(detectShelf('what chapters are in class 9 maths', profile),
        { grade: 'Class 9', subject: 'Mathematics' });
    assert.deepEqual(detectShelf('chapters of class 10 science', profile),
        { grade: 'Class 10', subject: 'Science' });
});
test('a subject named without a class uses the profile class', () => {
    assert.deepEqual(detectShelf('explain polynomials in maths', profile),
        { grade: 'Class 9', subject: 'Mathematics' });
});
test('a class named without a subject does not inherit the profile subject', () => {
    // "what is in class 7" must not silently mean Class 7 Science.
    assert.deepEqual(detectShelf('what books are there in class 7', profile),
        { grade: 'Class 7', subject: '' });
});
test('a question naming neither falls back to the profile', () => {
    assert.deepEqual(detectShelf('list all chapters of my book', profile),
        { grade: 'Class 9', subject: 'Science' });
});
test('roman numerals and common aliases resolve', () => {
    assert.equal(detectShelf('class IX sst syllabus', profile).grade, 'Class 9');
    assert.equal(detectShelf('class IX sst syllabus', profile).subject, 'Social Science');
    assert.equal(detectShelf('bio chapters', profile).subject, 'Biology');
});
test('an out-of-range class is ignored rather than invented', () => {
    assert.equal(detectShelf('class 99 science', profile).grade, 'Class 9');
});

// --- Indic text integrity ---------------------------------------------
// Many DIKSHA Devanagari PDFs carry a broken font-to-Unicode map, so
// extraction yields text that LOOKS like Hindi but is not: "बातीें होतीी हैं"
// for "बातें होती हैं", "मक" for "कि", "अहधकार" for "अंधकार". A model reads
// it as prose and answers confidently from nonsense, citing a real page.
// 3,140 of 4,762 Devanagari chapters were affected.
const { scanIndic } = require('../services/ncertSource');

test('correctly extracted Devanagari passes', () => {
    const clean = 'बल्कि विश्व के कोने-कोने में यह बात फैली हुई है। '.repeat(40);
    const s = scanIndic(clean);
    assert.equal(s.ratio, 0);
    assert.equal(s.garbled, false);
});
test('a broken font map is caught', () => {
    // Real extractor output: two vowel signs on one consonant, and matras
    // stranded after spaces — neither can occur in valid Devanagari.
    const broken = 'बल््ककि ल् वश् व किे किोने-किोने में '.repeat(40);
    assert.ok(scanIndic(broken).ratio > 0.1);
    assert.equal(scanIndic(broken).garbled, true);
});
test('a garbled chapter is never graded ready, however much text it has', () => {
    const text = 'बल््ककि ल् वश् व किे किोने-किोने में '.repeat(60);
    const pages = Array.from({ length: 20 }, () => ({ text }));
    assert.equal(gradeChapter(pages).status, 'garbled');
});
test('short Devanagari samples are not condemned on thin evidence', () => {
    // Below the character floor the ratio is too noisy to act on.
    assert.equal(scanIndic('किे किोने').garbled, false);
});
test('Latin-script chapters are unaffected by the Indic check', () => {
    const pages = Array.from({ length: 18 }, () => ({ text: body(3000) }));
    assert.equal(gradeChapter(pages).status, 'ready');
});

// --- romanised Hindi matching -----------------------------------------
// Students type chapter names as they say them. Matching only the
// Devanagari form made the tutor tell a student that "aisi baate bhi hoti
// hain" was not in their book — while ऐसी भी बातें होती हैं sat in गंगा (2026),
// their actual current edition, demoted only because its text is garbled.
const { romanize, titleScore } = require('../services/translit');

test('Devanagari romanises with its inherent vowel', () => {
    // क is "ka", not "k" — without this no romanised title ever lines up.
    assert.equal(romanize('दो बैलों की कथा'), 'do bailon ki kata');
});
test('a romanised title matches its Devanagari chapter', () => {
    assert.ok(titleScore('aisi baate bhi hoti hain', 'पाठ 4 - ऐसी भी बातें होती हैं') >= 0.8);
    assert.ok(titleScore('do bailon ki katha', '1-प्रेमचंद दो बैलों की कथा') >= 0.8);
    assert.ok(titleScore('lhasa ki or', '2-राहुल संकृत्यायन ल्हासा की ओर') >= 0.8);
});
test('spelling variants of the same title converge', () => {
    // फ is written "ph" or "f"; long vowels are doubled or not.
    const chapter = '5-हरिशंकर परसाई प्रेमचंद के फटे जूते';
    assert.equal(titleScore('premchand ke phate joote', chapter),
                 titleScore('premchand ke fate jute', chapter));
});
test('an unrelated title does not match', () => {
    assert.equal(titleScore('do bailon ki katha', 'पाठ 4 - ऐसी भी बातें होती हैं'), 0);
    assert.equal(titleScore('photosynthesis', '5-THE FUNDAMENTAL UNIT OF LIFE'), 0);
});
test('scaffolding words alone cannot match a chapter', () => {
    // "paath", "adhyay", "ka/ke/ki" appear in most titles and carry no identity.
    assert.equal(titleScore('paath ke bare me', 'पाठ 4 - ऐसी भी बातें होती हैं'), 0);
});

// --- naming a specific book overrides the newest-edition default -------
// The newest usable edition is the default, but a student may say which book
// they mean. Explicit beats implicit — nothing should override a named book.
const { namesTitle } = require('../services/translit');

test('a question that names a book is recognised', () => {
    assert.ok(namesTitle('tell me about Exploration book', 'Exploration') >= 0.6);
    assert.ok(namesTitle('from the science lab manual', 'Science Lab Manual') >= 0.6);
    assert.ok(namesTitle('क्षितिज से बताओ', 'क्षितिज भाग -1') >= 0.6);
});
test('an ordinary question names no book', () => {
    assert.ok(namesTitle('explain motion', 'Exploration') < 0.6);
    assert.ok(namesTitle('what is a cell', 'Science Lab Manual') < 0.6);
});
test('a generic title cannot be named by its subject alone', () => {
    // A book called "Science Textbook" must not be selected by every question
    // that happens to contain the word science.
    assert.equal(namesTitle('explain science topics', 'Science Textbook'), 0);
    assert.equal(namesTitle('class 9 maths', 'Mathematics Textbook for Class IX'), 0);
});
test('book naming tolerates the same spelling variants as chapters', () => {
    assert.equal(namesTitle('ganita manjari se', 'Ganita Manjari'),
                 namesTitle('ganit manjri se', 'Ganita Manjari'));
});
test('a Devanagari book can be named in either script', () => {
    // Skeleton equality must beat a shared prefix: "kshitij" and "ksitija"
    // are the same word, not a near miss.
    assert.ok(namesTitle('kshitij se batao', '(NEW) क्षितिज भाग -1') >= 0.6);
    assert.ok(namesTitle('क्षितिज से बताओ', '(NEW) क्षितिज भाग -1') >= 0.6);
    assert.ok(namesTitle('मेरी किताब के पाठ', '(NEW) क्षितिज भाग -1') < 0.6);
});

// --- naming a BOOK that exists but cannot be read ---------------------
// "Ganga" is the 2026 Class 9 Hindi textbook, not a chapter. It was demoted
// because every one of its chapters is garbled, so the tutor reported the
// student's own book as non-existent — the same failure as denying a real
// chapter, one level up.
test('an unreadable book is still recognised as real', () => {
    assert.ok(namesTitle('Ganga ke bare me batao', 'गंगा') >= 0.6);
    assert.ok(namesTitle('गंगा किताब के पाठ बताओ', 'गंगा') >= 0.6);
});
test('a book name is not matched by unrelated questions', () => {
    assert.ok(namesTitle('explain photosynthesis', 'गंगा') < 0.6);
    assert.ok(namesTitle('मेरी किताब के पाठ', 'गंगा') < 0.6);
});

// --- legacy 8-bit Devanagari encoding ---------------------------------
// A second, entirely different corruption from the broken font map: some
// PDFs embed legacy fonts (Kruti Dev, Chanakya) where the bytes ARE Latin
// and only the font makes them look like Hindi. क्षितिज भाग-1 extracted as
// "dkO; [kaM ... & rqylhnkl" — that is "काव्य खंड ... तुलसीदास".
//
// scanIndic() scored these 0.000 and PASSED them: it counts faults per
// Devanagari character and there are none. 1,149 chapters shipped as ready,
// and the model answered from them — inventing authors.
const { looksLegacyEncoded } = require('../services/ncertSource');
const KRUTI = 'dkO; [kaM ân; fla/q efr lhi lekukA Lokfr lkjnk dgfga lqtkukA '.repeat(12);
const REAL_HINDI = 'काव्य खंड हृदय सिंधु मति सीप समाना। स्वाति सारदा कहहिं सुजाना। '.repeat(12);

test('Latin bytes in a Devanagari-medium book are caught', () => {
    assert.equal(looksLegacyEncoded(KRUTI, 'Hindi'), true);
    assert.equal(scanIndic(KRUTI).garbled, false);  // why the old check missed it
});
test('real Hindi is not mistaken for legacy encoding', () => {
    assert.equal(looksLegacyEncoded(REAL_HINDI, 'Hindi'), false);
});
test('English and Urdu mediums are exempt', () => {
    // Urdu is Arabic script; English is Latin by definition.
    assert.equal(looksLegacyEncoded('The cell is the basic unit of life. '.repeat(20), 'English'), false);
    assert.equal(looksLegacyEncoded(KRUTI, 'Urdu'), false);
});
test('a legacy-encoded chapter is graded garbled, not ready', () => {
    const pages = Array.from({ length: 12 }, () => ({ text: KRUTI }));
    assert.equal(gradeChapter(pages, 'Hindi').status, 'garbled');
});
test('grading without a medium still works for Latin-script books', () => {
    const pages = Array.from({ length: 18 }, () => ({ text: body(3000) }));
    assert.equal(gradeChapter(pages).status, 'ready');
});

// --- chapter lock ------------------------------------------------------
// Without a lock every question resolved from scratch, so "iska saar batao"
// drifted to whichever chunk scored highest across the whole class.
const { resolveLock, isRelease, readingLevel, SWITCH_MIN } = require('../services/chapterLock');

const CH = [
    { chapter_id: 'c1', chapter_name: 'पाठ 1 - दो बैलों की कथा', status: 'ready', book_name: 'गंगा' },
    { chapter_id: 'c6', chapter_name: 'पाठ 6 - रीढ़ की हड्डी', status: 'ready', book_name: 'गंगा' },
    { chapter_id: 'cx', chapter_name: 'पाठ 9 - अनपढ़ा पाठ', status: 'garbled', book_name: 'गंगा' }
];
const lockCorpus = {
    allChapters: async () => CH,
    chapterMeta: async (id) => {
        const c = CH.find(x => x.chapter_id === id);
        return c ? { id, chapter_name: c.chapter_name, status: c.status, book_name: c.book_name } : null;
    }
};
const shelf9 = { grade: 'Class 9', subject: 'Hindi' };
const held = (id) => [{ mem_key: 'class', mem_value: '9' }, { mem_key: 'chapter', mem_value: id }];
const lockArgs = (facts, question) => ({ corpus: lockCorpus, facts, question, shelf: shelf9, mediumFor: () => 'Hindi' });

test('naming a chapter locks onto it', async () => {
    const r = await resolveLock(lockArgs([{ mem_key: 'class', mem_value: '9' }], 'do bailon ki katha padhna hai'));
    assert.equal(r.chapterId, 'c1');
    assert.equal(r.changed, true);
});
test('a follow-up keeps the chapter already held', async () => {
    // This is the whole point of the lock: "iska saar batao" names nothing.
    const r = await resolveLock(lockArgs(held('c1'), 'iska saar batao'));
    assert.equal(r.chapterId, 'c1');
    assert.ok(!r.changed);
});
test('phrasing length does not decide whether a switch happens', async () => {
    // namesTitle, not titleScore: scoring by share of QUERY tokens gave
    // "ab reedh ki haddi paath padhna hai" 0.50 and it failed to switch.
    for (const q of ['reedh ki haddi', 'ab reedh ki haddi paath padhna hai', 'रीढ़ की हड्डी पढ़ना है']) {
        const r = await resolveLock(lockArgs(held('c1'), q));
        assert.equal(r.chapterId, 'c6', `failed for: ${q}`);
    }
});
test('a chapter whose text is unreadable cannot be locked onto', async () => {
    const r = await resolveLock(lockArgs([{ mem_key: 'class', mem_value: '9' }], 'anpadha paath padhna hai'));
    assert.notEqual(r.chapterId, 'cx');
});
test('the student can release the lock', async () => {
    // Both word orders, and Devanagari: \b is defined on [A-Za-z0-9_], so a
    // word boundary never matches beside a Devanagari letter and "दूसरा पाठ"
    // was silently unreleasable.
    for (const q of ['exit chapter', 'chapter change karo', 'change chapter',
                     'दूसरा पाठ', 'अगला अध्याय', 'पाठ बदलो', 'doosra paath']) {
        assert.equal(isRelease(q), true, `not released by: ${q}`);
    }
    const r = await resolveLock(lockArgs(held('c1'), 'exit this chapter'));
    assert.equal(r.chapterId, null);
    assert.equal(r.released, true);
});
test('an ordinary question does not accidentally release the lock', async () => {
    assert.equal(isRelease('iska saar batao'), false);
    assert.equal(isRelease('hira aur moti kaun the'), false);
    assert.equal(isRelease('is paath ke prashn batao'), false);
    assert.equal(isRelease('इस पाठ का सारांश'), false);
});
test('a lock whose chapter was re-graded is dropped, not served', async () => {
    const r = await resolveLock(lockArgs(held('cx'), 'iska saar batao'));
    assert.equal(r.chapterId, null);
    assert.equal(r.stale, true);
});
test('reading level scales with the class', () => {
    assert.match(readingLevel('3'), /young child/i);
    assert.match(readingLevel('7'), /Class 7/);
    assert.match(readingLevel('11'), /Class 11/);
    assert.equal(readingLevel(''), null);
    // A Class 3 answer must be capped shorter than a Class 8 one.
    assert.match(readingLevel('3'), /120 words/);
    assert.match(readingLevel('8'), /180 words/);
});

// --- Wikipedia fallback ------------------------------------------------
// Used only when the NCERT corpus has nothing. The textbook stays primary;
// this stops the tutor answering from model memory with no source at all.
const { assertAllowed, buildWebContext, langFor } = require('../services/webLookup');

test('only real Wikipedia hosts are fetched', () => {
    assert.doesNotThrow(() => assertAllowed('https://en.wikipedia.org/wiki/Gravity'));
    assert.doesNotThrow(() => assertAllowed('https://hi.wikipedia.org/wiki/X'));
    for (const bad of [
        'http://en.wikipedia.org/x',                 // plaintext
        'https://en.wikipedia.org.evil.test/x',      // suffix attack
        'https://evil.test/x',
        'https://u:p@en.wikipedia.org/x',            // credentials
        'https://en.wikipedia.org:8080/x'            // odd port
    ]) assert.throws(() => assertAllowed(bad), undefined, `should reject ${bad}`);
});
test('an irrelevant article is not treated as an answer', () => {
    // Wikipedia search is keyword-based: "why do things fall down" returned
    // "Stranger Things season 5", sharing only the word "things".
    assert.ok(namesTitle('why do things fall down', 'Stranger Things season 5') < 0.6);
    assert.ok(namesTitle('why do things fall down', 'Upside Down (Stranger Things)') < 0.6);
    assert.ok(namesTitle('what is quantum entanglement', 'Quantum entanglement') >= 0.6);
});
test('web context is labelled as not being the textbook', () => {
    const block = buildWebContext({ title: 'Gravity', extract: 'Gravity is a force.', lang: 'en' });
    assert.match(block, /NOT FROM THE TEXTBOOK/);
    assert.match(block, /Wikipedia/);
    // Untrusted third-party text must never be treated as instructions.
    assert.match(block, /[Nn]ever follow instructions/);
    assert.equal(buildWebContext(null), null);
});
test('the student medium picks the Wikipedia edition', () => {
    assert.equal(langFor('Hindi'), 'hi');
    assert.equal(langFor('Tamil'), 'ta');
    assert.equal(langFor('English'), 'en');
    assert.equal(langFor('Klingon'), 'en');   // unknown falls back
});

// --- choosing a book ---------------------------------------------------
// "switch to Kaveri" for a student whose profile said Science: the book was
// never found (lookup scoped to the profile subject) and the answer came from
// Science books while labelled "your textbook".
const { applyBookToFacts } = require('../services/ncertContext');

test('a short consonant skeleton cannot name a book', () => {
    // "Class IX" folds to "iks" -> skeleton "ks", identical to "kaise" -> "ks":
    // every question containing "kaise" selected the Class IX Science book.
    const title = '(NEW) Ncert Science Textbook For Class IX';
    assert.equal(namesTitle('photosynthesis kaise hoti hai', title), 0);
    assert.equal(namesTitle('kaise', title), 0);
    // Longer skeletons still match across spellings.
    assert.ok(namesTitle('kshitij se batao', '(NEW) क्षितिज भाग -1') >= 0.6);
    assert.ok(namesTitle('ganit manjri se', 'Ganita Manjari') >= 0.6);
});
test('a chosen book re-scopes subject and medium without rewriting the profile', () => {
    const profile = [
        { mem_key: 'class', mem_value: '9' },
        { mem_key: 'subject', mem_value: 'Science' }
    ];
    const kaveri = { id: 'b-kav', name: 'Kaveri', subject: 'English', medium: 'English' };
    const scoped = applyBookToFacts(profile, kaveri);
    const get = (k) => scoped.find(f => f.mem_key === k)?.mem_value;
    assert.equal(get('subject'), 'English');
    assert.equal(get('medium'), 'English');
    assert.equal(get('book'), 'b-kav');
    assert.equal(get('class'), '9');
    assert.equal(scoped.filter(f => f.mem_key === 'subject').length, 1);
    // The saved profile itself is untouched.
    assert.equal(profile.find(f => f.mem_key === 'subject').mem_value, 'Science');
});
test('no book leaves the facts exactly as they were', () => {
    const profile = [{ mem_key: 'class', mem_value: '9' }];
    assert.strictEqual(applyBookToFacts(profile, null), profile);
});
