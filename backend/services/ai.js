// ================================================================
// Shared AI service
// ----------------------------------------------------------------
// One place for provider choice, model routing and rate-limit
// handling. Controllers should call this rather than instantiating
// their own Groq/Gemini clients.
// ================================================================

// ── Which provider answers first ──────────────────────────────────
// AI_PROVIDER=gemini tries Gemini before Groq; anything else, or unset, keeps
// Groq first, which is what every deploy did before this setting existed. The
// other provider always stays as the fallback, so losing one does not take the
// AI features down with it.
//
// Four places used to hard-code "Groq, then Gemini" — this service, the chat
// controller, and the quiz and worksheet generators. They all read this now, so
// the preference cannot apply to some screens and not others.
function providerOrder() {
    const preferred = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
    // Whichever provider is preferred answers first; the others stay behind it
    // as fallbacks, so losing one does not take the AI features down. OpenAI is
    // only ever in the list when a key is actually configured, so adding the
    // support now cannot change behaviour until that key exists.
    // Unset keeps the order every deploy had before this setting existed —
    // Groq first — so adding provider support never silently reroutes a
    // deployment that has not asked for it. This app's .env sets gemini.
    const base = ['groq', 'gemini'].concat(openaiKey() ? ['openai'] : []);
    if (!base.includes(preferred)) return base;
    return [preferred, ...base.filter(p => p !== preferred)];
}

// An OpenAI key that is absent, or still a placeholder, is not a key.
function openaiKey() {
    const key = process.env.OPENAI_API_KEY;
    return key && !/^your_|_here$/i.test(key) && key.length > 20 ? key : null;
}

function openaiModel() {
    return String(process.env.OPENAI_MODEL || '').trim() || 'gpt-4o-mini';
}

// A Gemini key that is absent, or still the placeholder from .env.example, is
// not a key.
function geminiKey() {
    const key = process.env.GEMINI_API_KEY;
    return key && key !== 'your_gemini_api_key_here' && key.length > 10 ? key : null;
}

// One catalogue for the whole app: this returned gemini-2.5-flash, which now
// 404s as "no longer available to new users", so every call through this
// service would have failed while the chat controller used a live model.
const { MODEL_BY_ID, DEFAULT_MODEL } = require('./geminiModels');
const brainSvc = require('./aiBrain');
function geminiModel() {
    const requested = String(process.env.GEMINI_MODEL || '').trim();
    return MODEL_BY_ID.has(requested) ? requested : DEFAULT_MODEL;
}

// Task → model. Mirrors the routing in controllers/aiController.js.
const TASK_MODELS = {
    fast:      'openai/gpt-oss-20b',
    general:   'openai/gpt-oss-120b',
    reasoning: 'openai/gpt-oss-120b',
    // qwen3.6-27b was retired from the account (404 "does not exist");
    // qwen3.8-27b replaced it and is the only model here that reads images.
    vision:    'qwen/qwen3.8-27b',
    longdoc:   'qwen/qwen3.8-27b'
};

// ── Model fallback ────────────────────────────────────────────────
// Every Groq model has its OWN per-minute token quota (8,000 on this tier).
// A single textbook or uploaded-PDF question can use several thousand, so
// two quick questions exhaust one model while the others sit idle. Falling
// through to the next model turns "AI is busy" into an answer.
const TEXT_FALLBACKS = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'];
// Only qwen reads images; a text-only fallback would silently ignore the
// picture the student sent, so image requests retry on qwen alone.
const VISION_FALLBACKS = ['qwen/qwen3.8-27b'];

function modelChain(primary, { hasImages = false } = {}) {
    const pool = hasImages ? VISION_FALLBACKS : TEXT_FALLBACKS;
    return [...new Set([primary, ...pool])].filter(Boolean)
        .filter((m) => !hasImages || VISION_FALLBACKS.includes(m));
}

// Worth trying another model for: quota (429), request over the per-minute
// budget (413), a retired or inaccessible model (404), provider trouble
// (5xx), timeouts, and a model rejecting a parameter only it lacks.
function isRetryable(err) {
    const status = err?.status || err?.response?.status;
    const msg = String(err?.message || '');
    if ([404, 413, 429, 500, 502, 503, 504].includes(status)) return true;
    if (/rate.?limit|too large|does not exist|do not have access|overloaded|timed? ?out|ECONNRESET|ETIMEDOUT/i.test(msg)) return true;
    return status === 400 && /response_format|reasoning_(format|effort)|not supported|json_validate_failed|failed to generate JSON/i.test(msg);
}

function groqClient() {
    const key = process.env.GROQ_API_KEY;
    if (!key || key === 'your_groq_api_key_here' || key.length < 6) return null;
    try {
        const Groq = require('groq-sdk');
        return new Groq({ apiKey: key });
    } catch (e) {
        console.warn('[AI] Groq SDK unavailable:', e.message);
        return null;
    }
}

// Qwen emits raw <think> blocks unless reasoning_format is set; strip as a backstop.
function stripThink(text) {
    return String(text || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<think>[\s\S]*$/i, '')
        .trim();
}

function reasoningParams(model, task) {
    if (model.startsWith('qwen/')) {
        return task === 'fast' ? { reasoning_effort: 'none' } : { reasoning_format: 'hidden' };
    }
    if (model.startsWith('openai/gpt-oss')) {
        return { reasoning_effort: task === 'reasoning' ? 'high' : 'medium' };
    }
    return {};
}

