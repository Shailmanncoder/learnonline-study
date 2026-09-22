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
    return preferred === 'gemini' ? ['gemini', 'groq'] : ['groq', 'gemini'];
}

// A Gemini key that is absent, or still the placeholder from .env.example, is
// not a key.
function geminiKey() {
    const key = process.env.GEMINI_API_KEY;
    return key && key !== 'your_gemini_api_key_here' && key.length > 10 ? key : null;
}

// Only Gemini model names, so a stray GROQ_MODEL-style value cannot be sent to
// Google as a model id.
function geminiModel() {
    const requested = String(process.env.GEMINI_MODEL || '').trim();
    return /^gemini-[a-z0-9.\-]+$/i.test(requested) ? requested : 'gemini-2.5-flash';
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
    return status === 400 && /response_format|reasoning_(format|effort)|not supported/i.test(msg);
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
    const { task = 'general', json = false, maxTokens } = opts;
    const model = TASK_MODELS[task] || TASK_MODELS.general;
    // The on-demand tier caps total tokens/minute at 8000, and max_tokens
    // counts toward it — stay well under.
    const budget = maxTokens || (task === 'reasoning' ? 5000 : 4000);

    const tryGroq = async () => {
        const groq = groqClient();
        if (!groq) return null;
        const call = (m, tokens) => groq.chat.completions.create({
            model: m,
            messages: [
                { role: 'system', content: systemInstruction },
                { role: 'user', content: prompt }
            ],
            temperature: 0.2,
            max_tokens: tokens,
            ...(json ? { response_format: { type: 'json_object' } } : {}),
            ...reasoningParams(m, task)
        });

        for (const m of modelChain(model)) {
            try {
                const c = await call(m, m === model ? budget : Math.min(budget, 3000));
                const text = stripThink(c.choices[0]?.message?.content);
                // An empty reply (reasoning spent the budget) is a miss, not an answer.
                if (!text) { console.warn(`[AI] ${m} returned an empty answer — trying next model`); continue; }
                if (m !== model) console.warn(`[AI] ${model} unavailable — answered with ${m}`);
                return text;
            } catch (err) {
                if (!isRetryable(err)) { console.warn('[AI] Groq error:', err.message); break; }
                console.warn(`[AI] ${m} unavailable (${err.status || err.message}) — trying next model`);
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
            const m = genAI.getGenerativeModel({ model: geminiModel() });
            const result = await m.generateContent(`${systemInstruction}\n\n${prompt}`);
            return result.response.text() || null;
        } catch (e) {
            console.warn('[AI] Gemini error:', e.message);
            return null;
        }
    };

    for (const provider of providerOrder()) {
        const text = provider === 'gemini' ? await tryGemini() : await tryGroq();
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
        console.warn('[AI] JSON parse failed:', e.message);
        return fallback;
    }
}

module.exports = {
    modelChain, isRetryable, TEXT_FALLBACKS, VISION_FALLBACKS, generateText, generateJSON, TASK_MODELS,
    providerOrder, geminiKey, geminiModel };
