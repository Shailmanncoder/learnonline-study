// ================================================================
// Answering library questions without fabricating sources
// ----------------------------------------------------------------
// The rule this module exists for: a missing citation is acceptable, a
// fake one never is. So:
//
//  * The list of questions, and every citation, is assembled here from
//    database rows. The language model never writes either.
//  * When the model IS used (explanations, "similar" questions) it is
//    given question text only — no page numbers, no question numbers'
//    provenance, no URLs, no book pages. Anything page-like in its output
//    was therefore invented, and is removed before it reaches a student.
//  * "Just guess the page" is answered by code, and the answer is no.
//  * AI-written questions are labelled as such, with no citation.
// ================================================================
const { searchQuestions, findSourceOfText } = require('./search');
const { buildCitation, NOT_VERIFIED } = require('./citation');

const INTENT = {
    GUESS: /\b(just\s+)?(guess|estimate|approximate|make up|assume|roughly|probably)\b[^.?!]{0,40}\b(page|pg|question number|source|book|chapter number)\b|\b(page|question number)\b[^.?!]{0,30}\b(guess|roughly|approximately|probably)\b/i,
    SOURCE: /\bwhere\s+(did|does|is|was)\s+(this|that|the)\s+question\b|\b(source|origin)\s+of\s+(this|that|the)\s+question\b|\bwhich\s+(book|page|chapter)\s+(is\s+)?(this|that)\s+question\b|\bshow\s+(me\s+)?the\s+original\s+source\b|\boriginal source\b|\bye\s+question\s+kahan\s+se\b/i,
    SIMILAR: /\b(similar|like\s+(this|these|that)|more\s+(questions|problems)\s+like|new\s+questions?|create\s+(some\s+)?questions?|generate\s+(some\s+)?(new\s+)?questions?|make\s+(some\s+)?questions?)\b/i,
    LIST: /\b(questions?|problems?|exercises?|mcqs?|practice|worksheet|question bank|solved examples?)\b/i,
    LIBRARY_SCOPE: /\b(exemplar|ncert|important|practice|class\s*\d{1,2}|class\s+[ivx]+|chapter|verified|source)\b/i,
    // Asking for verified material by name: answered by the library even when
    // it has nothing, so the student hears "not verified" rather than a
    // general answer that could be mistaken for a sourced one.
    EXPLICIT: /\b(exemplar|verified|source|sources|citation|cite)\b/i,
    ANSWERS: /\b(with\s+(the\s+)?(answers?|solutions?)|and\s+(the\s+)?(answers?|solutions?)|solve\s+(them|these|it)|explain\s+(them|these|it)|answers?\s+too)\b/i
};

function detectIntent(text) {
    const t = String(text || '');
    if (INTENT.GUESS.test(t)) return 'guess';
    if (INTENT.SOURCE.test(t)) return 'source';
    if (INTENT.SIMILAR.test(t) && INTENT.LIBRARY_SCOPE.test(t)) return 'similar';
    if (INTENT.LIST.test(t) && INTENT.LIBRARY_SCOPE.test(t)) return 'list';
    return null;
}

// The question the student wants traced: quoted text, or text after a colon.
function extractQuotedQuestion(text) {
    const t = String(text || '');
    const quoted = t.match(/["“]([^"”]{12,})["”]/);
    if (quoted) return quoted[1].trim();
    const colon = t.split(/:\s+/);
    if (colon.length > 1 && colon.slice(1).join(': ').trim().length >= 12) return colon.slice(1).join(': ').trim();
    return null;
}

// Anything that reads like a citation in model output. The model was given
// no pages or URLs, so every such phrase is an invention.
const CITATION_LIKE = [
    /\b(printed\s+)?page\s*(no\.?|number|#)?\s*\d+/i,
    /\bpdf\s+page\b/i,
    /\bpg\.?\s*\d+/i,
    /\bp\.\s*\d+\b/i,
    /\bpp\.\s*\d+/i,
    /\b(ncert|exemplar|textbook)\b[^.\n]{0,40}\b(question|q\.?|exercise|example)\s*(no\.?\s*)?\d+/i,
    /\b(source|reference|cited from|taken from)\s*:/i,
    /https?:\/\/\S+/i
];

function stripFabricatedCitations(text) {
    const removed = [];
    const kept = String(text || '').split(/\n/).map((line) => {
        // Work sentence by sentence so one invented reference does not cost a
        // whole paragraph of useful explanation.
        const sentences = line.split(/(?<=[.!?])\s+/);
        const clean = sentences.filter((s) => {
            const bad = CITATION_LIKE.some(re => re.test(s));
            if (bad) removed.push(s.trim());
            return !bad;
        });
        return clean.join(' ');
    });
    return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), removed };
}