/**
 * Generate text from the configured provider.
 * Falls back Groq → Gemini → '' so callers can always degrade gracefully.
 */
async function generateText(prompt, systemInstruction = 'You are a helpful assistant.', opts = {}) {
    const {
        task = 'general', json = false, maxTokens, schema,
        // Shared-brain context. Any caller can pass these; nothing breaks when
        // they do not, which is why the tools could be given context without
        // touching 50 call sites.
        profile = null, facts = [], weakTopics = [], topic = '',
        depth,              // force 'brief' | 'normal' | 'deep'
        brain: useBrain = true
    } = opts;
    const model = TASK_MODELS[task] || TASK_MODELS.general;

    // A JSON generator must not be told to answer conversationally, and its
    // schema instruction is the whole point — so the brain stays out of those.
    const wantsBrain = useBrain && !json && !schema;
    const level = depth || (task === 'reasoning' ? 'deep' : brainSvc.depthOf(prompt));
    const system = wantsBrain
        ? brainSvc.withBrain(systemInstruction, { depth: level, profile, facts, weakTopics, topic, prompt })
        : systemInstruction;

    // The budget follows the same judgement: a short answer given a 4000-token
    // allowance reliably grew to fill it, which is why every reply used to
    // arrive as an essay. The on-demand tier also caps tokens/minute at 8000
    // and max_tokens counts toward that, so staying low is cheaper and faster.
    const budget = maxTokens || (wantsBrain ? brainSvc.BUDGET[level] : (task === 'reasoning' ? 5000 : 4000));

    const tryGroq = async () => {
        const groq = groqClient();
        if (!groq) return null;
        const call = (m, tokens) => groq.chat.completions.create({
            model: m,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: prompt }
            ],
            temperature: 0.2,
            max_tokens: tokens,
            ...(json ? { response_format: schema && ['openai/gpt-oss-120b','openai/gpt-oss-20b','qwen/qwen3.8-27b'].includes(m)
                ? { type:'json_schema',json_schema:{name:'study_material',strict:true,schema} }
                : { type: 'json_object' } } : {}),
            ...reasoningParams(m, task)
        });

        for (const m of modelChain(model)) {
            try {
                const c = await call(m, m === model || schema ? budget : Math.min(budget, 3000));
                const text = stripThink(c.choices[0]?.message?.content);
                // An empty reply (reasoning spent the budget) is a miss, not an answer.
                if (!text) { console.warn(`[AI] ${m} returned an empty answer — trying next model`); continue; }
                if (m !== model) console.warn(`[AI] ${model} unavailable — answered with ${m}`);
                return text;
            } catch (err) {
                // Provider errors may embed the entire generated private document.
                if (!isRetryable(err)) { console.warn('[AI] Groq request failed:', err.status || 'network'); break; }
                console.warn(`[AI] ${m} unavailable (${err.status || 'network'}) — trying next model`);
            }
        }
        return null;
    };

    const tryGemini = async () => {
        const key = geminiKey();
        if (!key) return null;
        try {
            const { GoogleGenerativeAI } = require('@google/generative-ai');
            const genAI = new GoogleGenerativeAI(key);
            const m = genAI.getGenerativeModel({ model: geminiModel(),generationConfig:{maxOutputTokens:budget,...(json?{responseMimeType:'application/json'}:{})} });
            const result = await m.generateContent(`${system}\n\n${prompt}`);
            return result.response.text() || null;
        } catch (e) {
            console.warn('[AI] Gemini request failed:', e.status || 'provider unavailable');
            return null;
        }
    };

    // OpenAI speaks the same chat-completions shape as Groq, so the Groq
    // client library drives it with a different baseURL and key.
    const tryOpenAI = async () => {
        const key = openaiKey();
        if (!key) return null;
        try {
            const OpenAI = require('openai');
            const client = new OpenAI({ apiKey: key });
            const c = await client.chat.completions.create({
                model: openaiModel(),
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.2,
                max_tokens: budget,
                ...(json ? { response_format: { type: 'json_object' } } : {})
            });
            return stripThink(c.choices[0]?.message?.content) || null;
        } catch (e) {
            console.warn('[AI] OpenAI request failed:', e.status || 'provider unavailable');
            return null;
        }
    };

    const PROVIDERS = { gemini: tryGemini, groq: tryGroq, openai: tryOpenAI };
    for (const provider of providerOrder()) {
        const run = PROVIDERS[provider];
        if (!run) continue;
        const text = await run();
        if (text) return text;
    }

    return '';
}

/**
 * Generate and parse JSON. Returns `fallback` if the model returns
 * nothing usable, so callers never have to try/catch a parse.
 */
async function generateJSON(prompt, systemInstruction, opts = {}, fallback = null) {
    const raw = await generateText(prompt, systemInstruction, { ...opts, json: true });
    if (!raw) return fallback;
    try {
        return JSON.parse(raw.replace(/```json/gi, '').replace(/```/gi, '').trim());
    } catch (e) {
        // Models occasionally wrap or prepend prose — salvage the outermost object.
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) {
            try { return JSON.parse(m[0]); } catch (e2) { /* fall through */ }
        }
        console.warn('[AI] The response was not valid JSON.');
        return fallback;
    }
}

module.exports = {
    modelChain, isRetryable, TEXT_FALLBACKS, VISION_FALLBACKS, generateText, generateJSON, TASK_MODELS,
    providerOrder, geminiKey, geminiModel, openaiKey, openaiModel };
