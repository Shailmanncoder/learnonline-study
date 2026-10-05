const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// A student submitted 2/2 and then 0/2 on a retake. Their own screen showed 2
// (their best); the teacher's analysis counted 0 (their latest). Both numbers
// described the same worksheet and disagreed, and nothing reported an error.
const classroom = fs.readFileSync(path.join(__dirname, '../controllers/classroomController.js'), 'utf8');
const teacher = fs.readFileSync(path.join(__dirname, '../controllers/teacherController.js'), 'utf8');

test('the score a student sees is the attempt the teacher counts', () => {
    assert.ok(!/ORDER BY score DESC LIMIT 1\) as my_score/.test(classroom),
        'my_score must not be the best attempt while the teacher grades the latest');
    assert.match(classroom, /ORDER BY submitted_at DESC, id DESC LIMIT 1\) as my_score/,
        'my_score should be the latest attempt, which is the one that counts');
    assert.match(classroom, /as my_best_score/,
        'the best attempt is still worth showing, just not as the headline');
});

test('attempt ordering is deterministic', () => {
    // Two attempts saved in the same second ordered arbitrarily, so which one
    // "counted" could change between two reads of the same data.
    const ordered = teacher.match(/ORDER BY wa\.submitted_at DESC[^`]*/g) || [];
    assert.ok(ordered.length > 0, 'expected attempt queries to exist');
    for (const clause of ordered) {
        assert.match(clause, /wa\.id DESC/, `needs an id tie-break: ${clause.trim()}`);
    }
});

test('the worksheet window and attempt limit are enforced', () => {
    // These three columns existed on class_worksheets and nothing ever read
    // them, so a worksheet could be answered before it opened, after it closed,
    // and any number of times.
    for (const token of ['NOT_OPEN_YET', 'CLOSED', 'NO_ATTEMPTS_LEFT']) {
        assert.ok(classroom.includes(token), `submission should be able to refuse with ${token}`);
    }
    assert.match(teacher, /max_attempts/, 'a teacher must be able to set the limit when publishing');
});
