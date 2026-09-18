// ================================================================
// Chapter lock — contextual memory for "we are studying THIS chapter"
// ----------------------------------------------------------------
// Without a lock every question was resolved from scratch, so a follow-up
// like "iska matlab kya hai" or "give me the word meanings" drifted to
// whichever chunk scored highest across the whole class. Once a student is
// working on a chapter they stay on it until they say otherwise.
//
// While locked, retrieval is GATED rather than augmented: the chapter's own
// text is the only source. That is the opposite of the general Companion
// behaviour and is deliberate — a student revising one chapter is better
// served by "that is not in this chapter" than by a fluent answer drawn
// from somewhere else.
// ================================================================
const { titleScore, namesTitle } = require('./translit');

// Stored as ordinary memory facts so the lock survives reloads and threads.
const LOCK_KEY = 'chapter';
const LOCK_LABEL_KEY = 'chapter_label';

// Confidence needed to switch to a chapter the student names. Higher than
// the locator's 0.45: switching away from the chapter they are studying is
// disruptive, so it needs to be clearly intended.
const SWITCH_MIN = 0.6;

// No \b around the Devanagari alternatives: JavaScript word boundaries are
// defined on [A-Za-z0-9_], so \b never matches beside a Devanagari letter and
// "दूसरा पाठ" was silently unreleasable. Both word orders are accepted too —
// "chapter change" and "change chapter" mean the same thing to a student.
const RELEASE = new RegExp([
    '\\b(exit|leave|close|quit|stop|end)\\s+(this\\s+)?(chapter|lesson|paath|path|adhyay)\\b',
    '\\b(chapter|lesson|paath|adhyay)\\s+(change|badal|badlo|chhod|chod)',
    '\\b(change|badal|badlo|switch)\\s+(the\\s+)?(chapter|lesson|paath|adhyay)\\b',
    '\\b(koi|another|different|next|doosra|dusra|agla)\\s+(chapter|paath|path|lesson|adhyay)\\b',
    '(दूसरा|दूसरे|अगला|अगले|कोई और)\\s*(पाठ|अध्याय)',
    '(पाठ|अध्याय)\\s*(बदलो|बदलना|छोड़ो|बंद करो)'
].join('|'), 'i');

function isRelease(question) {
    return RELEASE.test(String(question || ''));
}

// Which chapter, if any, should be in force for this question.
//   { chapterId, label, changed, released }
async function resolveLock({ corpus, facts, question, shelf, mediumFor }) {
    const get = (k) => (facts || []).find((f) => f.mem_key === k)?.mem_value || '';
    const held = get(LOCK_KEY);
    const heldLabel = get(LOCK_LABEL_KEY);

    if (isRelease(question)) return { chapterId: null, label: heldLabel, released: Boolean(held) };

    // A chapter the student names outranks whatever is held. No length or
    // pronoun gate here: titleScore already discriminates (0.75 for "do
    // bailon ki katha padhna hai", 0.00 for "iska saar batao"), and gating on
    // length blocked nearly every real question — most are under 40 chars.
    if (shelf && shelf.grade) {
        let rows = [];
        try {
            rows = await corpus.allChapters({
                grade: shelf.grade,
                subject: shelf.subject || undefined,
                medium: shelf.subject ? mediumFor(shelf.subject, facts) : undefined
            });
        } catch (e) { rows = []; }

        // namesTitle, not titleScore: the question NAMES the chapter, and
        // scoring by the share of QUERY tokens punishes longer phrasings —
        // "ab reedh ki haddi paath padhna hai" scored 0.50 and failed to
        // switch, while the bare "reedh ki haddi" scored 1.00.
        //
        // rows arrive ordered by edition_rank, so on an equal score the
        // current edition wins and duplicates in older books lose.
        let best = null;
        for (const r of rows) {
            if (r.status !== 'ready') continue;   // cannot lock onto unreadable text
            const score = namesTitle(question, r.chapter_name || '');
            if (score >= SWITCH_MIN && (!best || score > best.score)) best = { ...r, score };
        }
        if (best && best.chapter_id !== held) {
            return {
                chapterId: best.chapter_id,
                label: `${best.chapter_name} (${best.book_name})`,
                changed: true
            };
        }
    }

    if (!held) return { chapterId: null };

    // Validate the held lock: the chapter may have been re-graded since.
    try {
        const meta = await corpus.chapterMeta(held);
        if (!meta || meta.status !== 'ready') return { chapterId: null, stale: true };
        return { chapterId: held, label: heldLabel || `${meta.chapter_name} (${meta.book_name})` };
    } catch (e) {
        return { chapterId: held, label: heldLabel };
    }
}

// How simply to explain, by class. A Class 3 reader and a Class 11 reader
// need different sentences for the same fact.
function readingLevel(classValue) {
    const n = Number(String(classValue || '').replace(/\D/g, ''));
    if (!n) return null;
    if (n <= 5) {
        return [
            'LANGUAGE: Write for a young child (Class ' + n + ').',
            '- Use very short sentences. One idea per sentence.',
            '- Use everyday words only. No technical terms unless the chapter uses them.',
            '- Give a simple example from daily life for each idea.',
            '- Keep the whole answer under about 120 words unless asked for more.'
        ].join('\n');
    }
    if (n <= 8) {
        return [
            'LANGUAGE: Write simply, for a Class ' + n + ' student.',
            '- Short sentences and common words. Explain any term the moment you use it.',
            '- Prefer a plain explanation over a formal definition.',
            '- Use a short example. Avoid long lists and avoid advanced vocabulary.',
            '- Keep the whole answer under about 180 words unless asked for more.'
        ].join('\n');
    }
    if (n <= 10) {
        return [
            'LANGUAGE: Write clearly and simply, for a Class ' + n + ' student.',
            '- Use the textbook\'s own terms, but explain each one in plain words.',
            '- Short paragraphs. No jargon the chapter does not use.',
            '- Do not bring in concepts from higher classes.'
        ].join('\n');
    }
    return [
        'LANGUAGE: Write for a Class ' + n + ' student.',
        '- Precise but readable. Define terms on first use.',
        '- Stay at the depth this chapter goes to; do not add university-level material.'
    ].join('\n');
}

module.exports = { LOCK_KEY, LOCK_LABEL_KEY, resolveLock, isRelease, readingLevel, SWITCH_MIN };
