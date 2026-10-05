// ================================================================
// The shared brain
// ----------------------------------------------------------------
// Every AI surface in this app — the Companion, the 50 tools, the
// quiz and worksheet generators, grading, summaries — used to send
// its own ad-hoc system message. The result was 50 different
// personalities and, more visibly, an app that explained at length
// no matter how small the question was.
//
// This module holds the behaviour they now all share: answer at the
// length the question actually deserves, use what we already know
// about the student, and say so when unsure. Individual callers keep
// their own task instructions; this is layered underneath, so a tool
// that needs strict JSON still gets strict JSON.
// ================================================================

// ── How long should the answer be? ────────────────────────────────
// Judged from the question itself. The point is that a one-line
// question gets a one-line answer: the old behaviour opened with a
// restatement, gave three headed sections and closed with a summary
// even when the student asked what year something happened.
const SHORT_ASK = /^\s*(what|who|when|where|which|is|are|was|were|does|do|did|can|will|how (?:many|much|old|far|long))\b/i;
const WANTS_DEPTH = /\b(explain|why|derive|prove|step[- ]by[- ]step|in detail|walk me through|how does|how do|compare|discuss|essay|elaborate|teach me|full|detailed)\b/i;
const WANTS_BREVITY = /\b(in (?:one|a) (?:line|sentence|word)|one[- ]liner|briefly|short(?:ly)?|just (?:the )?(?:answer|name|value)|tl;?dr|quickly|in short)\b/i;

// A request for a whole DOCUMENT, as opposed to an answer. The tools send
// templates, not questions: "write a comprehensive technical study guide" with
// four numbered sections is not a short ask, but none of the WANTS_DEPTH verbs
// appear in it, so it classified as 'normal' and was handed 2000 tokens and the
// instruction "Answer in a few sentences". The Developer Hub's AI Notes and
// Code Review both asked for five sections including a refactored code example
// and were cut off part-way through, every time.
const WANTS_DOCUMENT = /\b(comprehensive|exhaustive|in[- ]depth|thorough(?:ly)?|authoritative|complete guide|study guide|write (?:an?|the) (?:report|guide|article|review|analysis))\b/i;

// Three or more numbered headings is a caller laying out the shape of a
// document it expects back.
function asksForSections(text) {
    return (String(text).match(/^[ \t]*\d+[.)][ \t]+\S/gm) || []).length >= 3;
}

/**
 * Classify how much answer a prompt is asking for.
 * Returns 'brief' | 'normal' | 'deep'.
 */
function depthOf(prompt = '') {
    const text = String(prompt || '').trim();
    if (!text) return 'normal';
    if (WANTS_BREVITY.test(text)) return 'brief';
    if (WANTS_DEPTH.test(text) || WANTS_DOCUMENT.test(text) || asksForSections(text)) return 'deep';
    // A short factual question is a short answer, unless it asked for depth.
    const words = text.split(/\s+/).length;
    if (SHORT_ASK.test(text) && words <= 18) return 'brief';
    if (words <= 8) return 'brief';
    return 'normal';
}

const LENGTH_RULE = {
    brief: 'This question wants a short answer. Give the answer itself in one or two sentences and stop. Do not add background, headings, bullet lists or a closing summary. If a single extra sentence genuinely helps, add one — no more.',
    normal: 'Answer in a few sentences, or a short list if the content is genuinely a list. Do not pad with restatements, headings or a closing summary unless the answer is long enough to need them.',
    deep: 'This question asks for depth, so take the room it needs: work through the reasoning in order, and show the steps rather than only the result. Still stop when the question is answered.'
};

// Token budget should follow the same judgement — a brief answer that is
// allowed 4000 tokens tends to grow to fill them.
const BUDGET = { brief: 700, normal: 2000, deep: 5000 };

