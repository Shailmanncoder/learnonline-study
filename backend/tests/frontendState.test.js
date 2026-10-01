const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Exercise the actual browser storage helpers with two signed-in accounts.
const source = fs.readFileSync(path.join(__dirname, '../../frontend/app.js'), 'utf8');
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
test('browser activity, skills and favourites never carry into another account', () => {
    const values = new Map();
    const context = vm.createContext({
        currentUserData: { id: 1 },
        localStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) },
        renderDevSkills() {}, showToast() {}
    });
    vm.runInContext([
        between('function accountStorageKey(', 'function recordActivity('),
        between('function getDeveloperSkills(', '// These are browser-local'),
        between('function getFavoritesList(', 'function toggleFavoriteTool(')
    ].join('\n'), context);
    vm.runInContext("saveActivity([{name:'My private study topic'}]); saveDeveloperSkills([{name:'Rust',level:'Beginner'}]); localStorage.setItem(accountStorageKey('favTools'), '[\"math\"]')", context);
    assert.equal(vm.runInContext('loadActivity().length + getDeveloperSkills().length + getFavoritesList().length', context), 3);
    context.currentUserData = { id: 2 };
    assert.equal(vm.runInContext('loadActivity().length + getDeveloperSkills().length + getFavoritesList().length', context), 0);
    context.currentUserData = { id: 1 };
    assert.equal(vm.runInContext('getDeveloperSkills()[0].name', context), 'Rust');
    vm.runInContext('saveDeveloperSkills([])', context);
    assert.equal(vm.runInContext('getDeveloperSkills().length', context), 0, 'removing the last skill must not restore invented skills');
});
