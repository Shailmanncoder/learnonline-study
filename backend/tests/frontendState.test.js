const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Exercise the actual browser storage helpers with two signed-in accounts.
//
// Developer skills used to be asserted here too. They are no longer kept in
// the browser at all: they live in developer_skills, scoped by user_id, and
// the isolation that matters for them is the server's — one account asking to
// delete another's skill gets a 404, not a deletion. What remains in
// localStorage is recent activity and favourite tools, and those still have to
// stay with the account that created them when someone else signs in on the
// same machine.
const source = fs.readFileSync(path.join(__dirname, '../../frontend/app.js'), 'utf8');
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test('browser activity and favourites never carry into another account', () => {
    const values = new Map();
    const context = vm.createContext({
        currentUserData: { id: 1 },
        localStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) },
        showToast() {}
    });
    vm.runInContext([
        between('function accountStorageKey(', 'function recordActivity('),
        between('function getFavoritesList(', 'function toggleFavoriteTool(')
    ].join('\n'), context);

    vm.runInContext("saveActivity([{name:'My private study topic'}]); localStorage.setItem(accountStorageKey('favTools'), '[\"math\"]')", context);
    assert.equal(vm.runInContext('loadActivity().length + getFavoritesList().length', context), 2);

    context.currentUserData = { id: 2 };
    assert.equal(vm.runInContext('loadActivity().length + getFavoritesList().length', context), 0,
        'a second account on the same browser must start empty');

    context.currentUserData = { id: 1 };
    assert.equal(vm.runInContext('loadActivity()[0].name', context), 'My private study topic',
        'the first account gets its own history back');
});

test('the Developer Hub no longer keeps skills or progress in the browser', () => {
    // A regression guard for the move to the server: if these helpers come
    // back, the data is being written somewhere a second device cannot see.
    assert.ok(!/function saveDeveloperSkills\(/.test(source),
        'saveDeveloperSkills would mean skills are being stored in the browser again');
    assert.ok(!/localStorage\.setItem\(accountStorageKey\('devUserSkills'\)/.test(source),
        'devUserSkills must only be READ, for the one-time import');
    assert.ok(!/localStorage\.setItem\(accountStorageKey\('devProgress'\)/.test(source),
        'devProgress must only be READ, for the one-time import');
    assert.ok(/api\.getDeveloperHub\(/.test(source), 'the Hub must load from the server');
});
