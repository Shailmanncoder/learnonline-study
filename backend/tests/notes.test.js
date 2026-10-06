const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FRONTEND = path.join(__dirname, '../../frontend');
const api = fs.readFileSync(path.join(FRONTEND, 'api.js'), 'utf8');
const app = fs.readFileSync(path.join(FRONTEND, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
const userController = fs.readFileSync(path.join(__dirname, '../controllers/userController.js'), 'utf8');

test('every api.* the frontend calls actually exists', () => {
    // Two did not. api.createNote threw "is not a function" on the Developer
    // Hub's save button, and api.deleteNote meant the Note Taker's Delete
    // could never have worked. Neither fails until a user clicks the button,
    // so nothing caught them.
    const defined = new Set([...api.matchAll(/^\s{4}([a-zA-Z0-9_]+):\s*(?:async\s*)?\(/gm)].map(m => m[1]));
    assert.ok(defined.size > 50, 'failed to parse the api object');

    const dangling = [];
    for (const file of fs.readdirSync(FRONTEND).filter(f => f.endsWith('.js'))) {
        const src = fs.readFileSync(path.join(FRONTEND, file), 'utf8');
        for (const m of src.matchAll(/\bapi\.([a-zA-Z0-9_]+)\s*\(/g)) {
            if (!defined.has(m[1])) {
                dangling.push(`api.${m[1]} at ${file}:${src.slice(0, m.index).split('\n').length}`);
            }
        }
    }
    assert.deepEqual(dangling, [], 'these calls would throw "is not a function" when clicked');
});

test('a note can be updated and deleted, by its owner only', () => {
    // The Note Taker could only ever create. There was no PUT and no DELETE,
    // so editing a note left a second copy and Delete did nothing at all.
    assert.match(userController, /router\.put\('\/notes\/:id'/, 'no route to update a note');
    assert.match(userController, /router\.delete\('\/notes\/:id'/, 'no route to delete a note');

    const owned = userController.slice(userController.indexOf("router.put('/notes/:id'"));
    assert.match(owned, /UPDATE notes SET title = \?, content = \? WHERE id = \? AND user_id = \?/,
        'an update must be scoped to the signed-in user');
    assert.match(owned, /DELETE FROM notes WHERE id = \? AND user_id = \?/,
        'a delete must be scoped to the signed-in user');
    assert.ok((owned.match(/Note not found/g) || []).length >= 2,
        'another account’s note id should read as missing, not be acted on');
});

test('the editor knows which note it has open', () => {
    // window.currentNoteId was read in three places and assigned in none, so
    // Delete always fell through to blanking the two fields while the note
    // stayed in the list, and Save always created a new note.
    assert.match(app, /function setCurrentNote\(/, 'nothing tracked the open note');
    assert.match(app, /currentNoteId = id/, 'the open note id must actually be stored');
    const save = app.slice(app.indexOf("'save-note-btn'"), app.indexOf("'save-note-btn'") + 1400);
    assert.match(save, /if \(currentNoteId\)[\s\S]*api\.updateNote\(/,
        'saving an open note must update it, not create a duplicate');
});

test('loading notes does not destroy the sidebar around them', () => {
    // loadNotes emptied #notes-list, which is the whole sidebar: it took the
    // search box and the items container with it, leaving the search input
    // listening on a node no longer in the page.
    const load = app.slice(app.indexOf('async function loadNotes()'), app.indexOf('async function loadNotes()') + 1800);
    assert.match(load, /getElementById\('notes-items-container'\)/,
        'notes belong in the items container, not the sidebar wrapper');
    assert.ok(!/getElementById\('notes-list'\)/.test(load),
        'emptying #notes-list removes the search box');
    assert.ok(html.includes('id="notes-search"') && html.includes('id="notes-items-container"'));
});

test('New Note is wired up', () => {
    // The button existed in the page with no handler anywhere.
    assert.match(app, /safeOn\('new-note-btn', 'click'/);
    assert.match(app, /function clearNoteEditor\(/);
});
