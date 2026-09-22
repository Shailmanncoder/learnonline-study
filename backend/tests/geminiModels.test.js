// Which model answers a question, and the reason the student is shown for it.
// This routing is visible in the UI, so a wrong turn here is a wrong claim on
// screen — not just a slower answer.
const test = require('node:test');
const assert = require('node:assert/strict');
const { GEMINI_MODELS, chooseModel, DEFAULT_MODEL, defaultModel } = require('../services/geminiModels');

const idOf = (tier) => GEMINI_MODELS.find(m => m.tier === tier).id;

test('the catalogue only offers models that exist for a current key', () => {
    // The 2.5 family answers 404 "no longer available to new users", so
    // offering it would give students a model that cannot reply.
    for (const m of GEMINI_MODELS) {
        assert.ok(!m.id.startsWith('gemini-2.5'), `${m.id} is retired and must not be offered`);
        assert.match(m.id, /^gemini-[0-9.]+-/);
        assert.ok(m.label && m.bestFor, `${m.id} needs a label and a "best for" line`);
        assert.ok(['deep', 'balanced', 'fast'].includes(m.tier));
    }
    // Exactly one model per tier, or Auto has nothing definite to choose.
    assert.equal(new Set(GEMINI_MODELS.map(m => m.tier)).size, GEMINI_MODELS.length);
    assert.equal(DEFAULT_MODEL, idOf('balanced'));
});

test('an explicit choice is honoured and is not overridden by routing', () => {
    for (const m of GEMINI_MODELS) {
        // A short factual question would otherwise route to the fast model.
        const picked = chooseModel({ requested: m.id, prompt: 'what is a cell' });
        assert.equal(picked.id, m.id);
        assert.equal(picked.auto, false);
        assert.match(picked.reason, /you chose/i);
    }
});

test('an unknown or hostile model id falls back to routing rather than being used', () => {
    for (const bad of ['gemini-2.5-flash', 'gpt-4', 'models/../secret', '', null, undefined, 'gemini-99-ultra']) {
        const picked = chooseModel({ requested: bad, prompt: 'explain why the sky is blue' });
        assert.ok(GEMINI_MODELS.some(m => m.id === picked.id), `${bad} produced an off-catalogue model`);
    }
});

test('Auto sends work that needs steps to the deep model, and short recall to the fast one', () => {
    const deep = idOf('deep');
    const fast = idOf('fast');
    const balanced = idOf('balanced');

    for (const prompt of [
        'prove that the square root of 2 is irrational',
        'compare mitosis and meiosis',
        'why does ice float on water',
        'explain step by step how to solve quadratic equations',
        'discuss the advantages and disadvantages of nuclear power'
    ]) {
        const picked = chooseModel({ requested: 'auto', prompt });
        assert.equal(picked.id, deep, `"${prompt}" should go deep`);
        assert.equal(picked.auto, true);
        assert.ok(picked.reason.length > 3, 'a reason is shown to the student, so it must be there');
    }

    for (const prompt of ['what is photosynthesis', 'define inertia', 'who is the author of Panchatantra']) {
        assert.equal(chooseModel({ requested: 'auto', prompt }).id, fast, `"${prompt}" should go fast`);
    }

    // Anything that is neither obviously heavy nor obviously trivial.
    assert.equal(chooseModel({ requested: 'auto', prompt: 'help me with my homework on fractions please' }).id, balanced);

    // A long question is held together better by the deep model.
    assert.equal(chooseModel({ requested: 'auto', prompt: 'x'.repeat(500) }).id, deep);

    // An attached image needs a model that can read it.
    const withImage = chooseModel({ requested: 'auto', prompt: 'what is this', hasImages: true });
    assert.equal(withImage.id, balanced);
    assert.match(withImage.reason, /image/i);

    // The reasoning task hint routes deep even without a textual cue.
    assert.equal(chooseModel({ requested: 'auto', prompt: 'solve it', task: 'reasoning' }).id, deep);
});

test('routing always returns a usable model, whatever it is handed', () => {
    for (const args of [undefined, {}, { prompt: null }, { prompt: 123 }, { requested: 'auto' }, { prompt: '' }]) {
        const picked = chooseModel(args);
        assert.ok(GEMINI_MODELS.some(m => m.id === picked.id), `${JSON.stringify(args)} produced ${picked && picked.id}`);
        assert.ok(picked.reason, 'every answer carries a reason');
    }
});

test('GEMINI_MODEL can change the default, but only to a model we have', () => {
    const saved = process.env.GEMINI_MODEL;
    try {
        process.env.GEMINI_MODEL = idOf('fast');
        assert.equal(defaultModel(), idOf('fast'));
        // A retired or foreign id must not become the default.
        for (const bad of ['gemini-2.5-flash', 'openai/gpt-oss-120b', 'nonsense']) {
            process.env.GEMINI_MODEL = bad;
            assert.equal(defaultModel(), DEFAULT_MODEL, `${bad} must not become the default`);
        }
        delete process.env.GEMINI_MODEL;
        assert.equal(defaultModel(), DEFAULT_MODEL);
    } finally {
        if (saved === undefined) delete process.env.GEMINI_MODEL;
        else process.env.GEMINI_MODEL = saved;
    }
});
