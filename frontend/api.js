const API_BASE_URL = '/api';

const api = {
    register: async (username, password, role = 'student') => {
        const res = await fetch(`${API_BASE_URL}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, role })
        });
        if (!res.ok) {
            const e = await res.json().catch(() => ({ msg: 'Registration failed' }));
            const err = new Error(e.msg || 'Registration failed');
            err.data = e;
            throw err;
        }
        return res.json();
    },

    login: async (username, password, requiredRole = null) => {
        const res = await fetch(`${API_BASE_URL}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, requiredRole })
        });
        if (!res.ok) {
            const e = await res.json().catch(() => ({ msg: 'Login failed' }));
            const err = new Error(e.msg || 'Login failed');
            err.data = e;
            err.notFound = e.notFound;
            err.requiresRegister = e.requiresRegister;
            err.isStudent = e.isStudent;
            throw err;
        }
        return res.json();
    },

    getProfile: async (token) => {
        const res = await fetch(`${API_BASE_URL}/user/profile`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('Failed to fetch profile');
        return res.json();
    },

    updateProfile: async (token, username, profile_picture, bio) => {
        const res = await fetch(`${API_BASE_URL}/user/profile`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, profile_picture, bio })
        });
        if (!res.ok) throw new Error('Failed to update profile');
        return res.json();
    },

    deleteAccount: async (token) => {
        const res = await fetch(`${API_BASE_URL}/user/account`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('Failed to delete account');
        return res.json();
    },

    addXp: async (token, xp, time, tool) => {
        const res = await fetch(`${API_BASE_URL}/user/xp`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ xp, time, tool })
        });
        if (!res.ok) throw new Error('Failed to add XP');
        return res.json();
    },

    getNotes: async (token) => {
        const res = await fetch(`${API_BASE_URL}/user/notes`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('Failed to fetch notes');
        return res.json();
    },

    saveNote: async (token, title, content) => {
        const res = await fetch(`${API_BASE_URL}/user/notes`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, content })
        });
        if (!res.ok) throw new Error('Failed to save note');
        return res.json();
    },

    getLeaderboard: async (token) => {
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        const res = await fetch(`${API_BASE_URL}/user/leaderboard`, { headers });
        if (!res.ok) throw new Error('Failed to fetch leaderboard');
        return res.json();
    },

    // `opts` carries memory and routing: { threadId, useMemory, task, images, wantReasoning }
    generateAI: async (token, prompt, systemMessage, model, opts = {}) => {
        const res = await fetch(`${API_BASE_URL}/ai/generate`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, systemMessage, model, ...opts })
        });
        if (!res.ok) { const e = await res.json(); throw new Error(e.msg || 'AI generation failed'); }
        return res.json();
    },

    // --- Study tools run from inside the chat ---
    runChatTool: async (token, spec) => {
        const res = await fetch(`${API_BASE_URL}/ai/tool/run`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(spec)
        });
        if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.msg || "Couldn't build that just now"); }
        return res.json();
    },
    gradeChatWorksheet: async (token, items, classLevel) => {
        const res = await fetch(`${API_BASE_URL}/ai/tool/grade`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ items, classLevel })
        });
        if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.msg || "Couldn't check your answers"); }
        return res.json();
    },
    saveChatDeck: async (token, title, cards) => {
        const res = await fetch(`${API_BASE_URL}/study/flashcards/decks`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, cards })
        });
        if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.msg || "Couldn't save the deck"); }
        return res.json();
    },

    // --- AI Companion memory ---
    getAiMemory: async (token) => {
        const res = await fetch(`${API_BASE_URL}/ai/memory`, { headers: { 'Authorization': `Bearer ${token}` } });
        return res.json();
    },
    setAiMemory: async (token, key, value) => {
        const res = await fetch(`${API_BASE_URL}/ai/memory`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ key, value })
        });
        return res.json();
    },
    clearAiMemory: async (token, key) => {
        const res = await fetch(`${API_BASE_URL}/ai/memory/${encodeURIComponent(key)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        return res.json();
    },

    listChatThreads: async (token, query = '') => {
        const q = query ? `?q=${encodeURIComponent(query)}` : '';
        const res = await fetch(`${API_BASE_URL}/ai/threads${q}`, { headers: { 'Authorization': `Bearer ${token}` } });
        return res.json();
    },
    renameChatThread: async (token, id, title) => {
        const res = await fetch(`${API_BASE_URL}/ai/threads/${id}`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ title })
        });
        return res.json();
    },
    // The model list and what each is good for, from the server — so the
    // picker can never offer something the server would reject.
    getAiModels: async (token) => {
        const res = await fetch(`${API_BASE_URL}/ai/models`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('Could not load the model list');
        return res.json();
    },

    getAiProgress: async (token, requestId) => {
        const res = await fetch(`${API_BASE_URL}/ai/progress/${encodeURIComponent(requestId)}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        return res.json();
    },

    // --- Memory: the student's own uploaded PDFs ---
    getMemoryLimits: async (token) => {
        const res = await fetch(`${API_BASE_URL}/memory/limits`, { headers: { 'Authorization': `Bearer ${token}` } });
        return res.json();
    },
    listMemoryDocs: async (token) => {
        const res = await fetch(`${API_BASE_URL}/memory/docs`, { headers: { 'Authorization': `Bearer ${token}` } });
        return res.json();
    },
    // XHR rather than fetch: fetch cannot report upload progress, and a 20 MB
    // PDF on a school connection needs a visible bar.
    uploadMemoryDoc: (token, file, meta = {}, onProgress) => new Promise((resolve, reject) => {
        const params = new URLSearchParams();
        ['title', 'classLabel', 'bookName', 'language'].forEach((k) => { if (meta[k]) params.set(k, meta[k]); });
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API_BASE_URL}/memory/docs?${params.toString()}`);
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.setRequestHeader('Content-Type', 'application/pdf');
        xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name || 'document.pdf'));
        xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
        xhr.onload = () => {
            let body = {};
            try { body = JSON.parse(xhr.responseText); } catch (e) { /* non-JSON error page */ }
            if (xhr.status >= 200 && xhr.status < 300) resolve(body);
            else reject(new Error(body.msg || `Upload failed (${xhr.status})`));
        };
        xhr.onerror = () => reject(new Error('Upload failed — check your connection.'));
        xhr.send(file);
    }),
    updateMemoryDoc: async (token, id, patch) => {
        const res = await fetch(`${API_BASE_URL}/memory/docs/${id}`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(patch)
        });
        return res.json();
    },
    deleteMemoryDoc: async (token, id) => {
        const res = await fetch(`${API_BASE_URL}/memory/docs/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        return res.json();
    },
    createChatThread: async (token, title) => {
        const res = await fetch(`${API_BASE_URL}/ai/threads`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ title })
        });
        return res.json();
    },
    getChatThread: async (token, id) => {
        const res = await fetch(`${API_BASE_URL}/ai/threads/${id}`, { headers: { 'Authorization': `Bearer ${token}` } });
        return res.json();
    },
    deleteChatThread: async (token, id) => {
        const res = await fetch(`${API_BASE_URL}/ai/threads/${id}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        return res.json();
    },

    generateAIChat: async (token, messages, systemMessage, model) => {
        const res = await fetch(`${API_BASE_URL}/ai/generate`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages, systemMessage, model })
        });
        if (!res.ok) { const e = await res.json(); throw new Error(e.msg || 'AI generation failed'); }
        return res.json();
    },

    textToSpeech: async (token, text, target_language_code = 'hi-IN', speaker = 'shubh', pace = 1.05, student_name = '') => {
        const res = await fetch(`${API_BASE_URL}/ai/tts`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, target_language_code, speaker, pace, student_name })
        });
        if (!res.ok) { const e = await res.json(); throw new Error(e.error || e.details || 'TTS failed'); }
        return res.json();
    },

    // --- Teacher Portal Endpoints ---
    createTeacherClass: async (token, classData) => {
        const res = await fetch(`${API_BASE_URL}/teacher/classes`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(classData)
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error?.message || 'Failed to create class');
        return data;
    },

    joinTeacherClass: async (token, classCode, subject, role) => {
        const res = await fetch(`${API_BASE_URL}/teacher/classes/join`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ classCode, subject, role })
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error?.message || 'Failed to join class');
        return data;
    },

    getTeacherClasses: async (token) => {
        const res = await fetch(`${API_BASE_URL}/teacher/classes`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error?.message || 'Failed to fetch classes');
        return data;
    },

    getTeacherClassDetails: async (token, classId) => {
        const res = await fetch(`${API_BASE_URL}/teacher/classes/${classId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error?.message || 'Failed to fetch class details');
        return data;
    },

    getTeacherClassStudents: async (token, classId) => {
        const res = await fetch(`${API_BASE_URL}/teacher/classes/${classId}/students`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error?.message || 'Failed to fetch students');
        return data;
    },

    removeStudentFromClass: async (token, classId, studentId) => {
        const res = await fetch(`${API_BASE_URL}/teacher/classes/${classId}/students/remove`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ studentId })
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error?.message || 'Failed to remove student');
        return data;
    },

    blockStudentFromClass: async (token, classId, studentId, reason) => {
        const res = await fetch(`${API_BASE_URL}/teacher/classes/${classId}/students/block`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ studentId, reason })
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error?.message || 'Failed to block student');
        return data;
    },

    unblockStudentFromClass: async (token, classId, studentId) => {
        const res = await fetch(`${API_BASE_URL}/teacher/classes/${classId}/students/unblock`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ studentId })
        });
        return res.json();
    },

    regenerateClassCode: async (token, classId) => {
        const res = await fetch(`${API_BASE_URL}/teacher/classes/${classId}/regenerate-code`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error?.message || 'Failed to regenerate code');
        return data;
    },

    archiveClass: async (token, classId) => {
        const res = await fetch(`${API_BASE_URL}/teacher/classes/${classId}/archive`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        return res.json();
    },

    postTeacherAnnouncement: async (token, announcementData) => {
        const res = await fetch(`${API_BASE_URL}/teacher/announcements`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(announcementData)
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error?.message || 'Failed to post announcement');
        return data;
    },

    createTeacherHomework: async (token, homeworkData) => {
        const res = await fetch(`${API_BASE_URL}/teacher/homework`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(homeworkData)
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error?.message || 'Failed to create homework');
        return data;
    },

    getHomeworkSubmissions: async (token, homeworkId) => {
        const res = await fetch(`${API_BASE_URL}/teacher/homework/${homeworkId}/submissions`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error?.message || 'Failed to fetch submissions');
        return data;
    },

    gradeHomeworkSubmission: async (token, submissionId, marks, feedback) => {
        const res = await fetch(`${API_BASE_URL}/teacher/homework/grade`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ submissionId, marks, feedback })
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error?.message || 'Failed to grade submission');
        return data;
    },

    createTeacherNote: async (token, noteData) => {
        const res = await fetch(`${API_BASE_URL}/teacher/notes`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(noteData)
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error?.message || 'Failed to save note');
        return data;
    },

    generateAIWorksheet: async (token, params) => {
        const res = await fetch(`${API_BASE_URL}/teacher/worksheets/generate`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error?.message || 'AI worksheet generation failed');
        return data;
    },

    generateDifferentiatedTests: async (token, params) => {
        const res = await fetch(`${API_BASE_URL}/teacher/worksheets/generate-differentiated`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error?.message || 'Differentiated test generation failed');
        return data;
    },

    publishAIWorksheet: async (token, worksheetData) => {
        const res = await fetch(`${API_BASE_URL}/teacher/worksheets/publish`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(worksheetData)
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error?.message || 'Failed to publish worksheet');
        return data;
    },

    getTeacherOverview: async (token) => {
        const res = await fetch(`${API_BASE_URL}/teacher/overview`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error?.message || 'Failed to load overview');
        return data;
    },

    listTeacherWorksheets: async (token) => {
        const res = await fetch(`${API_BASE_URL}/teacher/worksheets`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error?.message || 'Failed to load worksheets');
        return data;
    },

    getWorksheetAnalysis: async (token, worksheetId) => {
        const res = await fetch(`${API_BASE_URL}/teacher/worksheets/${worksheetId}/analysis`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error?.message || 'Failed to load analysis');
        return data;
    },

    generateReteachWorksheet: async (token, worksheetId, questionIds, numQuestions) => {
        const res = await fetch(`${API_BASE_URL}/teacher/worksheets/${worksheetId}/reteach`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ questionIds, numQuestions })
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error?.message || 'Failed to generate reteach worksheet');
        return data;
    },

    // --- Student Classroom Endpoints ---
    studentJoinClass: async (token, classCode) => {
        const res = await fetch(`${API_BASE_URL}/classroom/join`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ classCode })
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
            const err = new Error(data.error?.message || 'Failed to join class');
            err.code = data.error?.code;
            throw err;
        }
        return data;
    },

    getStudentEnrolledClasses: async (token) => {
        const res = await fetch(`${API_BASE_URL}/classroom/my-classes`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error?.message || 'Failed to fetch enrolled classes');
        return data;
    },

    getStudentClassDetails: async (token, classId) => {
        const res = await fetch(`${API_BASE_URL}/classroom/${classId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error?.message || 'Failed to fetch class details');
        return data;
    },

    // Opens a worksheet for attempting. Returns the questions without their
    // answers, plus whether this student may still submit.
    startWorksheet: async (token, worksheetId) => {
        const res = await fetch(`${API_BASE_URL}/classroom/worksheets/${worksheetId}/start`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error?.message || data.msg || 'Could not open this worksheet.');
        return data;
    },

    getStudentClassFeed: async (token, classId) => {
        const res = await fetch(`${API_BASE_URL}/classroom/${classId}/feed`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error?.message || 'Failed to fetch class feed');
        return data;
    },

    submitStudentHomework: async (token, homeworkId, content, attachments) => {
        const res = await fetch(`${API_BASE_URL}/classroom/homework/${homeworkId}/submit`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ content, attachments })
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error?.message || 'Failed to submit homework');
        return data;
    },

    // submissionKey identifies this attempt, so a retry after a dropped
    // connection is recognised as the same submission rather than a new one.
    submitStudentWorksheet: async (token, worksheetId, answers, submissionKey) => {
        const res = await fetch(`${API_BASE_URL}/classroom/worksheets/${worksheetId}/submit`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ answers, submissionKey })
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error?.message || 'Failed to submit worksheet');
        return data;
    },

    getMyWorksheetResult: async (token, worksheetId) => {
        const res = await fetch(`${API_BASE_URL}/classroom/worksheets/${worksheetId}/my-result`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error?.message || 'No result found');
        return data;
    },

    getClassNotifications: async (token) => {
        const res = await fetch(`${API_BASE_URL}/classroom/notifications/list`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        return res.json();
    },

    markClassNotificationsRead: async (token) => {
        const res = await fetch(`${API_BASE_URL}/classroom/notifications/read`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        return res.json();
    },

    // ── Flashcards (spaced repetition) ──
    generateFlashcards: async (token, sourceText, title, count = 10) => {
        const res = await fetch(`${API_BASE_URL}/study/flashcards/generate`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ sourceText, title, count })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.msg || 'Failed to generate flashcards');
        return data;
    },

    getFlashcardDecks: async (token) => {
        const res = await fetch(`${API_BASE_URL}/study/flashcards/decks`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        return res.json();
    },

    getFlashcardDeck: async (token, deckId) => {
        const res = await fetch(`${API_BASE_URL}/study/flashcards/decks/${deckId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        return res.json();
    },

    deleteFlashcardDeck: async (token, deckId) => {
        const res = await fetch(`${API_BASE_URL}/study/flashcards/decks/${deckId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        return res.json();
    },

    getDueFlashcards: async (token) => {
        const res = await fetch(`${API_BASE_URL}/study/flashcards/due`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        return res.json();
    },

    reviewFlashcard: async (token, cardId, quality) => {
        const res = await fetch(`${API_BASE_URL}/study/flashcards/review`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ cardId, quality })
        });
        return res.json();
    },

    // ── AI Quiz Generator ──
    generateQuiz: async (token, { topic, sourceText, count = 5, difficulty = 'Medium' }) => {
        const res = await fetch(`${API_BASE_URL}/study/quiz/generate`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ topic, sourceText, count, difficulty })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.msg || 'Failed to generate quiz');
        return data;
    },

    // The quiz is identified by id; the answer key lives on the server, so the
    // browser has nothing to grade against and nothing to send but its answers.
    submitQuiz: async (token, quizId, answers) => {
        const res = await fetch(`${API_BASE_URL}/study/quiz/submit`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ quizId, answers })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.msg || 'Could not save your quiz.');
        return data;
    },

    getQuizHistory: async (token) => {
        const res = await fetch(`${API_BASE_URL}/study/quiz/history`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        return res.json();
    },

    // ── Weakness Radar & Study Roadmap ──
    getWeaknessRadar: async (token) => {
        const res = await fetch(`${API_BASE_URL}/study/analytics/weakness`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        return res.json();
    },

    generateStudyRoadmap: async (token, { examName, examDate, topics, hoursPerDay = 1.5 }) => {
        const res = await fetch(`${API_BASE_URL}/study/roadmap/generate`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ examName, examDate, topics, hoursPerDay })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.msg || 'Failed to generate roadmap');
        return data;
    },

    // ── Gamification: badges & streak ──
    getBadges: async (token) => {
        const res = await fetch(`${API_BASE_URL}/gamification/badges`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        return res.json();
    },

    checkNewBadges: async (token) => {
        const res = await fetch(`${API_BASE_URL}/gamification/badges/check`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        return res.json();
    },

    getStreak: async (token) => {
        const res = await fetch(`${API_BASE_URL}/gamification/streak`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        return res.json();
    },

    useStreakFreeze: async (token) => {
        const res = await fetch(`${API_BASE_URL}/gamification/streak/use-freeze`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.msg || 'Failed to use streak freeze');
        return data;
    }
};
