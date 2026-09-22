// ================================================================
// Gemini model catalogue and routing
// ----------------------------------------------------------------
// Which models students can pick, what each is good for, and which one
// Auto chooses. Lives here rather than in the controller so the routing
// can be tested on its own — it is shown to students, so it has to be
// right and has to stay explainable.
// ================================================================

// ── Gemini model catalogue ─────────────────────────────────────────
// Still a server-side allowlist, so a client cannot bill us for an arbitrary
// model — but it now also describes each model, because the student picks one.
//
// The 2.5 family is deliberately absent: against the configured key it answers
// 404, "no longer available to new users. Please update your code to use
// models/gemini-3.6-flash". Listing it would offer students a model that cannot
// answer. Every id here was verified with a real generateContent call.
const GEMINI_MODELS = [
    {
        id: 'gemini-3.8-flash',
        label: 'Deep research',
        tier: 'deep',
        bestFor: 'Multi-step problems, proofs, comparisons and long questions. Slowest, and shows its working as it goes.'
    },
    {
        id: 'gemini-3.6-flash',
        label: 'Balanced',
        tier: 'balanced',
        bestFor: 'Explanations, homework help and most questions. A good all-rounder.'
    },
    {
        id: 'gemini-3.1-flash-lite',
        label: 'Quick',
        tier: 'fast',
        bestFor: 'Definitions, short factual questions and quick checks. Fastest.'
    }
];
const MODEL_BY_ID = new Map(GEMINI_MODELS.map(m => [m.id, m]));
const MODEL_BY_TIER = new Map(GEMINI_MODELS.map(m => [m.tier, m]));
const DEFAULT_MODEL = MODEL_BY_TIER.get('balanced').id;

// Cues that a question genuinely needs working-out rather than recall. Kept
// readable on purpose: this routing is shown to the student, so it has to be
// something we can explain, not an opaque score.
const DEEP_CUES = /\b(prove|proof|derive|derivation|compare|contrast|why\s+does|why\s+is|explain\s+why|step[-\s]?by[-\s]?step|research|essay|analyse|analyze|evaluate|discuss|advantages?\s+and\s+disadvantages|difference\s+between)\b/i;
const QUICK_CUES = /^\s*(what\s+is|what\s+are|who\s+is|who\s+was|when\s+(is|was|did)|where\s+is|define|meaning\s+of|full\s+form\s+of|spell)\b/i;

// Which model answers, and a reason plain enough to show the student. An
// explicit choice always wins — 'auto' is the only value that routes.
function chooseModel({ requested, prompt, task, hasImages } = {}) {
    const asked = String(requested || '').trim();
    if (asked && asked !== 'auto') {
        const picked = MODEL_BY_ID.get(asked);
        if (picked) return { ...picked, reason: `you chose ${picked.label}`, auto: false };
        // An unknown id is a client bug or an attempt to bill us for something
        // else; fall through to routing rather than honouring it.
    }

    const text = String(prompt || '');
    const deep = MODEL_BY_TIER.get('deep');
    const balanced = MODEL_BY_TIER.get('balanced');
    const fast = MODEL_BY_TIER.get('fast');

    if (hasImages) {
        return { ...balanced, reason: 'reading the image you attached', auto: true };
    }
    if (task === 'reasoning' || DEEP_CUES.test(text)) {
        return { ...deep, reason: 'this needs working through in steps', auto: true };
    }
    if (text.length > 400) {
        return { ...deep, reason: 'a long question with a lot to hold together', auto: true };
    }
    if (text.length < 90 && QUICK_CUES.test(text)) {
        return { ...fast, reason: 'a short factual question', auto: true };
    }
    return { ...balanced, reason: 'a good all-round fit', auto: true };
}

// GEMINI_MODEL can still override the default, but only to a model we have.
function defaultModel() {
    const fromEnv = String(process.env.GEMINI_MODEL || '').trim();
    return MODEL_BY_ID.has(fromEnv) ? fromEnv : DEFAULT_MODEL;
}

module.exports = { GEMINI_MODELS, MODEL_BY_ID, MODEL_BY_TIER, DEFAULT_MODEL, chooseModel, defaultModel };
