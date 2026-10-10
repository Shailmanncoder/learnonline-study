'use strict';
// ================================================================
// What a plan actually grants
// ----------------------------------------------------------------
// Prices live in payments/config.js. This module owns the other half:
// which tools a tier opens and how much work it may do in a month.
//
// Until now nothing was enforced anywhere. The entitlement row was written
// on payment and then never consulted, so every tier — including no tier at
// all — had the whole app and unmetered AI. The plans were decoration.
//
// Usage is counted in CREDITS rather than requests, because requests are not
// the same size: a one-line answer and a forty-day study roadmap differ by
// two orders of magnitude in what they cost to serve. Credits track the token
// budget the request is actually allowed (services/aiBrain BUDGET), so the
// meter follows the bill.
// ================================================================

// Ordered by value to a student. The first ten are the core study loop; a
// tier that opens "10 tools" opens exactly this prefix, so the cheapest plan
// is still a coherent product rather than an arbitrary tenth of the catalogue.
const TOOL_ORDER = [
    // 1–10 — Starter
    'ai-tutor', 'math-solver', 'summarizer', 'flashcard-gen', 'worksheet-generator',
    'essay-writer', 'key-takeaways', 'qna-generator', 'study-planner', 'translator',
    // 11–25 — Plus
    'paragraph-gen', 'grammar-tutor', 'vocab-builder', 'pdf-summarizer', 'chapter-summarizer',
    'formula-sheet', 'stats-helper', 'history-tutor', 'geography-guide', 'mindmap-gen',
    'ai-paraphraser', 'citation-generator', 'snap-and-solve', 'image-summarizer', 'video-summarizer',
    // 26+ — Pro and Max
    'eli5', 'code-explainer', 'bug-fixer', 'sql-gen', 'regex-builder',
    'algorithm-tutor', 'web-dev-helper', 'cover-letter', 'resume-builder', 'interview-prep',
    'email-writer', 'linkedin-bio', 'pronunciation', 'idiom-explainer', 'pomodoro-guide',
    'habit-tracker', 'todo-ai', 'motivation-coach', 'philosophy-bot', 'art-history',
    'trivia-gen', 'joke-writer', 'idea-gen', 'name-gen', 'pros-cons'
];

// Monthly credit allowances. Deliberately set so the worst case — a subscriber
// spending every credit on the most expensive action — still costs less to
// serve than the plan earns. Typical use is a fraction of this, which is where
// the margin actually comes from. Tunable without a deploy.
const envInt = (name, fallback) => {
    const n = Number.parseInt(process.env[name] ?? '', 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
};

function tiers() {
    return Object.freeze({
        // `companion` is the conversational tutor — threads, memory, follow-ups,
        // streaming. It is the most capable thing in the app and the most
        // expensive to serve, so it starts at Plus rather than being the one
        // part of the product nobody has to pay for.
        free:    { id:'free',    rank:0, label:'Free',    tools:3,     credits: envInt('PLAN_CREDITS_FREE', 350),     priority:false, deep:false, companion:false },
        starter: { id:'starter', rank:1, label:'Starter', tools:10,    credits: envInt('PLAN_CREDITS_STARTER', 1200),  priority:false, deep:true,  companion:false },
        plus:    { id:'plus',    rank:2, label:'Plus',    tools:25,    credits: envInt('PLAN_CREDITS_PLUS', 12000),    priority:false, deep:true,  companion:true },
        pro:     { id:'pro',     rank:3, label:'Pro',     tools:'all', credits: envInt('PLAN_CREDITS_PRO', 24000),     priority:false, deep:true,  companion:true },
        max:     { id:'max',     rank:4, label:'Max',     tools:'all', credits: envInt('PLAN_CREDITS_MAX', 48000),     priority:true,  deep:true,  companion:true }
    });
}

// Plan ids that were sold before the tiers existed. One order was created
// against 'student' and never paid, but a receipt or an old link must still
// resolve to something rather than throwing.
const LEGACY = Object.freeze({ student: 'pro', developer: 'pro' });

function tierOf(planId) {
    const all = tiers();
    const id = String(planId || 'free');
    return all[id] || all[LEGACY[id]] || all.free;
}

// What one action costs. These follow aiBrain's token budgets, so a request
// that is allowed more output is charged more.
// A question costs 10, whatever its length. The previous scale charged 1, 3 or
// 8 by how long the answer was allowed to be, which tracked the bill more
// closely but meant nobody could predict what a question would cost before
// asking it. A flat price is worth more to a student than a precise one: 350
// free credits is plainly 35 questions.
//
// The heavier actions stay above it, in proportion to what they actually cost
// to serve rather than as round numbers.
const COST = Object.freeze({
    question: 10,      // any answer, brief or detailed
    brief: 10, normal: 10, deep: 10,   // depth no longer changes the price
    json: 15,          // worksheets, quizzes, flashcard packs — strict documents
    speech: 15,        // text to speech
    page: 10,          // one page of OCR or document extraction
    image: 50,         // the most expensive single thing the app can be asked for
    roadmap: 150       // many model calls behind one button
});

function costOf(kind, depth) {
    if (kind && Object.hasOwn(COST, kind)) return COST[kind];
    return COST[depth] ?? COST.normal;
}

function toolAllowed(tier, toolId) {
    if (tier.tools === 'all') return true;
    const index = TOOL_ORDER.indexOf(String(toolId));
    // A tool nobody listed is treated as premium rather than free: failing
    // open here would quietly give every tier the whole catalogue again.
    if (index === -1) return false;
    return index < tier.tools;
}

function toolsFor(tier) {
    return tier.tools === 'all' ? TOOL_ORDER.slice() : TOOL_ORDER.slice(0, tier.tools);
}

// The cheapest tier that opens a given tool, so a locked tool can say what
// would unlock it instead of only saying no.
function requiredTierFor(toolId) {
    const index = TOOL_ORDER.indexOf(String(toolId));
    const ordered = Object.values(tiers()).sort((a, b) => a.rank - b.rank);
    if (index === -1) return ordered[ordered.length - 1];
    return ordered.find(t => t.tools === 'all' || index < t.tools) || ordered[ordered.length - 1];
}

// The cheapest tier that includes the conversational tutor.
function companionTier() {
    return Object.values(tiers()).sort((a, b) => a.rank - b.rank).find(t => t.companion);
}

// A single switch, so enforcement can be turned off without unpicking it.
// Default on: a plan nobody enforces is not a plan.
const enforced = () => process.env.PLANS_ENFORCED !== 'false';

module.exports = { TOOL_ORDER, tiers, tierOf, COST, costOf, toolAllowed, toolsFor, requiredTierFor, companionTier, enforced, LEGACY };
