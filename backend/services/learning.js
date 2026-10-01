const db = require('../config/db');
const { randomUUID } = require('node:crypto');
let initialized;
function ready() {
    if (!initialized) initialized = (async () => {
        const text = db.dialect() === 'mysql' ? 'LONGTEXT' : 'TEXT';
        await db.run(`CREATE TABLE IF NOT EXISTS learning_quizzes (
            id VARCHAR(36) PRIMARY KEY, user_id INTEGER NOT NULL, topic VARCHAR(255) NOT NULL,
            questions ${text} NOT NULL, result ${text}, created_at VARCHAR(30) NOT NULL
        )`);
        await db.run(`CREATE TABLE IF NOT EXISTS learning_mistakes (
            id VARCHAR(36) PRIMARY KEY, user_id INTEGER NOT NULL, topic VARCHAR(255) NOT NULL,
            question ${text} NOT NULL, options_json ${text} NOT NULL, correct_index INTEGER NOT NULL,
            explanation ${text}, answer_index INTEGER, due_at VARCHAR(30) NOT NULL,
            successes INTEGER DEFAULT 0, reviews INTEGER DEFAULT 0, resolved INTEGER DEFAULT 0,
            created_at VARCHAR(30) NOT NULL
        )`);
        await db.run(`CREATE TABLE IF NOT EXISTS learning_goals (
            id VARCHAR(36) PRIMARY KEY, user_id INTEGER NOT NULL, title VARCHAR(160) NOT NULL,
            exam_date VARCHAR(10) NOT NULL, minutes INTEGER NOT NULL, topics ${text} NOT NULL,
            created_at VARCHAR(30) NOT NULL
        )`);
        await db.run(`CREATE TABLE IF NOT EXISTS learning_checkins (
            user_id INTEGER NOT NULL, day VARCHAR(10) NOT NULL, task_key VARCHAR(100) NOT NULL,
            PRIMARY KEY(user_id, day, task_key)
        )`);
        await db.run(`CREATE TABLE IF NOT EXISTS learning_rewards (
            user_id INTEGER NOT NULL, reward_key VARCHAR(100) NOT NULL, xp INTEGER NOT NULL,
            PRIMARY KEY(user_id, reward_key)
        )`);
    })().catch(e => { initialized = null; throw e; });
    return initialized;
}
function publicQuestions(questions) {
    return questions.map(q => ({ question: q.question, options: q.options }));
}
function cleanQuestions(input) {
    return (Array.isArray(input) ? input : []).filter(q => q && typeof q.question === 'string' &&
        q.question.trim() && Array.isArray(q.options) && q.options.length === 4 &&
        q.options.every(o => typeof o === 'string' && o.trim()) &&
        Number.isInteger(q.correctIndex) && q.correctIndex >= 0 && q.correctIndex < 4)
        .slice(0, 15).map(q => ({ question: q.question.slice(0, 3000), options: q.options.map(o => o.slice(0, 1000)),
            correctIndex: q.correctIndex, explanation: String(q.explanation || '').slice(0, 3000) }));
}
async function createQuiz(userId, topic, input) {
    await ready();
    const questions = cleanQuestions(input);
    if (!questions.length) throw new Error('No valid questions');
    const id = randomUUID();
    await db.run('INSERT INTO learning_quizzes (id, user_id, topic, questions, created_at) VALUES (?, ?, ?, ?, ?)',
        [id, userId, String(topic).slice(0, 255), JSON.stringify(questions), new Date().toISOString()]);
    return { quizId: id, topic, questions: publicQuestions(questions) };
}
async function reward(userId, key, xp, label) {
    // Call inside the same transaction as the action that earned the reward.
    const saved = await db.run('INSERT IGNORE INTO learning_rewards (user_id, reward_key, xp) VALUES (?, ?, ?)', [userId, key, xp]);
    if (!saved.changes) return 0;
    await db.run('UPDATE users SET xp = xp + ? WHERE id = ?', [xp, userId]);
    await db.run('INSERT INTO activity (user_id, tool_used, time_spent, xp_earned) VALUES (?, ?, 0, ?)', [userId, label, xp]);
    return xp;
}
function httpError(status, message) { return Object.assign(new Error(message), { status }); }
async function submitQuiz(userId, quizId, answers) {
    await ready();
    return db.transaction(async () => {
        const suffix = db.dialect() === 'mysql' ? ' FOR UPDATE' : '';
        const quiz = await db.get('SELECT * FROM learning_quizzes WHERE id = ? AND user_id = ?' + suffix, [quizId, userId]);
        if (!quiz) throw httpError(404, 'Quiz not found. Generate a new quiz first.');
        if (quiz.result) return { ...JSON.parse(quiz.result), xpEarned: 0, alreadySubmitted: true };
        const questions = JSON.parse(quiz.questions);
        if (!Array.isArray(answers) || answers.length !== questions.length || answers.some(a => a !== null && (!Number.isInteger(a) || a < 0 || a > 3))) {
            throw httpError(400, 'Submit one valid answer per question (or null to skip).');
        }
        const results = questions.map((q, i) => ({ isCorrect: answers[i] === q.correctIndex, correctIndex: q.correctIndex, explanation: q.explanation }));
        const score = results.filter(r => r.isCorrect).length;
        await db.run('INSERT INTO quiz_attempts (user_id, topic, questions_json, answers_json, score, total) VALUES (?, ?, ?, ?, ?, ?)',
            [userId, quiz.topic, quiz.questions, JSON.stringify(answers), score, questions.length]);
        for (let i = 0; i < questions.length; i++) {
            if (results[i].isCorrect) continue;
            const q = questions[i], now = new Date().toISOString();
            await db.run(`INSERT INTO learning_mistakes (id, user_id, topic, question, options_json, correct_index, explanation, answer_index, due_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [randomUUID(), userId, quiz.topic, q.question, JSON.stringify(q.options), q.correctIndex, q.explanation, answers[i], now, now]);
        }
        const xpEarned = await reward(userId, 'quiz:' + quizId, 10 + Math.round(score / questions.length * 30), 'Practice quiz');
        const result = { success: true, score, total: questions.length, results, xpEarned };
        await db.run('UPDATE learning_quizzes SET result = ? WHERE id = ?', [JSON.stringify(result), quizId]);
        return result;
    });
}
module.exports = { ready, createQuiz, submitQuiz, reward, httpError };
