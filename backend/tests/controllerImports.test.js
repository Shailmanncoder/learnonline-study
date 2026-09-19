// The textbook block in the chat handler runs inside a try/catch that logs
// "[NCERT CONTEXT] unavailable" and carries on. So a function it uses but
// never imported (resolveBookSelection, for months) does not crash anything:
// it silently turns textbook grounding off for every message. This test
// fails instead.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('every ncertContext export the chat handler uses is imported', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'aiController.js'), 'utf8');
    const exported = Object.keys(require('../services/ncertContext'));
    const importMatch = src.match(/const\s*\{([^}]+)\}\s*=\s*require\('\.\.\/services\/ncertContext'\)/);
    assert.ok(importMatch, 'aiController must import from ncertContext');
    const imported = new Set(importMatch[1].split(',').map(x => x.trim()).filter(Boolean));
    const body = src.replace(importMatch[0], '');
    const used = exported.filter(name => new RegExp(`\\b${name}\\b`).test(body));
    const missing = used.filter(name => !imported.has(name));
    assert.deepEqual(missing, [], `used but not imported: ${missing.join(', ')}`);
});