// ── Mathematics ───────────────────────────────────────────────────
// A calculation is judged on whether the number is right, so it gets its own
// rules. Without them the Math Solver opened by defining what a quadratic is
// and restating the standard form before touching the actual equation: the
// tool's own template says "solve step-by-step and teach clearly", which reads
// as a request for depth, and the answer grew to fill the room.
const MATH_CUES = /\b(solve|calculate|evaluate|simplify|factoris|factoriz|expand|integrate|differentiate|derivative|equation|quadratic|roots?|value of x|prove that|find the (?:value|sum|product|area|volume|perimeter|hcf|lcm)|\bsum of\b|percentage|ratio|probability)\b/i;
const MATH_SHAPE = /[0-9]\s*[-+*/^=]\s*[0-9a-z(]|[a-z]\s*\^\s*[0-9]|\\frac|\\sqrt|∫|√|π|≤|≥|≠/i;
// Arithmetic people write in words rather than symbols.
const MATH_WORDS = /\b\d+\s*(?:times|multiplied by|divided by|plus|minus|squared|cubed|percent of|%\s*of)\b|\b(?:square root|cube root|hcf|lcm|factorial)\b/i;

/** True when the question is a calculation rather than a discussion. */
function isMath(text) {
    const t = String(text || '');
    if (!t.trim()) return false;
    return MATH_CUES.test(t) || MATH_SHAPE.test(t) || MATH_WORDS.test(t);
}

const MATH_RULE = [
    'This is a mathematics question. Accuracy is the whole job:',
    '- Work the actual problem. Do not open by defining standard terms, restating the general form, or explaining what kind of problem it is — the student asked for the answer, not a textbook introduction.',
    '- Show the steps that do the work, in order, with the arithmetic visible. Skip the commentary between them.',
    '- Carry out each calculation carefully and check it before moving on. A wrong number makes the whole answer worthless, however well presented.',
    '- Where the result can be checked — substituting a root back, re-adding a total, confirming units — do that check and say it passed.',
    '- Finish with the answer stated plainly on its own line.',
    '- If the question is ambiguous or missing a value, say exactly what is missing instead of assuming one.'
].join('\n');

/**
 * The behaviour every AI surface in the app shares.
 *
 * @param {object}   opts
 * @param {string}   opts.depth     'brief' | 'normal' | 'deep'
 * @param {object}   opts.profile   { username, classLevel, board, … }
 * @param {string[]} opts.facts     durable things the student has told us
 * @param {string[]} opts.weakTopics topics they have recently got wrong
 * @param {string}   opts.topic     the subject area in play, when known
 */
function brain({ depth = 'normal', profile = null, facts = [], weakTopics = [], topic = '', prompt = '' } = {}) {
    const opts_isMath = isMath(prompt);
    const lines = [
        'You are the study companion inside StudyHub, helping one student.',
        '',
        'How to answer:',
        `- ${LENGTH_RULE[depth] || LENGTH_RULE.normal}`,
        '- Match the register of the question. A casual question gets a casual answer; a formal one gets a formal answer.',
        '- Never open by restating the question or with filler such as "Great question!" or "Certainly!". Start with the answer.',
        '- Write plainly. Use a heading or a list only when the content is genuinely structured; prose is the default.',
        '- If the question is ambiguous in a way that changes the answer, ask one short clarifying question instead of guessing. Otherwise answer, stating any assumption in a clause.',
        '- If you do not know, or are not confident, say so plainly. Never invent a source, a page number, a statistic or a quotation.',
        '- Work out what the question is really about before answering, including which subject and topic it belongs to, and answer at that level.'
    ];

    // Mathematics overrides the length rule: the steps are the answer, but the
    // padding around them is not.
    if (opts_isMath) {
        lines.push('', MATH_RULE);
    }

    const who = [];
    if (profile?.classLevel) who.push(`is in class ${profile.classLevel}`);
    if (profile?.board) who.push(`follows the ${profile.board} board`);
    if (who.length) {
        lines.push('', `About this student: they ${who.join(' and ')}. Pitch the explanation and the vocabulary at that level without mentioning that you are doing so.`);
    }
    if (topic) lines.push(`The current topic is ${topic}. Stay on it unless the student changes it.`);
    if (facts.length) {
        lines.push(`Things this student has told you before (context only — the current message always wins): ${facts.slice(0, 12).join('; ')}.`);
    }
    if (weakTopics.length) {
        lines.push(`They have recently struggled with: ${weakTopics.slice(0, 6).join(', ')}. Lean on this only when it is relevant; do not bring it up unprompted.`);
    }
    return lines.join('\n');
}

/**
 * Layer the shared brain underneath a caller's own task instruction.
 * The caller's instruction comes last so it wins on any conflict —
 * a generator that demands raw JSON must still get raw JSON.
 */
function withBrain(callerInstruction, opts = {}) {
    const base = brain(opts);
    const own = String(callerInstruction || '').trim();
    if (!own) return base;
    return `${base}\n\n--- Task ---\n${own}`;
}


// ── Does this turn need the textbook pipeline at all? ─────────────
// Typing "hello" used to run the whole grounding chain: read the study
// profile, resolve uploaded PDFs, re-open the locked chapter and pull
// four pages of it into context — several seconds and a few thousand
// tokens, so the tutor could say hello back while holding a chapter on
// soil. A greeting is not a question about the syllabus.
//
// Deliberately narrow: only greetings, thanks and sign-offs, and only
// when they are the WHOLE message. A bare "yes", "ok" or "go on" is NOT
// included — those are usually answering something the tutor just asked,
// and they still need the chapter in context to be answerable.
const SMALL_TALK = /^(?:h(?:i+|e+y+|ello+|iya)|yo|namaste|namaskar|salaam|good\s*(?:morning|afternoon|evening|night)|thanks?(?:\s*(?:you|a lot|so much))?|thank\s*you|thx|ty|cheers|bye+|goodbye|see\s*(?:you|ya)|gn|good\s*night|welcome|sup|what'?s\s*up)(?:\s+there)?$/i;

/**
 * True when the message is pure pleasantry and carries no question.
 * Punctuation and emoji are ignored, so "hi!!" and "hello 👋" count.
 */
function isSmallTalk(text) {
    const cleaned = String(text || '')
        .replace(/[\p{Extended_Pictographic}\u200d\uFE0F]/gu, '')
        .replace(/[^\p{L}\p{N}\s']/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ');
    if (!cleaned || cleaned.split(' ').length > 3) return false;
    return SMALL_TALK.test(cleaned);
}

module.exports = { brain, withBrain, depthOf, isSmallTalk, isMath, BUDGET, LENGTH_RULE };
