const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// These guard the two dead ends found by exercising the teacher portal: a
// blocked student who could never be let back in, and a class that could be
// archived but never reopened. Both reported success while leaving the user
// stuck, which is why neither showed up as an error anywhere.
const source = fs.readFileSync(path.join(__dirname, '../controllers/teacherController.js'), 'utf8');
const routeBody = (marker) => {
    const start = source.indexOf(marker);
    assert.ok(start > -1, `route not found: ${marker}`);
    const next = source.indexOf("\nrouter.", start + 1);
    return source.slice(start, next === -1 ? source.length : next);
};

test('unblocking a student restores their enrolment, not just the restriction row', () => {
    const body = routeBody("router.post('/classes/:id/students/unblock'");
    assert.match(body, /UPDATE class_enrollments SET status = 'active'/,
        'deleting the restriction alone leaves the enrolment blocked, which is the row the access check reads');
    assert.match(body, /DELETE FROM class_student_restrictions/);
    assert.match(body, /status = 'blocked'/,
        'only a block should be reversed here; a removed student is a separate decision');
    assert.match(body, /INVALID_INPUT/, 'a missing student id must not silently succeed');
});

test('an archived class accepts no new work, and can be reopened', () => {
    assert.match(source, /async function classClosedForWriting/,
        'the archive state needs one shared check rather than four copies');
    for (const route of ["router.post('/announcements'", "router.post('/homework'",
                         "router.post('/notes'", "router.post('/worksheets/publish'"]) {
        assert.match(routeBody(route), /classClosedForWriting\(classId, res\)/,
            `${route} would still write into an archived class`);
    }
    assert.match(source, /router\.post\('\/classes\/:id\/restore'/,
        'archiving must not be a one-way door');
});
