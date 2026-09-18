// ================================================================
// Chat tools — the study tools, usable from inside the conversation
// ----------------------------------------------------------------
// "Make me a worksheet on integers", "quiz me on photosynthesis",
// "flashcards for this chapter" run the real tool and come back as an
// interactive card in the chat, instead of a wall of text the student
// then has to copy into another screen.
//
// Provenance rules carried over from the Verified Source Library:
//   * Worksheet questions come from the library FIRST — real NCERT
//     Exemplar questions with citations built from database rows.
//   * Anything the model writes is labelled as AI-written, and never
//     carries a book, page or question number.
// Grading and explanations are always the model's, and say so.
// ================================================================
const { generateJSON, generateText } = require('./ai');
// The 50 tools of the Tools screen, with the prompt each one already uses.
// Requiring the catalogue keeps one definition per tool instead of a second
// copy that drifts from the screen the student sees.
let CATALOG = [];
try {
    CATALOG = require('../../frontend/data.js').toolsData || [];
} catch (e) {
    console.warn('[CHAT TOOL] tool catalogue unavailable:', e.message);
}
const { searchQuestions } = require('./sourceLibrary/search');
const { toCard } = require('./sourceLibrary/libraryAnswer');

const AI_LABEL = 'AI-written practice — not from an NCERT book';
const LIBRARY_LABEL = 'Real NCERT Exemplar questions with verified sources';

// A tool is asked for by name. The verb is optional for the nouns that
// mean nothing else ("worksheet"), required for the ones that do
// ("notes on photosynthesis" is a question, "make notes" is a tool).
const MAKE = /\b(make|create|generate|give|get|build|prepare|draft|design|set|banao|bana\s?do|de\s?do|chahiye)\b/i;
const TOOL_PATTERNS = [
    { tool: 'worksheet', needsVerb: false, re: /\b(worksheet|work\s?sheet|practice\s+sheet|question\s+paper|assignment\s+sheet|homework\s+sheet|practice\s+set)\b/i },
    { tool: 'quiz', needsVerb: false, re: /\b(quiz|mcq\s+test|mock\s+test|test\s+me|quiz\s+me)\b/i },
    { tool: 'flashcards', needsVerb: false, re: /\b(flash\s?cards?|revision\s+cards?)\b/i },
    { tool: 'mindmap', needsVerb: false, re: /\b(mind\s?map|concept\s?map|flow\s?chart)\b/i },
    { tool: 'notes', needsVerb: true, re: /\b(revision\s+notes|short\s+notes|study\s+notes|notes|summary|summarise|summarize)\b/i }
];
const SLASH = { '/quiz': 'quiz', '/flashcards': 'flashcards', '/notes': 'notes', '/summary': 'notes', '/worksheet': 'worksheet', '/mindmap': 'mindmap' };

// "10 questions", and also "5 hard questions" / "8 practice problems".
const COUNT = /\b(\d{1,2})\s+(?:[a-z]+\s+){0,2}?(?:questions?|ques|qs?|problems?|mcqs?|cards?|items?)\b|\b(\d{1,2})(?:questions?|qs?|cards?)\b/i;
const CLASS_IN_TEXT = /\b(?:class|grade|std|kaksha)\s*([1-9]|1[0-2])\b/i;
const countIn = (text) => { const m = String(text || '').match(COUNT); return m ? (m[1] || m[2]) : undefined; };
const DIFFICULTY = [
    [/\b(very\s+hard|hardest|toughest|board\s+level|competitive|olympiad)\b/i, 'Hard'],
    [/\b(hard|difficult|tough|challenging|advanced)\b/i, 'Hard'],
    [/\b(easy|simple|basic|beginner|starter)\b/i, 'Easy'],
    [/\b(medium|moderate|average)\b/i, 'Medium']
];
const MORE = /\b(\d{1,2}\s+)?(more|another|again|next\s+set|one\s+more|and\s+more)\b/i;
const HARDER = /\b(harder|tougher|more\s+difficult|next\s+level)\b/i;
const EASIER = /\b(easier|simpler|lighter)\b/i;
const LAST_TOOL_KEY = 'last_tool';

const CAPS = { worksheet: [3, 20, 8], quiz: [3, 15, 5], flashcards: [4, 20, 10], notes: [1, 1, 1], mindmap: [1, 1, 1] };

function clampCount(tool, wanted) {
    const [min, max, def] = CAPS[tool] || [3, 15, 5];
    const n = parseInt(wanted, 10);
    if (!Number.isFinite(n)) return def;
    return Math.min(Math.max(n, min), max);
}

