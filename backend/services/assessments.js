// Worksheet question rules, in one place, so "what a student may see" and
// "what counts as a publishable worksheet" cannot drift apart between the
// teacher portal, the student feed and the grader.

const OBJECTIVE_TYPES = ['mcq', 'true_false', 'fill_blank'];
const SUBJECTIVE_TYPES = ['short_answer', 'long_answer'];
const QUESTION_TYPES = [...OBJECTIVE_TYPES, ...SUBJECTIVE_TYPES];

const MAX_QUESTIONS = 100;
const MAX_MARKS_PER_QUESTION = 100;
const MAX_ANSWER_LENGTH = 20000;

const isObjective = (type) => OBJECTIVE_TYPES.includes(type);

function parseWorksheetData(raw) {
    if (!raw) return { questions: [] };
    if (typeof raw === 'object') return raw;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : { questions: [] };
    } catch {
        return { questions: [] };
    }
}

// Rejects a worksheet that cannot be graded fairly, rather than letting it
// reach students and fail one answer at a time. Returns the normalised
// questions and the total derived from them — a teacher-supplied total that
// disagrees with the questions is not authoritative.
function validateWorksheet(rawData) {
    const data = parseWorksheetData(rawData);
    const questions = Array.isArray(data.questions) ? data.questions : [];
    const errors = [];

    if (questions.length === 0) errors.push('A worksheet needs at least one question.');
    if (questions.length > MAX_QUESTIONS) errors.push(`A worksheet cannot have more than ${MAX_QUESTIONS} questions.`);

    const seenIds = new Set();
    const normalised = [];

    questions.slice(0, MAX_QUESTIONS).forEach((q, index) => {
        const where = `Question ${index + 1}`;
        const id = q && q.id !== undefined && q.id !== null && String(q.id).trim() !== ''
            ? String(q.id).trim()
            : String(index + 1);
        if (seenIds.has(id)) {
            errors.push(`${where}: duplicate question id "${id}".`);
            return;
        }
        seenIds.add(id);

        const type = String((q && q.type) || 'short_answer').trim().toLowerCase();
        if (!QUESTION_TYPES.includes(type)) {
            errors.push(`${where}: unsupported type "${type}".`);
            return;
        }

        const text = String((q && q.question) || '').trim();
        if (!text) errors.push(`${where}: the question text is empty.`);

        const marks = Number(q && q.marks);
        const resolvedMarks = Number.isFinite(marks) && marks > 0 ? marks : 1;
        if (q && q.marks !== undefined && (!Number.isFinite(marks) || marks <= 0)) {
            errors.push(`${where}: marks must be a positive number.`);
        }
        if (resolvedMarks > MAX_MARKS_PER_QUESTION) {
            errors.push(`${where}: marks cannot exceed ${MAX_MARKS_PER_QUESTION}.`);
        }

        let options = Array.isArray(q && q.options) ? q.options.map(o => String(o)) : [];
        const correct = q && q.correct_answer !== undefined && q.correct_answer !== null
            ? String(q.correct_answer).trim()
            : '';

        if (type === 'mcq') {
            if (options.length < 2) {
                errors.push(`${where}: a multiple-choice question needs at least two options.`);
            } else if (new Set(options.map(o => o.trim().toLowerCase())).size !== options.length) {
                errors.push(`${where}: options must be distinct.`);
            }
            // The key has to name one of the choices, or the question can only
            // ever be marked wrong.
            if (!correct) {
                errors.push(`${where}: no correct answer is set.`);
            } else if (options.length && !options.some(o => o.trim().toLowerCase() === correct.toLowerCase())) {
                errors.push(`${where}: the correct answer is not one of the options.`);
            }
        } else if (type === 'true_false') {
            if (!options.length) options = ['True', 'False'];
            if (!['true', 'false'].includes(correct.toLowerCase())) {
                errors.push(`${where}: the correct answer must be True or False.`);
            }
        } else if (isObjective(type) && !correct) {
            errors.push(`${where}: no correct answer is set.`);
        }

        normalised.push({
            id,
            type,
            question: text,
            options,
            correct_answer: correct,
            explanation: q && q.explanation ? String(q.explanation) : null,
            marks: resolvedMarks
        });
    });

    const totalMarks = normalised.reduce((sum, q) => sum + q.marks, 0);
    return { ok: errors.length === 0, errors, questions: normalised, totalMarks };
}