function toCard(row, reasons) {
    return {
        id: row.id,
        kind: row.kind,
        questionText: row.question_text,
        section: row.section || null,
        chapter: row.chapter || null,
        provenance: 'library',
        citation: buildCitation(row),
        recommendation: reasons && reasons.length ? { label: 'Recommended practice', reasons } : null
    };
}

/**
 * @param text      the student's message
 * @param ctx       { facts, weakTopics, generateText(prompt, system, opts) }
 * @returns null when this is not a library question; otherwise
 *          { reply, library: { intent, cards, notice }, steps }
 */
async function answerLibraryQuestion(text, ctx = {}) {
    const intent = detectIntent(text);
    if (!intent) return null;
    const steps = [];

    if (intent === 'guess') {
        // Decided by code. If the student pasted a question we can trace, the
        // real citation is the answer; otherwise we decline to invent one.
        const quoted = extractQuotedQuestion(text);
        const found = quoted ? await findSourceOfText(quoted) : null;
        const hit = found && !found.ambiguous ? found : null;
        const citation = hit ? buildCitation(hit.row) : null;
        steps.push('Checked the verified source library instead of guessing');
        if (citation && citation.verified) {
            return {
                reply: 'I won’t guess — but this question is in the verified library, so here is its real source.',
                library: { intent, cards: [toCard(hit.row)], notice: null }, steps
            };
        }
        return {
            reply: `I can’t guess a page number, question number or book. A guessed citation could send you to the wrong place, so I don’t make them up.\n\n**${NOT_VERIFIED}**`,
            library: { intent, cards: [], notice: NOT_VERIFIED }, steps
        };
    }

    if (intent === 'source') {
        const quoted = extractQuotedQuestion(text);
        if (!quoted) {
            steps.push('No question text given to trace');
            return {
                reply: 'Paste the question you want traced (after a colon or in quotes) and I’ll look for it in the verified source library.',
                library: { intent, cards: [], notice: null }, steps
            };
        }
        steps.push('Searched the verified source library for that exact question');
        const hit = await findSourceOfText(quoted);
        if (hit && hit.ambiguous) {
            steps.push(`That text matches ${hit.count} different questions — not picking one`);
            return {
                reply: `That text matches ${hit.count} different questions, so I can’t say which one it is. Paste more of the question and I’ll trace it.\n\n**${NOT_VERIFIED}**`,
                library: { intent, cards: [], notice: NOT_VERIFIED }, steps
            };
        }
        if (!hit) {
            steps.push('No close match — not citing anything');
            return {
                reply: `I couldn’t find that question in the verified source library.\n\n**${NOT_VERIFIED}**`,
                library: { intent, cards: [], notice: NOT_VERIFIED }, steps
            };
        }
        const card = toCard(hit.row);
        steps.push(card.citation.verified ? 'Found it — citation read from the source record' : 'Found a match, but its source is not verified yet');
        return {
            reply: card.citation.verified ? 'Found it. Here is where this question comes from.' : `I found a matching question, but its source hasn’t been verified yet.\n\n**${NOT_VERIFIED}**`,
            library: { intent, cards: [card], notice: card.citation.verified ? null : NOT_VERIFIED }, steps
        };
    }

    const found = await searchQuestions(text, { facts: ctx.facts || [], weakTopics: ctx.weakTopics || [] });
    const q = found.query;
    steps.push(`Filtered the source library${q.classLevel ? ` to Class ${q.classLevel}` : ''}${q.subject ? ` ${q.subject}` : ''}${found.chapter ? `, ${found.chapter}` : ''}${q.sourceType ? ', NCERT Exemplar' : ''} — ${found.total} questions`);

    if (!found.results.length) {
        // The library covers little so far. An ordinary request it cannot serve
        // ("class 9 science chapter 2 questions") goes back to the normal tutor
        // instead of being answered with "I have nothing".
        if (!INTENT.EXPLICIT.test(text)) return null;
        steps.push('Nothing in the verified library matches');
        return {
            reply: `I don’t have verified questions for that yet${q.classLevel || q.subject ? ` (${[q.classLevel && `Class ${q.classLevel}`, q.subject, found.chapter].filter(Boolean).join(' ')})` : ''}. I won’t present made-up questions as if they came from a book.`,
            library: { intent, cards: [], notice: NOT_VERIFIED }, steps
        };
    }
    const cards = found.results.map(r => toCard(r.row, r.reasons));
    steps.push(`Ranked ${cards.length} for practice${q.wantDifficult ? ', hardest first' : ''}`);

    if (intent === 'similar') {
        if (!ctx.generateText) {
            return { reply: 'I can’t generate new questions right now.', library: { intent, cards: [], notice: null }, steps };
        }
        steps.push('Writing new questions in the same style (AI-generated, not from any book)');
        const examples = found.results.slice(0, 4).map((r, i) => `${i + 1}. ${r.row.question_text}`).join('\n\n');
        const raw = await ctx.generateText(
            `Here are practice questions on ${found.chapter || 'this topic'} for Class ${q.classLevel || ''} ${q.subject || ''}:\n\n${examples}\n\nWrite 4 NEW questions in a similar style and at a similar level. Number them 1 to 4.`,
            'You write original practice questions for school students. Never claim a question comes from NCERT, a textbook, a page, or any source. Do not mention page numbers, book names, or question numbers from any book.',
            { task: 'general', maxTokens: 1400 });
        const { text: cleanText, removed } = stripFabricatedCitations(raw);
        if (removed.length) steps.push(`Removed ${removed.length} source-like claim${removed.length > 1 ? 's' : ''} from the AI text`);
        return {
            reply: cleanText || 'I couldn’t write new questions right now.',
            library: {
                intent,
                cards: [],
                aiGenerated: { label: 'AI-generated questions inspired by the topic', note: 'These are new questions written by AI. They are not from NCERT or any book, so they have no source.' },
                notice: null
            },
            steps
        };
    }

    let reply = found.chapter
        ? `Here are ${cards.length} recommended practice questions from ${found.chapter}. Each shows exactly where it comes from.`
        : `Here are ${cards.length} recommended practice questions. Each shows exactly where it comes from.`;

    if (INTENT.ANSWERS.test(text) && ctx.generateText) {
        steps.push('Writing explanations (AI-generated — not official solutions)');
        // Question text only: no page, number or URL is given to the model.
        const listing = found.results.map((r, i) => `[${i + 1}] ${r.row.question_text}`).join('\n\n');
        const raw = await ctx.generateText(
            `Explain how to solve each of these questions, briefly and clearly, labelled [1], [2], … in the same order:\n\n${listing}`,
            'You are a patient maths tutor. Give short worked explanations. Never state or guess a book, page, printed page, question number, URL or source — you do not know them. Do not call your explanation an official or NCERT answer.',
            { task: 'reasoning', maxTokens: 2600 });
        const { text: cleanText, removed } = stripFabricatedCitations(raw);
        if (removed.length) steps.push(`Removed ${removed.length} source-like claim${removed.length > 1 ? 's' : ''} from the AI text`);
        if (cleanText) {
            reply += `\n\n---\n\n**✨ AI-generated explanations** — written by AI, not official NCERT solutions:\n\n${cleanText}`;
        }
    }
    return { reply, library: { intent, cards, notice: null, answerSource: INTENT.ANSWERS.test(text) ? 'ai_generated' : null }, steps };
}

module.exports = { answerLibraryQuestion, detectIntent, stripFabricatedCitations, extractQuotedQuestion, toCard };