// Strip the tool words so what remains is the topic the student named.
// "make me a worksheet on integers with 10 questions" is the topic
// "integers": the verbs, the tool noun and the count all come out, then
// leftover filler is trimmed from each end ("me a integers with" was the
// first attempt at this).
const EDGE_FILLER = new Set(['me', 'my', 'us', 'it', 'a', 'an', 'the', 'some', 'any', 'this', 'that', 'these', 'those',
    'on', 'about', 'of', 'from', 'for', 'with', 'in', 'to', 'by', 'and', 'please', 'pls', 'now', 'ka', 'ke', 'ki', 'par',
    'based', 'related', 'topic', 'chapter', 'ek', 'mujhe', 'karo', 'kar', 'do', 'dedo', 'chahiye', 'banado']);
function topicOf(text, tool) {
    const pattern = TOOL_PATTERNS.find(p => p.tool === tool);
    let t = String(text || '')
        .replace(/^\/[a-z]+\s*/i, '')
        .replace(new RegExp(pattern.re.source, 'gi'), ' ')
        .replace(new RegExp(COUNT.source, 'gi'), ' ')
        .replace(new RegExp(CLASS_IN_TEXT.source, 'gi'), ' ')
        .replace(new RegExp(MAKE.source, 'gi'), ' ')
        .replace(/\b(questions?|cards?|marks?|difficulty|level|easy|medium|hard|difficult|tough|challenging|advanced|simple|basic|mcqs?|multiple\s+choice|objective|true\s*(?:or|\/)?\s*false|short\s+answer)\b/gi, ' ')
        .replace(/[?.!,;:]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    let words = t.split(' ').filter(Boolean);
    while (words.length && EDGE_FILLER.has(words[0].toLowerCase())) words.shift();
    while (words.length && EDGE_FILLER.has(words[words.length - 1].toLowerCase())) words.pop();
    t = words.join(' ');
    return t.length >= 3 ? t : '';
}

/**
 * What tool (if any) is this message asking for?
 * @returns null | { tool, topic, count, difficulty, followUp }
 */
function detectTool(text, { lastTool = null } = {}) {
    const raw = String(text || '').trim();
    if (!raw) return null;

    const slashKey = Object.keys(SLASH).find(k => raw.toLowerCase().startsWith(k));
    let hit = slashKey ? { tool: SLASH[slashKey], needsVerb: false } : null;
    if (!hit) {
        for (const p of TOOL_PATTERNS) {
            if (!p.re.test(raw)) continue;
            if (p.needsVerb && !MAKE.test(raw)) continue;
            hit = p;
            break;
        }
    }

    // "5 more", "make it harder" continue the tool that is already on screen.
    if (!hit && lastTool && lastTool.tool && (MORE.test(raw) || HARDER.test(raw) || EASIER.test(raw)) && raw.length <= 60) {
        const bump = HARDER.test(raw) ? 'Hard' : EASIER.test(raw) ? 'Easy' : lastTool.difficulty;
        return {
            tool: lastTool.tool,
            topic: lastTool.topic || '',
            count: clampCount(lastTool.tool, countIn(raw) || (raw.match(/\b(\d{1,2})\s+more\b/i) || [])[1] || lastTool.count),
            classLevel: lastTool.classLevel || null,
            seenIds: Array.isArray(lastTool.seenIds) ? lastTool.seenIds : [],
            difficulty: bump || 'Medium',
            followUp: true
        };
    }
    if (!hit) return null;

    const difficulty = (DIFFICULTY.find(([re]) => re.test(raw)) || [null, 'Medium'])[1];
    const topic = topicOf(raw, hit.tool) || (lastTool && lastTool.topic) || '';
    // A class named in the message wins over the one on the profile: a student
    // revising last year's chapter asks for it by name.
    const named = raw.match(CLASS_IN_TEXT);
    return {
        tool: hit.tool,
        topic,
        count: clampCount(hit.tool, countIn(raw)),
        difficulty,
        classLevel: named ? named[1] : null,
        type: worksheetType(raw),
        followUp: false
    };
}

// The class and book the conversation is already on, so a tool asked for
// with no details ("make a worksheet") follows the chapter being studied.
function contextOf(facts = []) {
    const factOf = (k) => (facts.find(f => f.mem_key === k) || {}).mem_value || '';
    const cls = String(factOf('class') || factOf('grade') || '').match(/\d{1,2}/);
    return {
        classLevel: cls ? cls[0] : null,
        chapter: factOf('chapter_lock_label') || factOf('chapter_lock') || '',
        book: factOf('book') || '',
        subject: factOf('subject') || ''
    };
}

function lastToolOf(facts = []) {
    const raw = (facts.find(f => f.mem_key === LAST_TOOL_KEY) || {}).mem_value;
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
}

function levelLine(classLevel) {
    const n = Number(classLevel);
    if (!n) return 'Use clear, simple English.';
    if (n <= 5) return `Write for a Class ${n} child: very short sentences, everyday words, numbers kept small.`;
    if (n <= 8) return `Write for a Class ${n} student: simple English, one idea per question, no unexplained jargon.`;
    if (n <= 10) return `Write for a Class ${n} student at CBSE board level: precise but plain language.`;
    return `Write for a Class ${n} student: exam-level precision is fine, but keep the wording plain.`;
}

function describe(ctx, spec) {
    const bits = [];
    if (ctx.classLevel) bits.push(`Class ${ctx.classLevel}`);
    if (ctx.subject) bits.push(ctx.subject);
    const where = spec.topic || ctx.chapter || ctx.book;
    if (where) bits.push(where);
    return bits.join(' · ');
}

// ── Live steps ──────────────────────────────────────────────────────
// Each builder reports what it is doing AS it does it — "Searching the
// verified library…", "Writing 5 multiple-choice questions…" — so the chat
// shows the work in progress rather than a spinner. `ctx.step` is the
// request's live progress feed; the same lines are kept for the finished
// card's collapsed list.
function reporter(ctx) {
    const lines = [];
    const say = (text) => {
        lines.push(text);
        if (typeof ctx.step === 'function') ctx.step(text);
    };
    return { say, lines };
}

// Library questions print their options inside the text: "Which of these
// is not true? (a) … (b) … (c) … (d) …". Split them out so the question is
// answered by picking an option, as on the Worksheet Generator. Only an
// exact (a)(b)(c)(d) run is split; anything else stays a written answer, and
// the full original text is kept for the citation and for marking.
// Parts (a)–(d) are also how a multi-part question is printed ("Evaluate:
// (a) … (b) …"), and turning those into options would change the question.
// So a split happens only for a question that IS multiple choice: filed
// under a multiple-choice section, or asking the student to pick.
const PICK_ONE = /which\s+of\s+the\s+following|which\s+one|choose\s+the|select\s+the|correct\s+(?:answer|option|statement)|is\s+equal\s+to|_{3,}|\?\s*$|\b(?:is|are|was|were|be|of|by|as|to)\s*[:.]?\s*$/i;
function splitOptions(text, section) {
    const t = String(text || '');
    const marks = [...t.matchAll(/\(\s*([a-dA-D])\s*\)/g)];
    if (marks.length < 2 || marks.length > 4) return null;
    const letters = marks.map(m => m[1].toLowerCase()).join('');
    if (!'abcd'.startsWith(letters)) return null;
    const stem = t.slice(0, marks[0].index).trim();
    if (stem.length < 8) return null;
    const mcqSection = /multiple\s*choice|mcq|objective/i.test(String(section || ''));
    if (!mcqSection && !PICK_ONE.test(stem)) return null;
    const options = marks.map((m, i) => t.slice(m.index + m[0].length, i + 1 < marks.length ? marks[i + 1].index : undefined).trim());
    if (options.some(o => !o || o.length > 220)) return null;
    // An instruction inside an option ("Write two integers…") is a sub-question.
    if (options.some(o => /^(write|find|draw|show|prove|evaluate|calculate|explain|give|state)\b/i.test(o))) return null;
    return { stem, options };
}

const WS_TYPES = { mcq: 'Multiple Choice', truefalse: 'True/False', short: 'Short Answer' };
function worksheetType(raw) {
    const t = String(raw || '').toLowerCase();
    if (/true\s*(?:or|\/|-)?\s*false|t\/f/.test(t)) return 'truefalse';
    if (/short\s+answer|written|subjective|long\s+answer/.test(t)) return 'short';
    if (/mcq|multiple\s+choice|objective|options/.test(t)) return 'mcq';
    return ['mcq', 'truefalse', 'short'].includes(t) ? t : null;
}

// ── Worksheet ───────────────────────────────────────────────────────
// Library first: real questions, real citations. The model is asked only
// when the library has nothing for this class and topic.
async function buildWorksheet(spec, ctx, { facts, weakTopics, report }) {
    const { say } = report;
    const where = spec.topic || ctx.chapter || 'this class';
    const query = [ctx.classLevel ? `class ${ctx.classLevel}` : '', ctx.subject, spec.topic || ctx.chapter, `${spec.count} questions`]
        .filter(Boolean).join(' ');
    const seen = new Set((spec.seenIds || []).map(Number));
    let cards = [];
    let repeated = false;
    // A True/False or short-answer sheet asked for by type is written to that
    // format; the library supplies the rest.
    const wantsLibrary = spec.type !== 'truefalse';
    if (wantsLibrary) {
        say(`Searching 15,000 verified NCERT Exemplar questions for "${where}"${ctx.classLevel ? `, Class ${ctx.classLevel}` : ''}`);
        try {
            // Ask for enough to still have a full sheet after dropping the ones
            // this student has already been given: "5 more" must mean 5 new ones.
            const found = await searchQuestions(query, { facts, weakTopics, limit: spec.count + seen.size });
            const all = (found.results || []).map(r => toCard(r.row, r.reasons));
            const fresh = all.filter(c => !seen.has(Number(c.id)));
            cards = fresh.length >= Math.min(3, spec.count) ? fresh : all;
            repeated = cards === all && seen.size > 0 && fresh.length < Math.min(3, spec.count);
            say(fresh.length
                ? `Found ${fresh.length} matching question${fresh.length === 1 ? '' : 's'} in ${found.chapter || 'the library'} you have not seen yet`
                : 'No verified questions matched this topic');
        } catch (e) {
            say('The verified library was unavailable');
        }
    }

    if (cards.length >= Math.min(3, spec.count)) {
        say('Checking each question\'s source and splitting out its answer options');
        const items = cards.slice(0, spec.count).map((c, i) => {
            const split = spec.type === 'short' ? null : splitOptions(c.questionText, c.section);
            return {
                n: i + 1,
                id: c.id,
                questionText: c.questionText,
                stem: split ? split.stem : null,
                options: split ? split.options : [],
                provenance: 'library',
                section: c.section || null,
                chapter: c.chapter || null,
                citation: c.citation || null,
                recommendation: c.recommendation || null
            };
        });
        say(`Laid out ${items.length} questions — ${items.filter(i => i.options.length).length} with answer options`);
        return {
            tool: 'worksheet',
            title: `${where.charAt(0).toUpperCase()}${where.slice(1)} worksheet`,
            meta: { classLevel: ctx.classLevel, subject: ctx.subject || null, chapter: spec.topic || ctx.chapter || null,
                    count: items.length, difficulty: spec.difficulty, type: spec.type || 'mcq',
                    source: 'library', sourceLabel: LIBRARY_LABEL, engine: 'Verified NCERT Exemplar' },
            items,
            ids: items.map(i => i.id).filter(Boolean),
            notice: repeated
                ? 'You have now seen every verified question the library holds for this topic, so these come round again.'
                : items.length < spec.count
                    ? `The library had ${items.length} verified question${items.length === 1 ? '' : 's'} for this topic, so the worksheet is that long.`
                    : null
        };
    }

    // The Worksheet Generator's own format: every question carries its
    // options and its correct answer, so it can be marked the same way.
    const type = spec.type || 'mcq';
    const typeLine = type === 'mcq'
        ? 'Every question MUST have an "options" array of exactly 4 distinct choices. Do not put option letters or choices inside the question text.'
        : type === 'truefalse'
            ? 'Every question is a statement, and "options" MUST be ["True", "False"].'
            : 'Short-answer questions: "options" is an empty array.';
    say(`Writing ${spec.count} ${WS_TYPES[type].toLowerCase()} questions on "${where}" (${spec.difficulty})`);
    const data = await generateJSON(
        `Generate a ${spec.count}-question worksheet${ctx.classLevel ? ` for Class ${ctx.classLevel} students` : ''} about "${spec.topic || ctx.chapter || ctx.subject || 'the current chapter'}".
The question type is "${WS_TYPES[type]}" and the difficulty is "${spec.difficulty}".
${levelLine(ctx.classLevel)}
Follow the NCERT syllabus for that class. ${typeLine}
Never mention a book name, page number, exercise number or question number from any book.
Respond ONLY with JSON: {"questions":[{"question":"...","options":[...],"correct_answer":"...","explanation":"one line"}]}`,
        'You are a teacher writing a worksheet. Respond ONLY with valid JSON.',
        { task: 'general' }, null);

    const list = Array.isArray(data && data.questions) ? data.questions.filter(q => q && q.question) : [];
    if (!list.length) { say('The model did not return usable questions'); return null; }
    say('Built the answer key so the sheet can be marked');
    return {
        tool: 'worksheet',
        title: `${where.charAt(0).toUpperCase()}${where.slice(1)} worksheet`,
        meta: { classLevel: ctx.classLevel, subject: ctx.subject || null, chapter: spec.topic || ctx.chapter || null,
                count: list.length, difficulty: spec.difficulty, type,
                source: 'ai', sourceLabel: AI_LABEL, engine: 'GPT-OSS 120B' },
        items: list.slice(0, spec.count).map((q, i) => ({
            n: i + 1,
            questionText: String(q.question),
            options: Array.isArray(q.options) ? q.options.map(String).filter(Boolean).slice(0, 4) : [],
            correctAnswer: q.correct_answer ? String(q.correct_answer) : null,
            explanation: q.explanation ? String(q.explanation) : null,
            provenance: 'ai',
            citation: null
        })),
        notice: null
    };
}

// ── Quiz ────────────────────────────────────────────────────────────
// Needs an answer key to score instantly, and the library holds questions
// only — no answers — so a quiz is always AI-written and labelled.
async function buildQuiz(spec, ctx, { report }) {
    report.say(`Writing a ${spec.count}-question ${spec.difficulty.toLowerCase()} quiz on "${spec.topic || ctx.chapter || ctx.subject || 'this chapter'}"`);
    const data = await generateJSON(
        `Create a ${spec.count}-question multiple-choice quiz (difficulty: ${spec.difficulty}) on "${spec.topic || ctx.chapter || ctx.subject || 'the current chapter'}"${ctx.classLevel ? ` for Class ${ctx.classLevel}` : ''}.
${levelLine(ctx.classLevel)}
Exactly 4 options per question, one clearly correct, plus a one-sentence explanation.
Never cite a book, page or exercise number.
Respond ONLY with JSON: {"questions":[{"question":"...","options":["A","B","C","D"],"correctIndex":0,"explanation":"..."}]}`,
        'You are an expert quiz writer for Indian school students. Respond ONLY with valid JSON.',
        { task: 'general' }, null);

    const list = Array.isArray(data && data.questions)
        ? data.questions.filter(q => q && q.question && Array.isArray(q.options) && q.options.length === 4 && Number.isInteger(q.correctIndex))
        : [];
    if (!list.length) return null;
    report.say('Checked every question has 4 options and one right answer');
    return {
        tool: 'quiz',
        title: `Quiz · ${describe(ctx, spec) || 'Practice'}`,
        meta: { classLevel: ctx.classLevel, subject: ctx.subject || null, chapter: spec.topic || ctx.chapter || null,
                count: list.length, difficulty: spec.difficulty, source: 'ai', sourceLabel: AI_LABEL },
        items: list.slice(0, spec.count).map((q, i) => ({
            n: i + 1,
            questionText: String(q.question),
            options: q.options.map(String),
            correctIndex: Math.min(Math.max(q.correctIndex, 0), 3),
            explanation: q.explanation ? String(q.explanation) : '',
            provenance: 'ai'
        })),
        notice: null
    };
}

// ── Flashcards ──────────────────────────────────────────────────────
async function buildFlashcards(spec, ctx, { report }) {
    report.say(`Writing ${spec.count} flashcards on "${spec.topic || ctx.chapter || ctx.subject || 'this chapter'}"`);
    const data = await generateJSON(
        `Write ${spec.count} spaced-repetition flashcards on "${spec.topic || ctx.chapter || ctx.subject || 'the current chapter'}"${ctx.classLevel ? ` for Class ${ctx.classLevel}` : ''}.
${levelLine(ctx.classLevel)}
One idea per card. Question under 15 words, answer 1-2 short sentences.
Respond ONLY with JSON: {"cards":[{"question":"...","answer":"..."}]}`,
        'You write crisp, memorable flashcards. Respond ONLY with valid JSON.',
        { task: 'general' }, null);

    const list = Array.isArray(data && data.cards) ? data.cards.filter(c => c && c.question && c.answer) : [];
    if (!list.length) return null;
    return {
        tool: 'flashcards',
        title: `Flashcards · ${describe(ctx, spec) || 'Revision'}`,
        meta: { classLevel: ctx.classLevel, subject: ctx.subject || null, chapter: spec.topic || ctx.chapter || null,
                count: list.length, difficulty: spec.difficulty, source: 'ai', sourceLabel: AI_LABEL },
        items: list.slice(0, spec.count).map((c, i) => ({ n: i + 1, question: String(c.question), answer: String(c.answer), provenance: 'ai' })),
        notice: null
    };
}

// ── Notes and mind map ──────────────────────────────────────────────
async function buildNotes(spec, ctx, { report }) {
    report.say(`Writing revision notes on "${spec.topic || ctx.chapter || ctx.subject || 'this chapter'}" — sections, key terms, common mistakes`);
    const data = await generateJSON(
        `Write revision notes on "${spec.topic || ctx.chapter || ctx.subject || 'the current chapter'}"${ctx.classLevel ? ` for Class ${ctx.classLevel}` : ''}.
${levelLine(ctx.classLevel)}
Give 4-7 sections. Each section has a heading and 2-4 one-line points. Add up to 6 key terms with a short meaning each, and 3 things students most often get wrong.
Respond ONLY with JSON: {"sections":[{"heading":"...","points":["..."]}],"terms":[{"term":"...","meaning":"..."}],"mistakes":["..."]}`,
        'You write tight, exam-ready revision notes for Indian school students. Respond ONLY with valid JSON.',
        { task: 'general' }, null);

    const sections = Array.isArray(data && data.sections) ? data.sections.filter(s => s && s.heading) : [];
    if (!sections.length) return null;
    return {
        tool: 'notes',
        title: `Revision notes · ${describe(ctx, spec) || 'Summary'}`,
        meta: { classLevel: ctx.classLevel, subject: ctx.subject || null, chapter: spec.topic || ctx.chapter || null,
                count: sections.length, difficulty: spec.difficulty, source: 'ai', sourceLabel: 'AI-written notes' },
        sections: sections.map(s => ({ heading: String(s.heading), points: (Array.isArray(s.points) ? s.points : []).map(String).slice(0, 5) })),
        terms: (Array.isArray(data.terms) ? data.terms : []).filter(t => t && t.term).slice(0, 8)
            .map(t => ({ term: String(t.term), meaning: String(t.meaning || '') })),
        mistakes: (Array.isArray(data.mistakes) ? data.mistakes : []).map(String).slice(0, 5),
        items: [],
        notice: null
    };
}

async function buildMindmap(spec, ctx, { report }) {
    const subject = spec.topic || ctx.chapter || ctx.subject || 'the current chapter';
    report.say(`Breaking "${subject}" into branches for a mind map`);
    const data = await generateJSON(
        `Break "${subject}"${ctx.classLevel ? ` (Class ${ctx.classLevel})` : ''} into a mind map: one centre, 4-6 branches, each with 2-4 short leaves.
${levelLine(ctx.classLevel)}
Keep every label under 6 words. No punctuation except letters, numbers, spaces and hyphens.
Respond ONLY with JSON: {"centre":"...","branches":[{"label":"...","leaves":["..."]}]}`,
        'You turn school topics into clean mind maps. Respond ONLY with valid JSON.',
        { task: 'general' }, null);

    const branches = Array.isArray(data && data.branches) ? data.branches.filter(b => b && b.label) : [];
    if (!branches.length) return null;
    // Labels go into Mermaid source, so anything that could break the syntax
    // (quotes, brackets, semicolons) is dropped rather than escaped.
    const clean = (s) => String(s || '').replace(/[^A-Za-z0-9 À-ɏऀ-ॿ-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const centre = clean(data.centre) || clean(subject) || 'Topic';
    const lines = ['mindmap', `  root((${centre}))`];
    branches.slice(0, 6).forEach((b, i) => {
        const label = clean(b.label) || `Branch ${i + 1}`;
        lines.push(`    ${label}`);
        (Array.isArray(b.leaves) ? b.leaves : []).slice(0, 4).forEach((leaf) => {
            const l = clean(leaf);
            if (l) lines.push(`      ${l}`);
        });
    });
    return {
        tool: 'mindmap',
        title: `Mind map · ${describe(ctx, spec) || centre}`,
        meta: { classLevel: ctx.classLevel, subject: ctx.subject || null, chapter: spec.topic || ctx.chapter || null,
                count: branches.length, difficulty: spec.difficulty, source: 'ai', sourceLabel: 'AI-written mind map' },
        mermaid: lines.join('\n'),
        items: [],
        notice: null
    };
}

const BUILDERS = { worksheet: buildWorksheet, quiz: buildQuiz, flashcards: buildFlashcards, notes: buildNotes, mindmap: buildMindmap };

const OPENERS = {
    worksheet: (p) => `Here is your worksheet${p ? ` on ${p}` : ''} — answer it in the card below and I'll check it.`,
    quiz: (p) => `Quiz ready${p ? ` on ${p}` : ''} — tap an option and you'll see straight away if it's right.`,
    flashcards: (p) => `Flashcards ready${p ? ` for ${p}` : ''} — tap a card to flip it.`,
    notes: (p) => `Revision notes${p ? ` on ${p}` : ''} are below. Save them to your notebook if they help.`,
    mindmap: (p) => `Here's the mind map${p ? ` for ${p}` : ''}.`
};

/**
 * Run a tool if this message is asking for one.
 * @param text   the student's message
 * @param ctx    { facts, weakTopics, remember(key, value) }
 * @returns null when no tool was asked for, otherwise { reply, tool, steps }
 */
async function runChatTool(text, ctx = {}) {
    const facts = ctx.facts || [];
    const spec = detectTool(text, { lastTool: lastToolOf(facts) });
    if (spec) return runToolSpec(spec, ctx);
    // Not one of the five interactive tools — try the rest of the catalogue.
    return runCatalogTool(String(text || ''), ctx);
}

/** Run a tool from an explicit spec — the card's own "5 more" / "harder" buttons. */
async function runToolSpec(rawSpec, ctx = {}) {
    const facts = ctx.facts || [];
    const spec = {
        tool: rawSpec.tool,
        topic: String(rawSpec.topic || '').slice(0, 120),
        count: clampCount(rawSpec.tool, rawSpec.count),
        difficulty: ['Easy', 'Medium', 'Hard'].includes(rawSpec.difficulty) ? rawSpec.difficulty : 'Medium',
        classLevel: String(rawSpec.classLevel || '').match(/^([1-9]|1[0-2])$/) ? String(rawSpec.classLevel) : null,
        seenIds: Array.isArray(rawSpec.seenIds) ? rawSpec.seenIds.map(Number).filter(Number.isFinite).slice(0, 40) : [],
        type: worksheetType(rawSpec.type),
        followUp: Boolean(rawSpec.followUp)
    };
    if (!BUILDERS[spec.tool]) return null;

    const context = contextOf(facts);
    if (spec.classLevel) context.classLevel = spec.classLevel;
    const build = BUILDERS[spec.tool];
    const report = reporter(ctx);
    const TOOL_NAMES = { worksheet: 'Worksheet Generator', quiz: 'Quiz Generator', flashcards: 'Flashcard Maker', notes: 'Revision Notes', mindmap: 'Mindmap Creator' };
    report.say(`Opened ${TOOL_NAMES[spec.tool] || spec.tool}${context.classLevel ? ` for Class ${context.classLevel}` : ''}${context.subject ? ` ${context.subject}` : ''}`);
    if (spec.followUp) report.say('Carrying on from the last one in this chat');
    const payload = await build(spec, context, { facts, weakTopics: ctx.weakTopics || [], report });
    if (!payload) return null;
    report.say('Ready');

    // Remembered so "5 more" or "make it harder" continues this tool.
    if (typeof ctx.remember === 'function') {
        const served = [...(spec.seenIds || []), ...(payload.ids || [])].filter(Number.isFinite);
        await ctx.remember(LAST_TOOL_KEY, JSON.stringify({
            tool: spec.tool, topic: spec.topic || context.chapter || '', count: payload.meta.count,
            difficulty: spec.difficulty, classLevel: context.classLevel || null,
            seenIds: served.slice(-30)
        })).catch(() => {});
    }

    const opener = OPENERS[spec.tool](spec.topic || context.chapter || '');
    payload.steps = report.lines;
    return {
        reply: payload.notice ? `${opener}\n\n${payload.notice}` : opener,
        tool: payload,
        steps: report.lines
    };
}

/**
 * Check a student's worksheet answers. The verdicts are the model's, and the
 * card says so — a wrong grade is a tutoring mistake, not a false citation.
 */
async function gradeWorksheet({ items = [], classLevel = null } = {}) {
    const asked = items.filter(i => i && i.questionText).slice(0, 20);
    if (!asked.length) return null;
    // An AI-written sheet carries its own answer key; mark against it so the
    // verdict matches the sheet. A library question has none, so the marker
    // works the answer out — and the card says the marking is AI-checked.
    const lines = asked.map((i, k) => [
        `${k + 1}. Question: ${String(i.questionText).slice(0, 700)}`,
        Array.isArray(i.options) && i.options.length ? `   Options: ${i.options.map((o, j) => `${String.fromCharCode(65 + j)}) ${o}`).join('  ')}` : '',
        i.correctAnswer ? `   Answer key: ${String(i.correctAnswer).slice(0, 300)}` : '',
        `   Student answer: ${String(i.studentAnswer || '').slice(0, 500) || '(left blank)'}`
    ].filter(Boolean).join('\n')).join('\n');
    const data = await generateJSON(
        `Mark this student's worksheet.${classLevel ? ` The student is in Class ${classLevel}.` : ''}
${levelLine(classLevel)}
For each question give a verdict of "correct", "partial" or "wrong", the correct answer in one or two lines, and one line of friendly, specific feedback. A blank answer is "wrong" and the feedback should show how to start.
Respond ONLY with JSON: {"results":[{"n":1,"verdict":"correct","correctAnswer":"...","feedback":"..."}]}

${lines}`,
        'You are a kind, exact teacher marking school work. Respond ONLY with valid JSON.',
        { task: 'general', maxTokens: 4000 }, null);

    const results = Array.isArray(data && data.results) ? data.results : [];
    if (!results.length) return null;
    const byN = new Map(results.map(r => [Number(r.n), r]));
    const marked = asked.map((it, k) => {
        const r = byN.get(k + 1) || {};
        let verdict = ['correct', 'partial', 'wrong'].includes(String(r.verdict).toLowerCase()) ? String(r.verdict).toLowerCase() : 'wrong';
        // With an answer key and an option picked, the verdict is a string
        // comparison, not the model's opinion.
        if (it.correctAnswer && Array.isArray(it.options) && it.options.length && it.studentAnswer) {
            const norm = (v) => String(v).trim().toLowerCase().replace(/^[a-d][.)]\s*/, '');
            verdict = norm(it.studentAnswer) === norm(it.correctAnswer) ? 'correct' : 'wrong';
        }
        if (!String(it.studentAnswer || '').trim()) verdict = 'wrong';
        return {
            n: k + 1,
            verdict,
            studentAnswer: String(it.studentAnswer || '').slice(0, 600),
            correctAnswer: String(it.correctAnswer || r.correctAnswer || '').slice(0, 600),
            feedback: String(r.feedback || '').slice(0, 400)
        };
    });
    const score = marked.reduce((sum, m) => sum + (m.verdict === 'correct' ? 1 : m.verdict === 'partial' ? 0.5 : 0), 0);
    return { results: marked, score, total: marked.length, checkedBy: 'AI-checked — compare with your textbook if something looks off' };
}

// ── Any of the other tools ──────────────────────────────────────────
// The five above have their own interactive cards. The rest of the Tools
// screen — Math Solver, Translator, Essay Writer, Formula Generator, Code
// Explainer and so on — is reached by matching the message against the
// catalogue. A tool runs ONLY when the student asked for something to be
// done ("solve", "translate", "write"); a plain question stays with the
// tutor, which has the textbook behind it.
const INTERACTIVE = new Set(Object.keys(BUILDERS));
const TOOL_VERB = /\b(write|draft|compose|solve|calculate|translate|summari[sz]e|paraphrase|rephrase|rewrite|explain\s+this\s+code|debug|fix|generate|create|make|build|design|plan|schedule|cite|convert|list|brainstorm|compare|analyse|analyze|breakdown|break\s+down)\b/i;
const BARE_QUESTION = /^\s*(what|why|who|when|where|which|whose|is|are|was|were|does|do|did|can|could|should|would)\b/i;
const CATALOG_SKIP = new Set(['worksheet-generator', 'flashcard-gen', 'mindmap-gen', 'ai-tutor', 'snap-and-solve', 'image-summarizer', 'video-summarizer', 'pdf-summarizer']);

function catalogSummary() {
    return CATALOG.filter(t => !CATALOG_SKIP.has(t.id)).map(t => ({
        id: t.id,
        name: t.name,
        does: t.desc,
        needs: (t.inputs || []).map(i => i.id)
    }));
}

/** Ask the model which catalogue tool this is, and what to put in its fields. */
async function pickCatalogTool(text, ctx) {
    const options = catalogSummary();
    if (!options.length) return null;
    const picked = await generateJSON(
        `A student wrote: "${String(text).slice(0, 600)}"

Which of these tools does that ask for, and what goes in its fields?
${JSON.stringify(options)}

Rules:
- Answer {"toolId": null} if the student is asking a question to be answered or explained rather than asking for something to be produced. That is the common case; prefer null when unsure.
- Use only a tool id from the list, and fill every field it needs from what the student wrote. Never invent facts they did not give.
Respond ONLY with JSON: {"toolId": "id-or-null", "inputs": {"fieldId": "value"}}`,
        'You route a student request to the right study tool. Respond ONLY with valid JSON.',
        { task: 'fast', maxTokens: 600 }, null);

    const id = picked && typeof picked.toolId === 'string' ? picked.toolId : null;
    const tool = id && CATALOG.find(t => t.id === id && !CATALOG_SKIP.has(t.id));
    if (!tool) return null;
    const inputs = picked.inputs && typeof picked.inputs === 'object' ? picked.inputs : {};
    // Every field the tool declares must have something in it, or its prompt
    // would read "Translate the following into undefined".
    const filled = {};
    for (const field of tool.inputs || []) {
        const v = inputs[field.id];
        filled[field.id] = v === undefined || v === null || String(v).trim() === '' ? '' : String(v).slice(0, 4000);
    }
    const primary = (tool.inputs || [])[0];
    if (primary && !filled[primary.id]) filled[primary.id] = String(text).slice(0, 2000);
    return { tool, inputs: filled };
}

async function runCatalogTool(text, ctx) {
    if (!TOOL_VERB.test(text) || BARE_QUESTION.test(text)) return null;
    const report = reporter(ctx);
    report.say('Matching your request to one of your 50 study tools');
    const hit = await pickCatalogTool(text, ctx);
    if (!hit) return null;
    const { tool, inputs } = hit;
    report.say(`Opened ${tool.name}`);
    const filled = Object.entries(inputs).filter(([, v]) => v).map(([k]) => (tool.inputs || []).find(i => i.id === k)?.label || k);
    if (filled.length) report.say(`Filled in ${filled.join(', ')} from your message`);

    let prompt;
    try {
        prompt = tool.promptTemplate(inputs);
    } catch (e) {
        return null;
    }
    const context = contextOf(ctx.facts || []);
    const system = tool.systemMessage
        || `You are the ${tool.name} of a study app for Indian school students. ${levelLine(context.classLevel)}`;
    report.say(`Running ${tool.name} with its own instructions`);
    const output = await generateText(prompt, system, { task: 'general' });
    if (!output || !output.trim()) return null;
    report.say('Ready');

    return {
        reply: `Ran **${tool.name}** for you.`,
        tool: {
            tool: 'generic',
            toolId: tool.id,
            title: tool.name,
            icon: tool.icon || 'fa-solid fa-wand-magic-sparkles',
            meta: { classLevel: context.classLevel, subject: context.subject || null, chapter: context.chapter || null,
                    count: 1, difficulty: null, source: 'ai', sourceLabel: `AI-written by ${tool.name} — check anything you will be marked on` },
            inputs,
            output,
            items: [],
            notice: null,
            steps: []
        },
        steps: report.lines
    };
}

module.exports = { _splitOptions: splitOptions, detectTool, runChatTool, runToolSpec, runCatalogTool, gradeWorksheet, contextOf, lastToolOf, CATALOG, LAST_TOOL_KEY };
