const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const db = require('../config/db');

// --- Multi-Provider AI Helper (same pattern used for worksheet generation) ---
async function generateAIJSON(prompt, systemInstruction = 'You are a helpful study assistant. Respond only with JSON.') {
    // 1. Try Groq
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey && groqKey !== 'your_groq_api_key_here' && groqKey.length > 5) {
        try {
            const Groq = require('groq-sdk');
            const groq = new Groq({ apiKey: groqKey });
            const completion = await groq.chat.completions.create({
                model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
                messages: [
                    { role: 'system', content: systemInstruction },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.4,
                response_format: { type: 'json_object' }
            });
            return completion.choices[0]?.message?.content || '';
        } catch (e) {
            console.warn('[GROQ STUDY GEN WARNING]', e.message);
        }
    }

    // 2. Try Gemini
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey && geminiKey !== 'your_gemini_api_key_here' && geminiKey.length > 10) {
        try {
            const { GoogleGenerativeAI } = require('@google/generative-ai');
            const genAI = new GoogleGenerativeAI(geminiKey);
            const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
            const result = await model.generateContent(`${systemInstruction}\n\n${prompt}`);
            return result.response.text();
        } catch (e) {
            console.warn('[GEMINI STUDY GEN WARNING]', e.message);
        }
    }

    return '';
}

function safeParseJSON(raw, fallback) {
    try {
        const cleaned = String(raw || '').replace(/```json/gi, '').replace(/```/gi, '').trim();
        return JSON.parse(cleaned);
    } catch (e) {
        return fallback;
    }
}

// ═══════════════════════════════════════════════════════════════════
//  FLASHCARDS — spaced repetition using the SM-2 algorithm
// ═══════════════════════════════════════════════════════════════════

// SM-2: quality is 0-5. We expose it to the client as 4 friendly buttons
// (Again=1, Hard=3, Good=4, Easy=5) mapped below.
function applySM2({ ease_factor, interval_days, repetitions }, quality) {
    let ef = ease_factor;
    let interval = interval_days;
    let reps = repetitions;

    if (quality < 3) {
        // Forgot it — reset repetitions, review again soon (10 minutes represented as a fraction of a day)
        reps = 0;
        interval = 0.007; // ~10 minutes
    } else {
        if (reps === 0) interval = 1;
        else if (reps === 1) interval = 6;
        else interval = Math.round(interval * ef);
        reps += 1;
    }

    ef = ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
    if (ef < 1.3) ef = 1.3;

    const dueDate = new Date(Date.now() + interval * 24 * 60 * 60 * 1000);
    return { ease_factor: Number(ef.toFixed(2)), interval_days: interval, repetitions: reps, due_date: dueDate.toISOString() };
}

// @route  POST /api/study/flashcards/generate
// @desc   AI-generate a set of flashcards from pasted text/notes/PDF-extracted text
router.post('/flashcards/generate', auth, async (req, res) => {
    try {
        const { sourceText, title, count = 10 } = req.body;
        if (!sourceText || sourceText.trim().length < 20) {
            return res.status(400).json({ msg: 'Please provide more source text (notes, PDF content, or a topic) to generate flashcards from.' });
        }

        const safeCount = Math.min(Math.max(parseInt(count, 10) || 10, 4), 25);
        const prompt = `Create exactly ${safeCount} spaced-repetition flashcards from the study material below. Each card should test ONE clear concept — keep questions short and answers concise (1-2 sentences max).

Study material:
"""${sourceText.substring(0, 6000)}"""

Respond ONLY with JSON in this exact shape:
{"cards": [{"question": "...", "answer": "..."}]}`;

        const raw = await generateAIJSON(prompt, 'You are an expert study coach who writes crisp, memorable spaced-repetition flashcards. Respond ONLY with valid JSON.');
        const parsed = safeParseJSON(raw, null);

        let cards = Array.isArray(parsed?.cards) ? parsed.cards.filter(c => c && c.question && c.answer) : [];
        if (cards.length === 0) {
            return res.status(502).json({ msg: "Couldn't generate flashcards right now — please try again in a moment." });
        }

        const deckTitle = (title && title.trim()) || `Flashcards • ${new Date().toLocaleDateString()}`;
        const deckResult = await db.run(
            'INSERT INTO flashcard_decks (user_id, title, source_type, card_count) VALUES (?, ?, ?, ?)',
            [req.user.id, deckTitle, 'ai_generated', cards.length]
        );
        const deckId = deckResult.lastID;

        for (const card of cards) {
            await db.run(
                'INSERT INTO flashcards (deck_id, question, answer) VALUES (?, ?, ?)',
                [deckId, String(card.question).trim(), String(card.answer).trim()]
            );
        }

        const deck = await db.get('SELECT * FROM flashcard_decks WHERE id = ?', [deckId]);
        const savedCards = await db.all('SELECT * FROM flashcards WHERE deck_id = ?', [deckId]);
        res.json({ success: true, deck, cards: savedCards });
    } catch (err) {
        console.error('Flashcard generation error:', err.message);
        res.status(500).json({ msg: 'Server error while generating flashcards' });
    }
});