// What a student is allowed to see before they have answered: the question,
// and for multiple choice the options. Never the key, never the explanation,
// never the teacher's private notes.
function studentQuestionView(questions) {
    return (Array.isArray(questions) ? questions : []).map(q => ({
        id: q.id,
        type: q.type,
        question: q.question,
        options: Array.isArray(q.options) ? q.options : [],
        marks: q.marks || 1
    }));
}

// A worksheet row as a student may receive it. worksheet_data holds the answer
// key, so it is removed here rather than being trusted not to be rendered:
// `SELECT w.*` put the whole key in the feed, where anyone could read it from
// the network tab before starting.
function studentWorksheetRow(row, { includeQuestions = false } = {}) {
    if (!row) return row;
    const { worksheet_data, ...safe } = row;
    if (includeQuestions) {
        const { questions } = validateWorksheet(worksheet_data);
        safe.questions = studentQuestionView(questions);
    }
    safe.question_count = (parseWorksheetData(worksheet_data).questions || []).length;
    return safe;
}

// Marks cross the wire as JSON, where Infinity and NaN both serialise to null.
// Number(null) is 0, so without this a mark that was never a number arrives as
// a silent zero on a student's record. Zero itself is a real mark and has to
// survive, so the check is on what the value *is*, not on whether it is truthy.
function parseMark(value, max) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
        return { ok: false, reason: 'Marks must be a number.' };
    }
    const n = Number(value);
    if (!Number.isFinite(n)) return { ok: false, reason: 'Marks must be a number.' };
    if (n < 0) return { ok: false, reason: 'Marks cannot be negative.' };
    if (n > max) return { ok: false, reason: `Marks cannot exceed ${max}.` };
    return { ok: true, value: n };
}

// Answers as submitted. Anything not matching a question on this worksheet is
// dropped rather than graded, so a crafted payload cannot invent questions.
function normaliseAnswers(rawAnswers, questions) {
    const byId = new Map(questions.map(q => [String(q.id), q]));
    const answerMap = {};
    const unknown = [];
    for (const entry of Array.isArray(rawAnswers) ? rawAnswers : []) {
        if (!entry || typeof entry !== 'object') continue;
        const id = String(entry.id);
        if (!byId.has(id)) { unknown.push(id); continue; }
        const value = entry.answer;
        if (value === null || value === undefined) { answerMap[id] = null; continue; }
        if (typeof value === 'object') { unknown.push(id); continue; }
        answerMap[id] = String(value).slice(0, MAX_ANSWER_LENGTH);
    }
    return { answerMap, unknown };
}

// Is this worksheet open to submissions right now?
function availability(worksheet, now = new Date()) {
    if (worksheet.status !== 'published') {
        return { open: false, code: 'NOT_PUBLISHED', message: 'This worksheet is not published.' };
    }
    const opensAt = worksheet.opens_at ? new Date(worksheet.opens_at) : null;
    if (opensAt && !Number.isNaN(opensAt.getTime()) && now < opensAt) {
        return { open: false, code: 'NOT_OPEN_YET', message: `This worksheet opens ${opensAt.toLocaleString()}.` };
    }
    const closesAt = worksheet.closes_at ? new Date(worksheet.closes_at) : null;
    if (closesAt && !Number.isNaN(closesAt.getTime()) && now > closesAt) {
        return { open: false, code: 'CLOSED', message: `This worksheet closed ${closesAt.toLocaleString()}.` };
    }
    return { open: true };
}

module.exports = {
    QUESTION_TYPES,
    OBJECTIVE_TYPES,
    SUBJECTIVE_TYPES,
    MAX_ANSWER_LENGTH,
    isObjective,
    parseWorksheetData,
    validateWorksheet,
    parseMark,
    studentQuestionView,
    studentWorksheetRow,
    normaliseAnswers,
    availability
};
