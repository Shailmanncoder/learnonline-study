// Which provider answers, and with which model, is decided by environment
// variables — so it is the kind of thing that breaks quietly. No network here:
// these are the pure decisions the four call sites share.
const test = require('node:test');
const assert = require('node:assert/strict');
const { providerOrder, geminiKey, geminiModel } = require('../services/ai');

function withEnv(vars, fn) {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try { return fn(); }
    finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

test('AI_PROVIDER decides who answers first, and the other stays as fallback', () => {
    // Unset must keep the behaviour every deploy had before this setting existed.
    withEnv({ AI_PROVIDER: undefined }, () => {
        assert.deepEqual(providerOrder(), ['groq', 'gemini']);
    });
    withEnv({ AI_PROVIDER: 'groq' }, () => {
        assert.deepEqual(providerOrder(), ['groq', 'gemini']);
    });
    withEnv({ AI_PROVIDER: 'gemini' }, () => {
        assert.deepEqual(providerOrder(), ['gemini', 'groq']);
    });
    // Tolerate how a value actually gets typed into a .env file.
    for (const value of ['Gemini', ' GEMINI ', 'gemini\t']) {
        withEnv({ AI_PROVIDER: value }, () => {
            assert.deepEqual(providerOrder(), ['gemini', 'groq'], `"${value}" should select Gemini`);
        });
    }
    // A typo must not silently leave the app with no provider.
    withEnv({ AI_PROVIDER: 'gemni' }, () => {
        assert.deepEqual(providerOrder(), ['groq', 'gemini'], 'an unrecognised value falls back to the default order');
    });
    // Both providers are always present in the order, so one is always the backup.
    for (const value of [undefined, 'groq', 'gemini']) {
        withEnv({ AI_PROVIDER: value }, () => {
            assert.equal(new Set(providerOrder()).size, 2);
        });
    }
});

test('a placeholder or stub Gemini key does not count as a key', () => {
    for (const value of [undefined, '', 'your_gemini_api_key_here', 'short']) {
        withEnv({ GEMINI_API_KEY: value }, () => {
            assert.equal(geminiKey(), null, `${JSON.stringify(value)} must not be treated as a usable key`);
        });
    }
    withEnv({ GEMINI_API_KEY: 'A'.repeat(39) }, () => {
        assert.equal(geminiKey(), 'A'.repeat(39));
    });
});

test('GEMINI_MODEL only accepts Gemini model names', () => {
    withEnv({ GEMINI_MODEL: undefined }, () => {
        assert.equal(geminiModel(), 'gemini-2.5-flash');
    });
    withEnv({ GEMINI_MODEL: 'gemini-2.5-pro' }, () => {
        assert.equal(geminiModel(), 'gemini-2.5-pro');
    });
    // A Groq model id in this variable would otherwise be sent to Google.
    for (const wrong of ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', '../../etc/passwd', 'gpt-4']) {
        withEnv({ GEMINI_MODEL: wrong }, () => {
            assert.equal(geminiModel(), 'gemini-2.5-flash', `${wrong} must not be used as a Gemini model`);
        });
    }
});