// @route  POST /api/study/flashcards/decks
// @desc   Save a deck the student already has in front of them (chat flashcards)
router.post('/flashcards/decks', auth, async (req, res) => {
    try {
        const { title, cards } = req.body || {};
        const clean = (Array.isArray(cards) ? cards : [])
            .filter(c => c && String(c.question || '').trim() && String(c.answer || '').trim())
            .slice(0, 60)
            .map(c => ({ question: String(c.question).slice(0, 1000), answer: String(c.answer).slice(0, 2000) }));
        if (!clean.length) return res.status(400).json({ msg: 'No cards to save.' });

        const deckTitle = String(title || 'Flashcards from chat').slice(0, 160);
        const result = await db.run(
            'INSERT INTO flashcard_decks (user_id, title, source_type, card_count) VALUES (?, ?, ?, ?)',
            [req.user.id, deckTitle, 'chat', clean.length]
        );
        const deckId = result.lastID;
        for (const c of clean) {
            await db.run('INSERT INTO flashcards (deck_id, question, answer) VALUES (?, ?, ?)', [deckId, c.question, c.answer]);
        }
        res.json({ success: true, deckId, cardCount: clean.length, title: deckTitle });
    } catch (err) {
        console.error('Deck save error:', err.message);
        res.status(500).json({ msg: 'Server error while saving the deck' });
    }
});

// @route  GET /api/study/flashcards/decks
// @desc   List all of the current user's decks
router.get('/flashcards/decks', auth, async (req, res) => {
    try {
        const decks = await db.all(
            `SELECT d.*, 
                (SELECT COUNT(*) FROM flashcards f WHERE f.deck_id = d.id) as card_count,
                (SELECT COUNT(*) FROM flashcards f WHERE f.deck_id = d.id AND f.due_date <= ?) as due_count
             FROM flashcard_decks d WHERE d.user_id = ? ORDER BY d.created_at DESC`,
            [new Date().toISOString(), req.user.id]
        );
        res.json({ decks });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ msg: 'Server error' });
    }
});

// @route  GET /api/study/flashcards/decks/:id
router.get('/flashcards/decks/:id', auth, async (req, res) => {
    try {
        const deck = await db.get('SELECT * FROM flashcard_decks WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        if (!deck) return res.status(404).json({ msg: 'Deck not found' });
        const cards = await db.all('SELECT * FROM flashcards WHERE deck_id = ? ORDER BY due_date ASC', [req.params.id]);
        res.json({ deck, cards });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ msg: 'Server error' });
    }
});

// @route  DELETE /api/study/flashcards/decks/:id
router.delete('/flashcards/decks/:id', auth, async (req, res) => {
    try {
        const deck = await db.get('SELECT * FROM flashcard_decks WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        if (!deck) return res.status(404).json({ msg: 'Deck not found' });
        await db.run('DELETE FROM flashcard_decks WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ msg: 'Server error' });
    }
});

// @route  GET /api/study/flashcards/due
// @desc   Every due card across all of the user's decks, ready for a review session
router.get('/flashcards/due', auth, async (req, res) => {
    try {
        const cards = await db.all(
            `SELECT f.*, d.title as deck_title FROM flashcards f
             JOIN flashcard_decks d ON d.id = f.deck_id
             WHERE d.user_id = ? AND f.due_date <= ?
             ORDER BY f.due_date ASC LIMIT 100`,
            [req.user.id, new Date().toISOString()]
        );
        res.json({ cards });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ msg: 'Server error' });
    }
});

