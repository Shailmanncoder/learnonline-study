// Local sentence embeddings. Groq has no embeddings endpoint and a hosted
// one would bill per chunk, so this runs on CPU: all-MiniLM-L6-v2, 384
// dims, normalised for cosine similarity. The model (~87MB) is cached under
// node_modules/@huggingface/transformers/.cache, and baked into the Docker
// image so a container never has to fetch it.
const RETRIES = 3;
const BACKOFF_MS = 1500;

// The in-flight promise, not the resolved pipeline: caching the resolved
// value let concurrent first-callers each kick off their own download.
let loading = null;

async function load() {
    const { pipeline } = await import('@huggingface/transformers');
    let lastError;
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
        try {
            return await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
        } catch (e) {
            lastError = e;
            // A cold start can race the network. Retry rather than leaving
            // the tutor silently unable to retrieve for the process lifetime.
            if (attempt < RETRIES) await new Promise(r => setTimeout(r, BACKOFF_MS * attempt));
        }
    }
    throw lastError;
}

function getEmbedder() {
    // A failed load must not poison the cache — clear it so the next caller
    // can try again.
    return loading ||= load().catch((e) => { loading = null; throw e; });
}

// Load the model before any request needs it. Failure here is logged and
// not fatal: retrieval degrades to the keyword path, the site still serves.
async function warmup() {
    try {
        await getEmbedder();
        return true;
    } catch (e) {
        console.warn('[EMBEDDER] model unavailable, semantic search disabled until it loads:', e.message);
        return false;
    }
}

// Batching matters: per-call overhead dominates for short texts.
async function embedAll(texts, batchSize = 32) {
    const embed = await getEmbedder();
    const out = [];
    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const res = await embed(batch, { pooling: 'mean', normalize: true });
        out.push(...res.tolist());
    }
    return out;
}

async function embedOne(text) {
    return (await embedAll([text]))[0];
}

module.exports = { getEmbedder, warmup, embedAll, embedOne };
