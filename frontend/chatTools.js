/* ================================================================
   Study tools inside the chat
   ----------------------------------------------------------------
   Renders the `tool` block of a Companion reply as a working tool —
   a worksheet you can answer and have marked, a quiz that scores
   itself, flashcards you can flip, notes you can save, a mind map.
   Everything a card shows about where a question came from is the
   server's citation object (see sourceLibrary.js); this file never
   invents a source, and labels anything the model wrote as such.
   ================================================================ */
window.ChatToolsUI = (function () {
    const esc = (v) => String(v ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const br = (v) => esc(v).replace(/\n/g, '<br>');

    let seq = 0;
    const store = new Map();          // card id -> the tool payload it was built from

    const ICONS = { worksheet: 'fa-file-pen', quiz: 'fa-circle-question', flashcards: 'fa-layer-group', notes: 'fa-note-sticky', mindmap: 'fa-diagram-project' };

    function sourceChip(meta) {
        const library = meta && meta.source === 'library';
        return `<span class="ct-chip ${library ? 'is-verified' : 'is-ai'}">
            <i class="fa-solid ${library ? 'fa-circle-check' : 'fa-wand-magic-sparkles'}"></i> ${esc(meta && meta.sourceLabel ? meta.sourceLabel : '')}
        </span>`;
    }

    function head(payload, id) {
        const m = payload.meta || {};
        const bits = [m.classLevel ? `Class ${m.classLevel}` : '', m.subject || '', m.chapter || '', m.difficulty || '']
            .filter(Boolean).map(esc).join(' · ');
        return `<header class="ct-head">
            <div class="ct-title"><i class="${esc(payload.icon || ('fa-solid ' + (ICONS[payload.tool] || 'fa-wand-magic-sparkles')))}"></i> ${esc(payload.title || payload.tool)}</div>
            ${bits ? `<div class="ct-sub">${bits}</div>` : ''}
            <div class="ct-chips">${sourceChip(m)}</div>
        </header>`;
    }

    // A library question carries its verified citation; an AI-written one says so.
    function provenance(item) {
        if (item.provenance === 'library' && item.citation) {
            return window.SourceLibraryUI
                ? `<div class="ct-prov">${window.SourceLibraryUI.renderCitation(item.citation)}</div>`
                : '';
        }
        return '';
    }

    // The Worksheet Generator's own controls, inside the card: change the
    // class, how many questions or the difficulty and rebuild in place,
    // without going to another screen or retyping the request.
    function controls(payload) {
        const m = payload.meta || {};
        const classes = Array.from({ length: 12 }, (_, i) => String(i + 1));
        const counts = payload.tool === 'quiz' ? [3, 5, 10, 15] : [5, 8, 10, 15, 20];
        const opt = (v, cur, label) => `<option value="${esc(v)}"${String(v) === String(cur) ? ' selected' : ''}>${esc(label || v)}</option>`;
        return `<div class="ct-controls">
            <label class="ct-field"><span>Class</span>
                <select class="ct-set-class">${['', ...classes].map(c => opt(c, m.classLevel, c || 'Any')).join('')}</select>
            </label>
            <label class="ct-field"><span>Questions</span>
                <select class="ct-set-count">${counts.map(c => opt(c, m.count)).join('')}</select>
            </label>
            <label class="ct-field"><span>Difficulty</span>
                <select class="ct-set-difficulty">${['Easy', 'Medium', 'Hard'].map(d => opt(d, m.difficulty)).join('')}</select>
            </label>
            ${payload.tool === 'worksheet' ? `<label class="ct-field"><span>Type</span>
                <select class="ct-set-type">${[['mcq', 'Multiple Choice'], ['truefalse', 'True/False'], ['short', 'Short Answer']].map(([v, l]) => opt(v, m.type || 'mcq', l)).join('')}</select>
            </label>` : ''}
            <label class="ct-field ct-field-grow"><span>Topic</span>
                <input type="text" class="ct-set-topic" value="${esc(m.chapter || '')}" placeholder="chapter or topic">
            </label>
            <button type="button" class="ct-btn is-primary ct-rebuild"><i class="fa-solid fa-rotate"></i> Rebuild</button>
        </div>`;
    }

    // ── Worksheet and quiz: the Worksheet Generator's own layout ─────
    // Same markup and classes as the Worksheets screen (ws-paper-card,
    // ws-test-nav-bar, ws-question-card, ws-option-pill…), so a worksheet made
    // in the chat looks and behaves like one made there: answered-progress bar,
    // question-number pills, A–D option rows, a timer, and marked results.
    function paper(payload, id, { mode }) {
        const m = payload.meta || {};
        const items = payload.items || [];
        const questions = items.map((it) => {
            const text = it.stem || it.questionText;
            const options = Array.isArray(it.options) ? it.options : [];
            const body = options.length
                ? `<div class="ws-options-grid">${options.map((o, i) => `
                    <label class="ws-option-pill" data-i="${i}">
                        <input type="radio" name="ct-${id}-q${it.n}" value="${esc(o)}" data-i="${i}" class="ws-radio-input">
                        <span class="ws-opt-badge">${String.fromCharCode(65 + i)}.</span>
                        <span class="ws-opt-text">${esc(o)}</span>
                    </label>`).join('')}</div>`
                : `<input type="text" class="ws-text-answer ct-text-answer" placeholder="Type your answer here..." aria-label="Answer to question ${it.n}">`;
            return `<div class="ws-question-card glass ct-ws-q" data-n="${it.n}">
                <div class="ws-q-header">
                    <span class="ws-q-number">Q${it.n}</span>
                    <h4 class="ws-q-text">${br(text)}</h4>
                </div>
                ${body}
                ${it.hint ? `<button type="button" class="ct-btn is-quiet ct-hint-btn"><i class="fa-regular fa-lightbulb"></i> Hint</button>
                <p class="ct-hint" hidden>${br(it.hint)}</p>` : ''}
                <div class="ct-instant" hidden></div>
                ${provenance(it)}
            </div>`;
        }).join('');

        const submit = mode === 'quiz'
            ? `<button type="button" class="ct-btn ct-retry" hidden><i class="fa-solid fa-rotate-right"></i> Try the ones I missed</button>`
            : `<button type="button" class="btn btn-primary ws-submit-btn ct-check"><i class="fa-solid fa-check-double"></i> Submit Answers for AI Grading</button>`;

        return `${controls(payload)}
            <div class="ws-paper-card glass ct-paper">
                <div class="ws-paper-header">
                    <div>
                        <span class="ws-paper-badge"><i class="fa-solid ${mode === 'quiz' ? 'fa-circle-question' : 'fa-file-lines'}"></i> ${mode === 'quiz' ? 'Quiz Mode — instant answers' : 'Interactive Test Mode'}</span>
                        <h3 class="ws-paper-title">${esc(payload.title || '')}</h3>
                        <div class="ct-chips">${sourceChip(m)}</div>
                    </div>
                    <div class="ct-paper-actions">
                        ${mode === 'quiz' ? '' : `<span class="ws-timer-badge ct-timer" hidden><i class="fa-regular fa-clock"></i> <span class="ct-time-left">10:00</span></span>
                        <button type="button" class="tool-act-btn ct-timer-start" title="Time yourself like an exam"><i class="fa-regular fa-clock"></i> <span>Start 10-min timer</span></button>`}
                        <button type="button" class="tool-act-btn ct-print" title="Print test paper for offline practice"><i class="fa-solid fa-print"></i> <span>Print Test Paper</span></button>
                        ${m.engine ? `<span class="ws-model-pill"><i class="fa-solid ${m.source === 'library' ? 'fa-circle-check' : 'fa-bolt'}"></i> ${esc(m.engine)}</span>` : ''}
                    </div>
                </div>

                <div class="ws-test-nav-bar">
                    <div class="ws-progress-info">
                        <span class="ct-progress-label">Answered: 0 / ${items.length} (0%)</span>
                        <div class="ws-progress-track"><div class="ws-progress-fill ct-progress-fill" style="width: 0%;"></div></div>
                    </div>
                    <div class="ws-q-nav-pills">${items.map(it => `<button type="button" class="ws-q-nav-pill ct-nav-pill" data-n="${it.n}">${it.n}</button>`).join('')}</div>
                </div>

                <div class="ws-questions-list">${questions}</div>

                <div class="ws-bottom-actions ct-paper-bottom">
                    ${submit}
                    <button type="button" class="ct-btn ct-more"><i class="fa-solid fa-plus"></i> More questions</button>
                    <button type="button" class="ct-btn ct-harder"><i class="fa-solid fa-arrow-trend-up"></i> Harder</button>
                </div>
                <div class="ct-quiz-score" hidden></div>
            </div>

            <div class="ws-grading-area ct-grading" hidden>
                <div class="glass ws-result-card">
                    <div class="ws-result-header">
                        <div>
                            <h2 class="ws-result-title"><i class="fa-solid fa-award"></i> Assessment Results &amp; Feedback</h2>
                            <p class="ws-result-subtitle ct-checked-by"></p>
                        </div>
                        <div class="ct-paper-actions">
                            <button type="button" class="tool-act-btn ct-retake"><i class="fa-solid fa-rotate-right"></i> <span>Retake Test</span></button>
                            <div class="ws-score-badge">
                                <span class="ws-score-label">Final Score</span>
                                <h1 class="ws-score-val ct-score-val"></h1>
                            </div>
                        </div>
                    </div>
                    <div class="ws-feedback-list ct-feedback-list"></div>
                </div>
            </div>`;
    }

    function worksheet(payload, id) { return paper(payload, id, { mode: 'worksheet' }); }

    // A quiz carries its answer key as an option index; the paper layout
    // expects the options it shows.
    function quiz(payload, id) { return paper(payload, id, { mode: 'quiz' }); }

    function flashcards(payload) {
        const cards = (payload.items || []).map((c, i) => `
            <button type="button" class="ct-card" data-i="${i}" aria-pressed="false">
                <span class="ct-card-face ct-card-q">${br(c.question)}</span>
                <span class="ct-card-face ct-card-a" hidden>${br(c.answer)}</span>
                <span class="ct-card-flip">tap to flip</span>
            </button>`).join('');
        return `<div class="ct-deck">${cards}</div>
            <footer class="ct-foot">
                <button type="button" class="ct-btn ct-flip-all"><i class="fa-solid fa-repeat"></i> Flip all</button>
                <button type="button" class="ct-btn ct-save-deck"><i class="fa-solid fa-floppy-disk"></i> Save to my deck</button>
                <button type="button" class="ct-btn ct-more"><i class="fa-solid fa-plus"></i> More cards</button>
            </footer>`;
    }

    function notes(payload) {
        const sections = (payload.sections || []).map(s => `
            <section class="ct-note-sec">
                <h4>${esc(s.heading)}</h4>
                <ul>${(s.points || []).map(p => `<li>${br(p)}</li>`).join('')}</ul>
            </section>`).join('');
        const terms = (payload.terms || []).length ? `
            <section class="ct-note-sec">
                <h4>Key terms</h4>
                <dl class="ct-terms">${payload.terms.map(t => `<dt>${esc(t.term)}</dt><dd>${esc(t.meaning)}</dd>`).join('')}</dl>
            </section>` : '';
        const mistakes = (payload.mistakes || []).length ? `
            <section class="ct-note-sec">
                <h4>Commonly got wrong</h4>
                <ul>${payload.mistakes.map(m => `<li>${br(m)}</li>`).join('')}</ul>
            </section>` : '';
        return `<div class="ct-notes">${sections}${terms}${mistakes}</div>
            <footer class="ct-foot">
                <button type="button" class="ct-btn ct-save-note"><i class="fa-solid fa-bookmark"></i> Save to Notes</button>
                <button type="button" class="ct-btn ct-copy"><i class="fa-regular fa-copy"></i> Copy</button>
                <button type="button" class="ct-btn ct-print"><i class="fa-solid fa-print"></i> Print</button>
            </footer>`;
    }

    function mindmap(payload, id) {
        return `<div class="ct-mermaid" id="ct-map-${id}">${esc(payload.mermaid || '')}</div>
            <footer class="ct-foot">
                <button type="button" class="ct-btn ct-copy"><i class="fa-regular fa-copy"></i> Copy source</button>
                <button type="button" class="ct-btn ct-print"><i class="fa-solid fa-print"></i> Print</button>
            </footer>`;
    }

    // Any other tool of the Tools screen: its own output, rendered the way the
    // chat renders an answer, with the same actions the tool screen offers.
    function generic(payload) {
        const body = window.renderAiMarkdown ? window.renderAiMarkdown(payload.output || '') : br(payload.output || '');
        return `<div class="ct-generic grok-response-body">${body}</div>
            <footer class="ct-foot">
                <button type="button" class="ct-btn ct-save-note"><i class="fa-solid fa-bookmark"></i> Save to Notes</button>
                <button type="button" class="ct-btn ct-copy"><i class="fa-regular fa-copy"></i> Copy</button>
                <button type="button" class="ct-btn ct-print"><i class="fa-solid fa-print"></i> Print</button>
                <button type="button" class="ct-btn ct-open-tool"><i class="fa-solid fa-up-right-from-square"></i> Open in ${esc(payload.title || 'the tool')}</button>
            </footer>`;
    }

    const BODIES = { worksheet, quiz, flashcards, notes, mindmap, generic };

    // `showSteps` is for cards built from a card's own buttons; a card that
    // answers a chat message already has its steps in the bubble above it.
    function render(res, { showSteps = false } = {}) {
        const payload = res && res.tool;
        if (!payload || !payload.tool || !BODIES[payload.tool]) return '';
        const id = `${Date.now().toString(36)}-${++seq}`;
        store.set(id, payload);
        const isPaper = payload.tool === 'worksheet' || payload.tool === 'quiz';
        return `<div class="ct-tool${isPaper ? ' ct-tool--paper' : ''}" data-ct-id="${id}" data-ct-tool="${esc(payload.tool)}">
            ${isPaper ? '' : head(payload, id)}
            <div class="ct-working" hidden><ol class="grok-live-list ct-working-list"></ol></div>
            ${showSteps && Array.isArray(payload.steps) && payload.steps.length ? `<details class="ct-steps">
                <summary><i class="fa-regular fa-lightbulb"></i> What I did · ${payload.steps.length} step${payload.steps.length === 1 ? '' : 's'}</summary>
                <ol class="grok-live-list is-done">${payload.steps.map(t => `<li class="grok-live-step">${esc(t)}</li>`).join('')}</ol>
            </details>` : ''}
            ${payload.notice ? `<p class="ct-notice">${esc(payload.notice)}</p>` : ''}
            ${BODIES[payload.tool](payload, id)}
        </div>`;
    }

    // ── Interactivity ───────────────────────────────────────────────
    // `deps` carries what the app owns: api, the auth token, toasts, and
    // the hook that drops a follow-up card into the chat stream.
    let deps = {};
    function configure(options) { deps = Object.assign(deps, options || {}); }

    // The card should work even if the app has not handed it a token getter
    // yet: the token is where the app itself keeps it.
    const token = () => (typeof deps.authToken === 'function' ? deps.authToken() : null)
        || (() => { try { return localStorage.getItem('authToken'); } catch (e) { return null; } })();
    // api.js declares `const api`, which lives in the shared global scope of
    // classic scripts rather than on `window`.
    const client = () => deps.api || (typeof api !== 'undefined' ? api : null);

    const toast = (msg, kind) => (typeof deps.showToast === 'function' ? deps.showToast(msg, kind) : undefined);

    // ── Paper behaviour ──────────────────────────────────────────────
    const timers = new Map();   // card id -> interval

    function answerOf(q) {
        const radio = q.querySelector('.ws-radio-input:checked');
        if (radio) return { value: radio.value, index: Number(radio.dataset.i) };
        const text = q.querySelector('.ct-text-answer');
        return { value: text ? text.value.trim() : '', index: null };
    }

    // "Answered: 3 / 5 (60%)", the bar, and the question pills — as on the
    // Worksheets screen.
    function updateProgress(el) {
        const qs = [...el.querySelectorAll('.ct-ws-q')];
        let done = 0;
        qs.forEach((q) => {
            const answered = Boolean(answerOf(q).value);
            if (answered) done++;
            el.querySelector(`.ct-nav-pill[data-n="${q.dataset.n}"]`)?.classList.toggle('answered', answered);
            q.querySelectorAll('.ws-option-pill').forEach((pill) => {
                pill.classList.toggle('active-selected', Boolean(pill.querySelector('.ws-radio-input:checked')));
            });
        });
        const pct = qs.length ? Math.round((done / qs.length) * 100) : 0;
        const label = el.querySelector('.ct-progress-label');
        const fill = el.querySelector('.ct-progress-fill');
        if (label) label.textContent = `Answered: ${done} / ${qs.length} (${pct}%)`;
        if (fill) fill.style.width = `${pct}%`;
    }

    function stopTimer(id) {
        clearInterval(timers.get(id));
        timers.delete(id);
    }

    function startTimer(el, seconds) {
        const id = el.dataset.ctId;
        stopTimer(id);
        const badge = el.querySelector('.ct-timer');
        const shown = el.querySelector('.ct-time-left');
        const startBtn = el.querySelector('.ct-timer-start');
        if (!badge || !shown) return;
        let left = seconds;
        const draw = () => { shown.textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`; };
        draw();
        badge.hidden = false;
        if (startBtn) startBtn.hidden = true;
        timers.set(id, setInterval(() => {
            left--;
            draw();
            if (left <= 0) {
                stopTimer(id);
                toast('⏱️ Time is up — marking your worksheet now.', 'info');
                el.querySelector('.ct-check')?.click();
            }
        }, 1000));
    }

    // The Worksheets screen's result cards: Correct / Incorrect pill, your
    // answer, the correct answer, and an explanation.
    function resultCard(r, item) {
        const ok = r.verdict === 'correct';
        const partial = r.verdict === 'partial';
        const title = (item && (item.stem || item.questionText)) || `Question ${r.n}`;
        return `<div class="ws-feedback-card glass ${ok ? 'ws-fb-correct' : 'ws-fb-incorrect'}">
            <div class="ws-fb-top">
                <div class="ws-fb-q-info">
                    <span class="ws-fb-q-num">Q${r.n}</span>
                    <span class="ws-fb-q-title">${esc(title)}</span>
                </div>
                <span class="ws-fb-status-pill ${ok ? 'status-correct' : 'status-incorrect'}">
                    ${ok ? '<i class="fa-solid fa-circle-check"></i> Correct' : partial ? '<i class="fa-solid fa-circle-half-stroke"></i> Partly right' : '<i class="fa-solid fa-circle-xmark"></i> Incorrect'}
                </span>
            </div>
            <div class="ws-fb-answers">
                <div class="ws-fb-ans-row">
                    <span class="ws-fb-ans-label"><i class="fa-solid fa-user-check"></i> Your Answer:</span>
                    <span class="ws-fb-ans-val ${ok ? 'ans-correct' : 'ans-wrong'}">${esc(r.studentAnswer || '(No answer provided)')}</span>
                </div>
                ${!ok && r.correctAnswer ? `<div class="ws-fb-ans-row">
                    <span class="ws-fb-ans-label"><i class="fa-solid fa-circle-check"></i> Correct Answer:</span>
                    <span class="ws-fb-ans-val ans-correct">${esc(r.correctAnswer)}</span>
                </div>` : ''}
            </div>
            ${r.feedback ? `<div class="ws-fb-explanation">
                <i class="fa-solid fa-lightbulb"></i>
                <div><strong>Explanation: </strong><span>${esc(r.feedback)}</span></div>
            </div>` : ''}
        </div>`;
    }

    async function checkWorksheet(root, payload) {
        const btn = root.querySelector('.ct-check');
        const qs = [...root.querySelectorAll('.ct-ws-q')];
        const items = qs.map((q, i) => {
            const item = (payload.items || [])[i] || {};
            return {
                questionText: item.questionText || '',
                options: item.options || [],
                correctAnswer: item.correctAnswer || null,
                studentAnswer: answerOf(q).value
            };
        });
        if (!items.some(i => i.studentAnswer)) { toast('Answer at least one question first.', 'info'); return; }
        stopTimer(root.dataset.ctId);
        btn.disabled = true;
        const original = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Grading Worksheet with AI...';
        try {
            const marked = await client().gradeChatWorksheet(token(), items, (payload.meta || {}).classLevel);
            const pct = marked.total ? Math.round((marked.score / marked.total) * 100) : 0;
            root.querySelector('.ct-score-val').textContent = `${marked.score}/${marked.total} (${pct}%)`;
            root.querySelector('.ct-checked-by').textContent = marked.checkedBy || 'Marked with step-by-step feedback.';
            root.querySelector('.ct-feedback-list').innerHTML =
                (marked.results || []).map(r => resultCard(r, (payload.items || [])[r.n - 1])).join('');
            root.querySelector('.ct-paper').hidden = true;
            root.querySelector('.ct-controls') && (root.querySelector('.ct-controls').hidden = true);
            root.querySelector('.ct-grading').hidden = false;
            root.querySelector('.ct-grading').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            if (window.renderChatMath) window.renderChatMath(root);
            // Same reward as finishing a worksheet on the Worksheets screen.
            try {
                const res = await client().addXp(token(), 50, 5, 'Completed Worksheet');
                if (typeof window.applyXpResult === 'function') window.applyXpResult(res);
                if (typeof window.recordActivity === 'function') window.recordActivity('Completed Worksheet', 'fa-solid fa-file-pen', 50);
            } catch (e) { /* XP is a bonus, never a blocker */ }
        } catch (e) {
            toast(e.message || "Couldn't mark your answers just now.", 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = original;
        }
    }

    function retake(root) {
        root.querySelectorAll('.ws-radio-input').forEach(r => { r.checked = false; r.disabled = false; });
        root.querySelectorAll('.ct-text-answer').forEach(t => { t.value = ''; });
        root.querySelectorAll('.ws-option-pill').forEach(p => p.classList.remove('active-selected', 'ct-opt-correct', 'ct-opt-wrong'));
        root.querySelectorAll('.ct-instant').forEach(b => { b.hidden = true; b.innerHTML = ''; });
        root.querySelectorAll('.ct-ws-q').forEach(q => delete q.dataset.answered);
        root.querySelector('.ct-grading') && (root.querySelector('.ct-grading').hidden = true);
        root.querySelector('.ct-paper').hidden = false;
        root.querySelector('.ct-controls') && (root.querySelector('.ct-controls').hidden = false);
        const qs = root.querySelector('.ct-quiz-score');
        if (qs) qs.hidden = true;
        const startBtn = root.querySelector('.ct-timer-start');
        if (startBtn) startBtn.hidden = false;
        const badge = root.querySelector('.ct-timer');
        if (badge) badge.hidden = true;
        updateProgress(root);
    }

    // A quiz answers as soon as an option is picked, against its own key.
    function answerQuiz(root, payload, q) {
        if (!q || q.dataset.answered) return;
        const item = (payload.items || []).find(i => i.n === Number(q.dataset.n));
        const chosen = answerOf(q).index;
        if (!item || chosen === null) return;
        q.dataset.answered = '1';
        const right = item.correctIndex;
        q.querySelectorAll('.ws-option-pill').forEach((pill) => {
            const i = Number(pill.dataset.i);
            pill.querySelector('.ws-radio-input').disabled = true;
            if (i === right) pill.classList.add('ct-opt-correct');
            else if (i === chosen) pill.classList.add('ct-opt-wrong');
        });
        const box = q.querySelector('.ct-instant');
        const ok = chosen === right;
        box.className = `ct-instant ct-feedback ${ok ? 'is-correct' : 'is-wrong'}`;
        box.innerHTML = `<div class="ct-verdict">${ok ? '✅ Correct' : `❌ The answer is ${String.fromCharCode(65 + right)}`}</div>
            ${item.explanation ? `<div class="ct-tip">${br(item.explanation)}</div>` : ''}`;
        box.hidden = false;

        const total = (payload.items || []).length;
        const answered = root.querySelectorAll('.ct-ws-q[data-answered]').length;
        if (answered === total) {
            const correct = root.querySelectorAll('.ct-instant.is-correct').length;
            const score = root.querySelector('.ct-quiz-score');
            score.innerHTML = `<div class="ws-score-badge"><span class="ws-score-label">Final Score</span>
                <h1 class="ws-score-val">${correct}/${total} (${Math.round((correct / total) * 100)}%)</h1></div>
                <span class="ct-checked-by">Scored against this quiz's own answer key</span>`;
            score.hidden = false;
            const retry = root.querySelector('.ct-retry');
            if (retry && correct < total) retry.hidden = false;
        }
        if (window.renderChatMath) window.renderChatMath(q);
    }

    // What the tool is doing, shown live on the card while it works — the
    // same server-recorded steps the chat's own working panel shows.
    function watchSteps(root, requestId) {
        const box = root.querySelector('.ct-working');
        const list = root.querySelector('.ct-working-list');
        if (!box || !list || !client() || !client().getAiProgress) return () => {};
        box.hidden = false;
        list.innerHTML = '<li class="grok-live-step is-pending">Starting…</li>';
        let stopped = false;
        const tick = async () => {
            if (stopped) return;
            try {
                const p = await client().getAiProgress(token(), requestId);
                const steps = (p && p.steps) || [];
                if (steps.length) {
                    list.innerHTML = steps.map((t, i) => `<li class="grok-live-step${i === steps.length - 1 && !p.done ? ' is-pending' : ''}">${esc(t)}</li>`).join('');
                }
            } catch (e) { /* the next tick tries again */ }
            if (!stopped) setTimeout(tick, 600);
        };
        tick();
        return () => { stopped = true; box.hidden = true; };
    }

    async function rerun(root, payload, change, overrides) {
        const meta = payload.meta || {};
        const sel = change === 'harder' ? '.ct-harder' : change === 'rebuild' ? '.ct-rebuild' : '.ct-more';
        const btn = root.querySelector(sel);
        const original = btn ? btn.innerHTML : '';
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Working…'; }
        const requestId = 'ct' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
        const stopWatching = watchSteps(root, requestId);
        try {
            const next = await client().runChatTool(token(), {
                tool: payload.tool,
                topic: (overrides && overrides.topic !== undefined ? overrides.topic : meta.chapter) || '',
                count: (overrides && overrides.count) || meta.count,
                difficulty: change === 'harder' ? 'Hard' : (overrides && overrides.difficulty) || meta.difficulty,
                classLevel: overrides && 'classLevel' in overrides ? overrides.classLevel : meta.classLevel,
                type: (overrides && overrides.type) || meta.type,
                requestId,
                followUp: change !== 'rebuild',
                // What this card already showed, so "More questions" brings new
                // ones. A rebuild is a fresh start, so nothing is excluded.
                seenIds: change === 'rebuild' ? [] : (payload.items || []).map(i => i.id).filter(Boolean)
            });
            stopWatching();
            // Changing the settings replaces this card; asking for more adds one.
            if (change === 'rebuild' && next && next.tool) {
                stopTimer(root.dataset.ctId);
                const holder = document.createElement('div');
                holder.innerHTML = render(next, { showSteps: true });
                const fresh = holder.firstElementChild;
                root.replaceWith(fresh);
                wire(fresh);
                return;
            }
            if (typeof deps.onFollowUp === 'function') deps.onFollowUp(next);
        } catch (e) {
            stopWatching();
            toast(e.message || "Couldn't build that just now.", 'error');
        } finally {
            if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = original; }
        }
    }

    function plainText(payload) {
        const lines = [payload.title || ''];
        if (payload.tool === 'notes') {
            (payload.sections || []).forEach(s => {
                lines.push('', s.heading);
                (s.points || []).forEach(p => lines.push(`• ${p}`));
            });
            if ((payload.terms || []).length) {
                lines.push('', 'Key terms');
                payload.terms.forEach(t => lines.push(`• ${t.term}: ${t.meaning}`));
            }
            if ((payload.mistakes || []).length) {
                lines.push('', 'Commonly got wrong');
                payload.mistakes.forEach(m => lines.push(`• ${m}`));
            }
        } else if (payload.tool === 'generic') {
            lines.push('', payload.output || '');
        } else if (payload.tool === 'mindmap') {
            lines.push('', payload.mermaid || '');
        } else {
            (payload.items || []).forEach(it => lines.push('', `${it.n}. ${it.questionText || it.question || ''}`));
        }
        return lines.join('\n').trim();
    }

    function printCard(root, payload) {
        const win = window.open('', '_blank', 'width=820,height=900');
        if (!win) { toast('Allow pop-ups to print this.', 'info'); return; }
        const body = root.cloneNode(true);
        body.querySelectorAll('.ct-foot, .ct-hint, .ct-hint-btn, .ct-feedback, .ct-instant, .ct-controls, .ct-grading, .ct-working, .ct-paper-bottom, .ct-paper-actions, .ws-test-nav-bar, .ct-quiz-score').forEach(el => el.remove());
        win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(payload.title || 'Worksheet')}</title>
            <style>
                body { font: 15px/1.6 system-ui, sans-serif; margin: 32px; color: #111; }
                .ct-q { margin: 0 0 18px; }
                .ct-q-num { font-weight: 700; margin-right: 6px; }
                .ct-answer, .ct-mermaid { display: block; width: 100%; min-height: 48px; border: 1px solid #bbb; border-radius: 6px; }
                .ct-chip, .ct-sub { font-size: 12px; color: #555; }
                .ct-option { display: block; margin: 2px 0; }
                .ws-question-card { margin: 0 0 20px; page-break-inside: avoid; }
                .ws-q-number { font-weight: 700; margin-right: 8px; }
                .ws-q-text { display: inline; font-size: 15px; }
                .ws-option-pill { display: block; margin: 6px 0 0 24px; }
                .ws-radio-input { margin-right: 6px; }
                .ct-text-answer { display: block; width: 100%; height: 44px; margin-top: 8px; border: 1px solid #bbb; border-radius: 6px; }
                .vsl-block, .vsl-source { font-size: 11px; color: #555; }
                ol { padding-left: 18px; }
            </style></head><body>${body.innerHTML}</body></html>`);
        win.document.close();
        win.focus();
        win.print();
    }

    async function saveDeck(root, payload) {
        const btn = root.querySelector('.ct-save-deck');
        const original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';
        try {
            const title = payload.title || 'Flashcards from chat';
            await client().saveChatDeck(token(), title, (payload.items || []).map(c => ({ question: c.question, answer: c.answer })));
            btn.innerHTML = '<i class="fa-solid fa-check"></i> Saved to your decks';
            toast('Saved — it will come up in your flashcard revision.', 'success');
        } catch (e) {
            btn.disabled = false;
            btn.innerHTML = original;
            toast(e.message || "Couldn't save the deck.", 'error');
        }
    }

    // Clicks are handled by ONE delegated listener, not by listeners bound to
    // each card. The chat re-renders a bubble's HTML after a turn is saved,
    // which silently replaced every wired node and left the buttons dead.
    // Delegation survives that, because it never holds a reference to a node.
    let delegated = false;
    function installDelegation() {
        if (delegated) return;
        delegated = true;
        document.addEventListener('click', (e) => {
            const el = e.target.closest ? e.target.closest('.ct-tool') : null;
            if (!el) return;
            const payload = store.get(el.dataset.ctId);
            const hit = (sel) => e.target.closest(sel);

            if (hit('.ct-hint-btn')) {
                const hint = hit('.ct-hint-btn').parentElement.querySelector('.ct-hint');
                if (hint) hint.hidden = !hint.hidden;
                return;
            }
            if (hit('.ct-card')) {
                const card = hit('.ct-card');
                const q = card.querySelector('.ct-card-q');
                const a = card.querySelector('.ct-card-a');
                const showAnswer = !a.hidden;
                q.hidden = !showAnswer;
                a.hidden = showAnswer;
                card.setAttribute('aria-pressed', String(!showAnswer));
                return;
            }
            if (hit('.ct-flip-all')) {
                const anyQuestion = [...el.querySelectorAll('.ct-card-q')].some(q => !q.hidden);
                el.querySelectorAll('.ct-card').forEach((card) => {
                    card.querySelector('.ct-card-q').hidden = anyQuestion;
                    card.querySelector('.ct-card-a').hidden = !anyQuestion;
                    card.setAttribute('aria-pressed', String(anyQuestion));
                });
                return;
            }

            // Everything below needs the payload this card was built from.
            // After a page reload a restored card no longer has one, so it says
            // so instead of doing nothing.
            if (!payload) {
                if (hit('.ct-btn') || hit('.ct-option')) toast('Ask for this again to get a fresh, working card.', 'info');
                return;
            }

            if (hit('.ct-nav-pill')) {
                el.querySelector(`.ct-ws-q[data-n="${hit('.ct-nav-pill').dataset.n}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                return;
            }
            if (hit('.ct-timer-start')) { startTimer(el, 10 * 60); return; }
            if (hit('.ct-retake')) { retake(el); return; }
            if (hit('.ct-check')) { checkWorksheet(el, payload); return; }
            if (hit('.ct-more')) { rerun(el, payload, 'more'); return; }
            if (hit('.ct-harder')) { rerun(el, payload, 'harder'); return; }
            if (hit('.ct-print')) { printCard(el, payload); return; }
            if (hit('.ct-save-deck')) { saveDeck(el, payload); return; }
            if (hit('.ct-open-tool')) {
                if (typeof deps.onOpenTool === 'function') deps.onOpenTool(payload.toolId, payload.inputs || {});
                return;
            }
            if (hit('.ct-save-note')) {
                if (typeof deps.onSaveNote === 'function') deps.onSaveNote(payload.title || 'Notes from chat', plainText(payload));
                return;
            }
            if (hit('.ct-copy')) {
                navigator.clipboard.writeText(plainText(payload))
                    .then(() => toast('Copied.', 'success'))
                    .catch(() => toast('Copy failed — select and copy manually.', 'error'));
                return;
            }
            if (hit('.ct-rebuild')) {
                const read = (sel) => el.querySelector(sel)?.value || '';
                rerun(el, payload, 'rebuild', {
                    classLevel: read('.ct-set-class') || null,
                    count: Number(read('.ct-set-count')) || (payload.meta || {}).count,
                    difficulty: read('.ct-set-difficulty') || (payload.meta || {}).difficulty,
                    type: read('.ct-set-type') || (payload.meta || {}).type,
                    topic: read('.ct-set-topic').trim()
                });
                return;
            }
            if (hit('.ct-retry')) {
                el.querySelectorAll('.ct-ws-q').forEach((q) => {
                    if (q.querySelector('.ct-instant.is-correct')) return;
                    delete q.dataset.answered;
                    q.querySelectorAll('.ws-option-pill').forEach((p) => {
                        p.classList.remove('ct-opt-correct', 'ct-opt-wrong', 'active-selected');
                        const r = p.querySelector('.ws-radio-input');
                        r.disabled = false; r.checked = false;
                    });
                    const box = q.querySelector('.ct-instant');
                    box.hidden = true; box.innerHTML = '';
                });
                el.querySelector('.ct-quiz-score').hidden = true;
                el.querySelector('.ct-retry').hidden = true;
                updateProgress(el);
            }
        });

        // Picking an option or typing an answer moves the progress bar; in a
        // quiz, picking an option is the answer.
        const onAnswer = (e) => {
            const el = e.target.closest ? e.target.closest('.ct-tool') : null;
            if (!el || !(e.target.matches('.ws-radio-input') || e.target.matches('.ct-text-answer'))) return;
            updateProgress(el);
            if (el.dataset.ctTool === 'quiz' && e.target.matches('.ws-radio-input')) {
                const payload = store.get(el.dataset.ctId);
                if (payload) answerQuiz(el, payload, e.target.closest('.ct-ws-q'));
            }
        };
        document.addEventListener('change', onAnswer);
        document.addEventListener('input', onAnswer);
    }

    // Drawing, not behaviour: mind maps and maths are rendered once per card.
    function wire(root) {
        installDelegation();
        const scope = root || document;
        const cards = scope.classList && scope.classList.contains('ct-tool')
            ? [scope]
            : [...scope.querySelectorAll('.ct-tool')];
        cards.forEach((el) => {
            if (el.querySelector('.ct-paper')) updateProgress(el);
            const map = el.querySelector('.ct-mermaid');
            if (map && window.mermaid && !map.dataset.drawn) {
                map.dataset.drawn = '1';
                const src = map.textContent;
                window.mermaid.render(`ctmap${Date.now().toString(36)}`, src)
                    .then(({ svg }) => { map.innerHTML = svg; })
                    .catch(() => { map.innerHTML = `<pre class="ct-map-fallback">${esc(src)}</pre>`; });
            }
            if (window.renderChatMath) window.renderChatMath(el);
        });
    }

    return { render, wire, configure };
})();
