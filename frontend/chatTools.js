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
            <label class="ct-field ct-field-grow"><span>Topic</span>
                <input type="text" class="ct-set-topic" value="${esc(m.chapter || '')}" placeholder="chapter or topic">
            </label>
            <button type="button" class="ct-btn is-primary ct-rebuild"><i class="fa-solid fa-rotate"></i> Rebuild</button>
        </div>`;
    }

    function worksheet(payload, id) {
        const rows = (payload.items || []).map(it => `
            <li class="ct-q" data-n="${it.n}">
                <div class="ct-q-head">
                    <span class="ct-q-num">${it.n}</span>
                    ${it.marks ? `<span class="ct-marks">${esc(it.marks)} mark${Number(it.marks) === 1 ? '' : 's'}</span>` : ''}
                </div>
                <div class="ct-q-text">${br(it.questionText)}</div>
                <textarea class="ct-answer" rows="2" placeholder="Your answer…" aria-label="Answer to question ${it.n}"></textarea>
                <div class="ct-feedback" hidden></div>
                ${it.hint ? `<button type="button" class="ct-btn is-quiet ct-hint-btn"><i class="fa-regular fa-lightbulb"></i> Hint</button>
                <p class="ct-hint" hidden>${br(it.hint)}</p>` : ''}
                ${provenance(it)}
            </li>`).join('');
        return `${controls(payload)}
            <ol class="ct-list">${rows}</ol>
            <div class="ct-score" hidden></div>
            <footer class="ct-foot">
                <button type="button" class="ct-btn is-primary ct-check"><i class="fa-solid fa-check-double"></i> Check my answers</button>
                <button type="button" class="ct-btn ct-more"><i class="fa-solid fa-plus"></i> More questions</button>
                <button type="button" class="ct-btn ct-harder"><i class="fa-solid fa-arrow-trend-up"></i> Harder</button>
                <button type="button" class="ct-btn ct-print"><i class="fa-solid fa-print"></i> Print</button>
            </footer>`;
    }

    function quiz(payload) {
        const rows = (payload.items || []).map(it => `
            <li class="ct-q" data-n="${it.n}">
                <div class="ct-q-head"><span class="ct-q-num">${it.n}</span></div>
                <div class="ct-q-text">${br(it.questionText)}</div>
                <div class="ct-options" role="group" aria-label="Options for question ${it.n}">
                    ${it.options.map((opt, i) => `<button type="button" class="ct-option" data-i="${i}">
                        <span class="ct-option-key">${String.fromCharCode(65 + i)}</span> ${esc(opt)}
                    </button>`).join('')}
                </div>
                <div class="ct-feedback" hidden></div>
            </li>`).join('');
        return `${controls(payload)}
            <ol class="ct-list">${rows}</ol>
            <div class="ct-score" hidden></div>
            <footer class="ct-foot">
                <button type="button" class="ct-btn ct-more"><i class="fa-solid fa-plus"></i> More questions</button>
                <button type="button" class="ct-btn ct-harder"><i class="fa-solid fa-arrow-trend-up"></i> Harder</button>
                <button type="button" class="ct-btn ct-retry" hidden><i class="fa-solid fa-rotate-right"></i> Try the ones I missed</button>
            </footer>`;
    }

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

    function render(res) {
        const payload = res && res.tool;
        if (!payload || !payload.tool || !BODIES[payload.tool]) return '';
        const id = `${Date.now().toString(36)}-${++seq}`;
        store.set(id, payload);
        return `<div class="ct-tool" data-ct-id="${id}" data-ct-tool="${esc(payload.tool)}">
            ${head(payload, id)}
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

    function verdictClass(v) {
        return v === 'correct' ? 'is-correct' : v === 'partial' ? 'is-partial' : 'is-wrong';
    }

    async function checkWorksheet(root, payload) {
        const btn = root.querySelector('.ct-check');
        const items = [...root.querySelectorAll('.ct-q')].map((li, i) => ({
            questionText: (payload.items[i] || {}).questionText || '',
            studentAnswer: li.querySelector('.ct-answer')?.value || ''
        }));
        if (!items.some(i => i.studentAnswer.trim())) { toast('Write at least one answer first.', 'info'); return; }
        btn.disabled = true;
        const original = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking…';
        try {
            const marked = await client().gradeChatWorksheet(token(), items, (payload.meta || {}).classLevel);
            (marked.results || []).forEach((r) => {
                const li = root.querySelector(`.ct-q[data-n="${r.n}"]`);
                if (!li) return;
                const box = li.querySelector('.ct-feedback');
                box.className = `ct-feedback ${verdictClass(r.verdict)}`;
                box.innerHTML = `<div class="ct-verdict">${r.verdict === 'correct' ? '✅ Correct' : r.verdict === 'partial' ? '🟡 Partly right' : '❌ Not right yet'}</div>
                    ${r.correctAnswer ? `<div class="ct-correct"><strong>Answer:</strong> ${br(r.correctAnswer)}</div>` : ''}
                    ${r.feedback ? `<div class="ct-tip">${br(r.feedback)}</div>` : ''}`;
                box.hidden = false;
            });
            const score = root.querySelector('.ct-score');
            score.innerHTML = `<strong>${marked.score} / ${marked.total}</strong>
                <span class="ct-checked-by">${esc(marked.checkedBy || '')}</span>`;
            score.hidden = false;
            if (window.renderChatMath) window.renderChatMath(root);
        } catch (e) {
            toast(e.message || "Couldn't check your answers just now.", 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = original;
        }
    }

    function answerQuiz(root, payload, li, chosen) {
        const n = Number(li.dataset.n);
        const item = (payload.items || []).find(i => i.n === n);
        if (!item || li.dataset.answered) return;
        li.dataset.answered = '1';
        const right = item.correctIndex;
        li.querySelectorAll('.ct-option').forEach((opt) => {
            const i = Number(opt.dataset.i);
            opt.disabled = true;
            if (i === right) opt.classList.add('is-correct');
            else if (i === chosen) opt.classList.add('is-wrong');
        });
        const box = li.querySelector('.ct-feedback');
        const ok = chosen === right;
        box.className = `ct-feedback ${ok ? 'is-correct' : 'is-wrong'}`;
        box.innerHTML = `<div class="ct-verdict">${ok ? '✅ Correct' : `❌ The answer is ${String.fromCharCode(65 + right)}`}</div>
            ${item.explanation ? `<div class="ct-tip">${br(item.explanation)}</div>` : ''}`;
        box.hidden = false;

        const answered = root.querySelectorAll('.ct-q[data-answered]').length;
        const total = (payload.items || []).length;
        if (answered === total) {
            const correct = [...root.querySelectorAll('.ct-q')].filter(q => q.querySelector('.ct-feedback.is-correct')).length;
            const score = root.querySelector('.ct-score');
            score.innerHTML = `<strong>${correct} / ${total}</strong> <span class="ct-checked-by">Scored against this quiz's own answer key</span>`;
            score.hidden = false;
            const retry = root.querySelector('.ct-retry');
            if (retry && correct < total) retry.hidden = false;
        }
        if (window.renderChatMath) window.renderChatMath(li);
    }

    async function rerun(root, payload, change, overrides) {
        const meta = payload.meta || {};
        const sel = change === 'harder' ? '.ct-harder' : change === 'rebuild' ? '.ct-rebuild' : '.ct-more';
        const btn = root.querySelector(sel);
        const original = btn ? btn.innerHTML : '';
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Working…'; }
        try {
            const next = await client().runChatTool(token(), {
                tool: payload.tool,
                topic: (overrides && overrides.topic !== undefined ? overrides.topic : meta.chapter) || '',
                count: (overrides && overrides.count) || meta.count,
                difficulty: change === 'harder' ? 'Hard' : (overrides && overrides.difficulty) || meta.difficulty,
                classLevel: overrides && 'classLevel' in overrides ? overrides.classLevel : meta.classLevel,
                // What this card already showed, so "More questions" brings new
                // ones. A rebuild is a fresh start, so nothing is excluded.
                seenIds: change === 'rebuild' ? [] : (payload.items || []).map(i => i.id).filter(Boolean)
            });
            // Changing the settings replaces this card; asking for more adds one.
            if (change === 'rebuild' && next && next.tool) {
                const holder = document.createElement('div');
                holder.innerHTML = render(next);
                const fresh = holder.firstElementChild;
                root.replaceWith(fresh);
                wire(fresh);
                return;
            }
            if (typeof deps.onFollowUp === 'function') deps.onFollowUp(next);
        } catch (e) {
            toast(e.message || "Couldn't build that just now.", 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.innerHTML = original; }
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
        body.querySelectorAll('.ct-foot, .ct-hint, .ct-feedback').forEach(el => el.remove());
        win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(payload.title || 'Worksheet')}</title>
            <style>
                body { font: 15px/1.6 system-ui, sans-serif; margin: 32px; color: #111; }
                .ct-q { margin: 0 0 18px; }
                .ct-q-num { font-weight: 700; margin-right: 6px; }
                .ct-answer, .ct-mermaid { display: block; width: 100%; min-height: 48px; border: 1px solid #bbb; border-radius: 6px; }
                .ct-chip, .ct-sub { font-size: 12px; color: #555; }
                .ct-option { display: block; margin: 2px 0; }
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

            if (hit('.ct-option')) { answerQuiz(el, payload, hit('.ct-q'), Number(hit('.ct-option').dataset.i)); return; }
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
                    topic: read('.ct-set-topic').trim()
                });
                return;
            }
            if (hit('.ct-retry')) {
                el.querySelectorAll('.ct-q').forEach((li) => {
                    if (li.querySelector('.ct-feedback.is-correct')) return;
                    delete li.dataset.answered;
                    li.querySelectorAll('.ct-option').forEach((o) => { o.disabled = false; o.classList.remove('is-correct', 'is-wrong'); });
                    const box = li.querySelector('.ct-feedback');
                    box.hidden = true; box.innerHTML = '';
                });
                el.querySelector('.ct-score').hidden = true;
                el.querySelector('.ct-retry').hidden = true;
            }
        });
    }

    // Drawing, not behaviour: mind maps and maths are rendered once per card.
    function wire(root) {
        installDelegation();
        const scope = root || document;
        const cards = scope.classList && scope.classList.contains('ct-tool')
            ? [scope]
            : [...scope.querySelectorAll('.ct-tool')];
        cards.forEach((el) => {
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