// @route  POST /api/study/flashcards/review
// @desc   Submit a review grade for one card — updates its SM-2 schedule
router.post('/flashcards/review', auth, async (req, res) => {
    try {
        const { cardId, quality } = req.body; // quality: 1 (Again), 3 (Hard), 4 (Good), 5 (Easy)
        const q = Math.min(5, Math.max(0, parseInt(quality, 10)));

        const card = await db.get(
            `SELECT f.* FROM flashcards f JOIN flashcard_decks d ON d.id = f.deck_id WHERE f.id = ? AND d.user_id = ?`,
            [cardId, req.user.id]
        );
        if (!card) return res.status(404).json({ msg: 'Card not found' });

        const updated = applySM2(card, q);
        await db.run(
            'UPDATE flashcards SET ease_factor = ?, interval_days = ?, repetitions = ?, due_date = ?, last_reviewed_at = ? WHERE id = ?',
            [updated.ease_factor, updated.interval_days, updated.repetitions, updated.due_date, new Date().toISOString(), cardId]
        );

        res.json({ success: true, next_due: updated.due_date, interval_days: updated.interval_days });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ msg: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  AI QUIZ GENERATOR
// ═══════════════════════════════════════════════════════════════════

// @route  POST /api/study/quiz/generate
router.post('/quiz/generate', auth, async (req, res) => {
    try {
        const { topic, sourceText, count = 5, difficulty = 'Medium' } = req.body;
        const basis = (sourceText && sourceText.trim().length > 20) ? sourceText.substring(0, 6000) : null;
        const subject = (topic && topic.trim()) || (basis ? 'the provided study material' : null);

        if (!subject) {
            return res.status(400).json({ msg: 'Please provide a topic or some source text to build a quiz from.' });
        }

        const safeCount = Math.min(Math.max(parseInt(count, 10) || 5, 3), 15);
        const prompt = basis
            ? `Create a ${safeCount}-question multiple-choice practice quiz (difficulty: ${difficulty}) based strictly on this study material:\n"""${basis}"""`
            : `Create a ${safeCount}-question multiple-choice practice quiz (difficulty: ${difficulty}) on the topic: "${subject}".`;

        const fullPrompt = `${prompt}

Each question needs exactly 4 options and one correct answer, plus a short one-sentence explanation of why the answer is correct (used for instant feedback after the student answers).

Respond ONLY with JSON in this exact shape:
{"questions": [{"question": "...", "options": ["A","B","C","D"], "correctIndex": 0, "explanation": "..."}]}`;

        const raw = await generateAIJSON(fullPrompt, 'You are an expert quiz-writer for students. Always produce exactly 4 options per question with one clearly correct answer. Respond ONLY with valid JSON.');
        const parsed = safeParseJSON(raw, null);

        let questions = Array.isArray(parsed?.questions)
            ? parsed.questions.filter(q => q && q.question && Array.isArray(q.options) && q.options.length === 4 && typeof q.correctIndex === 'number')
            : [];

        if (questions.length === 0) {
            return res.status(502).json({ msg: "Couldn't generate a quiz right now — please try again in a moment." });
        }

        res.json({ success: true, topic: subject, questions });
    } catch (err) {
        console.error('Quiz generation error:', err.message);
        res.status(500).json({ msg: 'Server error while generating the quiz' });
    }
});

// @route  POST /api/study/quiz/submit
// @desc   Grade a completed quiz, store the attempt, award XP
router.post('/quiz/submit', auth, async (req, res) => {
    try {
        const { topic, questions, answers } = req.body;
        if (!Array.isArray(questions) || !Array.isArray(answers)) {
            return res.status(400).json({ msg: 'Missing quiz data' });
        }

        let score = 0;
        const results = questions.map((q, i) => {
            const isCorrect = answers[i] === q.correctIndex;
            if (isCorrect) score++;
            return { isCorrect, correctIndex: q.correctIndex, explanation: q.explanation || '' };
        });

        await db.run(
            'INSERT INTO quiz_attempts (user_id, topic, questions_json, answers_json, score, total) VALUES (?, ?, ?, ?, ?, ?)',
            [req.user.id, topic || 'General', JSON.stringify(questions), JSON.stringify(answers), score, questions.length]
        );

        // Award XP proportional to performance — always something for trying, more for doing well
        const xpEarned = 10 + Math.round((score / questions.length) * 30);
        await db.run('UPDATE users SET xp = xp + ? WHERE id = ?', [xpEarned, req.user.id]);
        await db.run(
            'INSERT INTO activity (user_id, tool_used, time_spent, xp_earned) VALUES (?, ?, ?, ?)',
            [req.user.id, 'AI Quiz Generator', 5, xpEarned]
        );

        res.json({ success: true, score, total: questions.length, results, xpEarned });
    } catch (err) {
        console.error('Quiz submit error:', err.message);
        res.status(500).json({ msg: 'Server error while grading the quiz' });
    }
});

// @route  GET /api/study/quiz/history
router.get('/quiz/history', auth, async (req, res) => {
    try {
        const attempts = await db.all(
            'SELECT id, topic, score, total, created_at FROM quiz_attempts WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
            [req.user.id]
        );
        res.json({ attempts });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ msg: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  WEAKNESS RADAR — topic-level mastery from quiz history
// ═══════════════════════════════════════════════════════════════════

// @route  GET /api/study/analytics/weakness
// @desc   Aggregates quiz performance by topic so the student can see mastery per area
router.get('/analytics/weakness', auth, async (req, res) => {
    try {
        const attempts = await db.all(
            'SELECT topic, score, total FROM quiz_attempts WHERE user_id = ? AND total > 0 ORDER BY created_at DESC LIMIT 200',
            [req.user.id]
        );

        if (!attempts.length) {
            return res.json({ topics: [], hasData: false });
        }

        const byTopic = new Map();
        for (const a of attempts) {
            const key = (a.topic || 'General').trim();
            if (!byTopic.has(key)) byTopic.set(key, { score: 0, total: 0, attempts: 0 });
            const bucket = byTopic.get(key);
            bucket.score += a.score;
            bucket.total += a.total;
            bucket.attempts += 1;
        }

        const topics = Array.from(byTopic.entries())
            .map(([topic, v]) => ({
                topic,
                mastery: Math.round((v.score / v.total) * 100),
                attempts: v.attempts
            }))
            .sort((a, b) => b.attempts - a.attempts)
            .slice(0, 8);

        res.json({ topics, hasData: true });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ msg: 'Server error' });
    }
});

// ═══════════════════════════════════════════════════════════════════
//  AI PERSONALIZED EXAM STUDY ROADMAP
// ═══════════════════════════════════════════════════════════════════

// @route  POST /api/study/roadmap/generate
router.post('/roadmap/generate', auth, async (req, res) => {
    try {
        const { examName, examDate, topics, hoursPerDay = 1.5 } = req.body;
        if (!examName || !examDate || !topics) {
            return res.status(400).json({ msg: 'Please provide the exam name, date, and topics to cover.' });
        }

        const today = new Date();
        const exam = new Date(examDate);
        const daysUntil = Math.ceil((exam - today) / (1000 * 60 * 60 * 24));

        if (isNaN(daysUntil) || daysUntil < 1) {
            return res.status(400).json({ msg: 'The exam date needs to be in the future.' });
        }
        if (daysUntil > 120) {
            return res.status(400).json({ msg: "That's a long runway — try generating a roadmap for the final 90-120 days closer to the exam for a more focused plan." });
        }

        const prompt = `Create a day-by-day study roadmap for a student preparing for: "${examName}" on ${examDate} (${daysUntil} days from today).

Topics/syllabus to cover: ${topics}
Available study time: about ${hoursPerDay} hours per day.

Distribute topics logically across the available days (don't cram everything into day 1). Include periodic flashcard review days, at least 2-3 mock-quiz/practice-test milestone days spread through the plan, and a final light-review day right before the exam (never schedule new topics on the last day).

Respond ONLY with JSON in this exact shape:
{"plan": [{"day": 1, "date": "YYYY-MM-DD", "focus": "short topic/task description", "type": "study|flashcard_review|mock_quiz|milestone|rest"}]}

Generate exactly ${daysUntil} entries, one per day, with "date" starting from today (${today.toISOString().split('T')[0]}) through the day before the exam.`;

        const raw = await generateAIJSON(prompt, 'You are an expert academic planner who builds realistic, well-paced exam study schedules. Respond ONLY with valid JSON.');
        const parsed = safeParseJSON(raw, null);

        let plan = Array.isArray(parsed?.plan) ? parsed.plan.filter(p => p && p.date && p.focus) : [];
        if (plan.length === 0) {
            return res.status(502).json({ msg: "Couldn't build the roadmap right now — please try again in a moment." });
        }

        res.json({ success: true, examName, examDate, daysUntil, plan });
    } catch (err) {
        console.error('Roadmap generation error:', err.message);
        res.status(500).json({ msg: 'Server error while generating the roadmap' });
    }
});

module.exports = router;
