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
const { generateJSON } = require('./ai');
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
        .replace(/\b(questions?|cards?|marks?|difficulty|level|easy|medium|hard|difficult|tough|challenging|advanced|simple|basic)\b/gi, ' ')
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

// ── Worksheet ───────────────────────────────────────────────────────
// Library first: real questions, real citations. The model is asked only
// when the library has nothing for this class and topic.
async function buildWorksheet(spec, ctx, { facts, weakTopics }) {
    const steps = [];
    const query = [ctx.classLevel ? `class ${ctx.classLevel}` : '', ctx.subject, spec.topic || ctx.chapter, `${spec.count} questions`]
        .filter(Boolean).join(' ');
    const seen = new Set((spec.seenIds || []).map(Number));
    let cards = [];
    let repeated = false;
    try {
        // Ask for enough to still have a full sheet after dropping the ones
        // this student has already been given: "5 more" must mean 5 new ones.
        const found = await searchQuestions(query, { facts, weakTopics, limit: spec.count + seen.size });
        const all = (found.results || []).map(r => toCard(r.row, r.reasons));
        const fresh = all.filter(c => !seen.has(Number(c.id)));
        cards = fresh.length >= Math.min(3, spec.count) ? fresh : all;
        repeated = cards === all && seen.size > 0 && fresh.length < Math.min(3, spec.count);
        steps.push(`Searched the verified library for "${found.chapter || spec.topic || ctx.chapter || 'this class'}" — ${fresh.length} question${fresh.length === 1 ? '' : 's'} you have not seen yet`);
    } catch (e) {
        steps.push('The verified library was unavailable — wrote practice questions instead');
    }

    if (cards.length >= Math.min(3, spec.count)) {
        const items = cards.slice(0, spec.count).map((c, i) => ({
            n: i + 1,
            id: c.id,
            questionText: c.questionText,
            provenance: 'library',
            section: c.section || null,
            chapter: c.chapter || null,
            citation: c.citation || null,
            recommendation: c.recommendation || null
        }));
        return {
            tool: 'worksheet',
            title: `Worksheet · ${describe(ctx, spec) || 'Practice'}`,
            meta: { classLevel: ctx.classLevel, subject: ctx.subject || null, chapter: spec.topic || ctx.chapter || null,
                    count: items.length, difficulty: spec.difficulty, source: 'library', sourceLabel: LIBRARY_LABEL },
            items,
            ids: items.map(i => i.id).filter(Boolean),
            notice: repeated
                ? 'You have now seen every verified question the library holds for this topic, so these come round again.'
                : items.length < spec.count
                    ? `The library had ${items.length} verified question${items.length === 1 ? '' : 's'} for this topic, so the worksheet is that long.`
                    : null,
            steps
        };
    }

    const data = await generateJSON(
        `Write a ${spec.count}-question practice worksheet (difficulty: ${spec.difficulty}) on "${spec.topic || ctx.chapter || ctx.subject || 'the current chapter'}"${ctx.classLevel ? ` for Class ${ctx.classLevel}` : ''}.
${levelLine(ctx.classLevel)}
Follow the NCERT syllabus for that class. Mix short-answer and reasoning questions. Give each question marks out of 5 and a one-line hint.
Never mention a book name, page number, exercise number or question number from any book.
Respond ONLY with JSON: {"questions":[{"question":"...","marks":2,"hint":"..."}]}`,
        'You write clear, syllabus-accurate practice questions for Indian school students. Respond ONLY with valid JSON.',
        { task: 'general' }, null);

    const list = Array.isArray(data && data.questions) ? data.questions.filter(q => q && q.question) : [];
    if (!list.length) return null;
    steps.push('No verified questions matched, so these are AI-written for practice');
    return {
        tool: 'worksheet',
        title: `Worksheet · ${describe(ctx, spec) || 'Practice'}`,
        meta: { classLevel: ctx.classLevel, subject: ctx.subject || null, chapter: spec.topic || ctx.chapter || null,
                count: list.length, difficulty: spec.difficulty, source: 'ai', sourceLabel: AI_LABEL },
        items: list.slice(0, spec.count).map((q, i) => ({
            n: i + 1,
            questionText: String(q.question),
            marks: Number(q.marks) || 2,
            hint: q.hint ? String(q.hint) : null,
            provenance: 'ai',
            citation: null
        })),
        notice: null,
        steps
    };
}

// ── Quiz ────────────────────────────────────────────────────────────
// Needs an answer key to score instantly, and the library holds questions
// only — no answers — so a quiz is always AI-written and labelled.
async function buildQuiz(spec, ctx) {
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
        notice: null,
        steps: ['Wrote a quiz with an answer key so it can be scored instantly']
    };
}

// ── Flashcards ──────────────────────────────────────────────────────
async function buildFlashcards(spec, ctx) {
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
        notice: null,
        steps: [`Wrote ${list.length} flashcards you can flip and save to your deck`]
    };
}

// ── Notes and mind map ──────────────────────────────────────────────
async function buildNotes(spec, ctx) {
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
        notice: null,
        steps: ['Wrote revision notes you can save to your notebook']
    };
}

async function buildMindmap(spec, ctx) {
    const subject = spec.topic || ctx.chapter || ctx.subject || 'the current chapter';
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
        notice: null,
        steps: ['Drew a mind map of the topic']
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
    if (!spec) return null;
    return runToolSpec(spec, ctx);
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
        followUp: Boolean(rawSpec.followUp)
    };
    if (!BUILDERS[spec.tool]) return null;

    const context = contextOf(facts);
    if (spec.classLevel) context.classLevel = spec.classLevel;
    const build = BUILDERS[spec.tool];
    const steps = [`Opening the ${spec.tool} tool${context.classLevel ? ` for Class ${context.classLevel}` : ''}`];
    if (spec.followUp) steps.push('Continuing from the last one in this chat');
    const payload = await build(spec, context, { facts, weakTopics: ctx.weakTopics || [] });
    if (!payload) return null;

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
    return {
        reply: payload.notice ? `${opener}\n\n${payload.notice}` : opener,
        tool: payload,
        steps: steps.concat(payload.steps || [])
    };
}

/**
 * Check a student's worksheet answers. The verdicts are the model's, and the
 * card says so — a wrong grade is a tutoring mistake, not a false citation.
 */
async function gradeWorksheet({ items = [], classLevel = null } = {}) {
    const asked = items.filter(i => i && i.questionText).slice(0, 20);
    if (!asked.length) return null;
    const lines = asked.map((i, k) => `${k + 1}. Question: ${String(i.questionText).slice(0, 500)}\n   Student answer: ${String(i.studentAnswer || '').slice(0, 500) || '(left blank)'}`).join('\n');
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
        const verdict = ['correct', 'partial', 'wrong'].includes(String(r.verdict).toLowerCase()) ? String(r.verdict).toLowerCase() : 'wrong';
        return {
            n: k + 1,
            verdict,
            correctAnswer: String(r.correctAnswer || '').slice(0, 600),
            feedback: String(r.feedback || '').slice(0, 400)
        };
    });
    const score = marked.reduce((sum, m) => sum + (m.verdict === 'correct' ? 1 : m.verdict === 'partial' ? 0.5 : 0), 0);
    return { results: marked, score, total: marked.length, checkedBy: 'AI-checked — compare with your textbook if something looks off' };
}

module.exports = { detectTool, runChatTool, runToolSpec, gradeWorksheet, contextOf, lastToolOf, LAST_TOOL_KEY };
