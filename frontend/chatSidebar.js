/* ================================================================
   AI Companion sidebar — chat history and Memory (uploaded PDFs)
   ----------------------------------------------------------------
   Loaded after app.js and uses its globals: api, authToken,
   activeChatThreadId, restoreChatThread, escapeHtml, showToast.
   A column beside the chat on wide screens; an off-canvas drawer on
   phones, closed automatically once a chat is chosen.
   ================================================================ */
(function () {
    const side = document.getElementById('grok-side');
    if (!side) return;

    const $ = (id) => document.getElementById(id);
    const scrim = $('grok-side-scrim');
    const toggle = $('grok-side-toggle');
    const chatsEl = $('grok-side-chats');
    const searchEl = $('grok-side-search');
    const memList = $('grok-mem-list');
    const narrow = () => window.matchMedia('(max-width: 900px)').matches;
    const token = () => (typeof authToken !== 'undefined' ? authToken : null);
    const esc = (v) => (typeof escapeHtml === 'function' ? escapeHtml(String(v ?? '')) : String(v ?? ''));
    const toast = (msg, kind) => { if (typeof showToast === 'function') showToast(msg, kind); };

    // ── Open / close ────────────────────────────────────────────────
    const COLLAPSE_KEY = 'companionSidebarCollapsed';
    function setOpen(open) {
        if (narrow()) {
            side.classList.toggle('is-open', open);
            if (scrim) scrim.hidden = !open;
            document.body.classList.toggle('grok-side-lock', open);
        } else {
            side.classList.toggle('is-collapsed', !open);
            try { localStorage.setItem(COLLAPSE_KEY, open ? '0' : '1'); } catch (e) { /* private mode */ }
        }
        if (toggle) toggle.setAttribute('aria-expanded', String(open));
    }
    const isOpen = () => (narrow() ? side.classList.contains('is-open') : !side.classList.contains('is-collapsed'));

    try { if (localStorage.getItem(COLLAPSE_KEY) === '1') side.classList.add('is-collapsed'); } catch (e) { /* ignore */ }
    if (toggle) toggle.setAttribute('aria-expanded', String(isOpen()));

    toggle?.addEventListener('click', () => setOpen(!isOpen()));
    $('grok-side-close')?.addEventListener('click', () => setOpen(false));
    scrim?.addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && narrow() && side.classList.contains('is-open')) setOpen(false);
    });
    // Leaving the phone layout must not strand the page with scrolling locked.
    window.matchMedia('(max-width: 900px)').addEventListener('change', () => {
        side.classList.remove('is-open');
        if (scrim) scrim.hidden = true;
        document.body.classList.remove('grok-side-lock');
    });

    // ── Tabs ────────────────────────────────────────────────────────
    function showTab(name) {
        side.querySelectorAll('[data-side-tab]').forEach((t) => {
            const on = t.dataset.sideTab === name;
            t.classList.toggle('is-active', on);
            t.setAttribute('aria-selected', String(on));
        });
        side.querySelectorAll('[data-side-panel]').forEach((p) => { p.hidden = p.dataset.sidePanel !== name; });
        if (name === 'memory') loadMemory();
    }
    side.querySelectorAll('[data-side-tab]').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.sideTab)));

    // ── Chats ───────────────────────────────────────────────────────
    // SQLite returns "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker; read
    // naively it lands hours off and a chat from tonight files under
    // "Yesterday".
    function parseUtc(v) {
        if (!v) return null;
        const s = String(v);
        const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
        return isNaN(d) ? null : d;
    }

    function groupLabel(date) {
        if (!date) return 'Older';
        const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        const days = Math.round((startOf(new Date()) - startOf(date)) / 86400000);
        if (days <= 0) return 'Today';
        if (days === 1) return 'Yesterday';
        if (days < 7) return 'Previous 7 days';
        if (days < 30) return 'Previous 30 days';
        return 'Older';
    }

    let chatReq = 0;
    async function loadChats() {
        if (!chatsEl || !token()) return;
        const mine = ++chatReq;
        const q = (searchEl?.value || '').trim();
        let threads = [];
        try {
            const data = await api.listChatThreads(token(), q);
            threads = ((data && data.threads) || []).filter((t) => t.message_count > 0);
        } catch (e) {
            if (mine === chatReq) chatsEl.innerHTML = '<p class="grok-side-empty">Could not load chats.</p>';
            return;
        }
        if (mine !== chatReq) return;           // a newer search already answered

        if (!threads.length) {
            chatsEl.innerHTML = `<p class="grok-side-empty">${q ? 'No chats match that search.' : 'Your conversations will appear here.'}</p>`;
            return;
        }

        const active = String(typeof activeChatThreadId !== 'undefined' ? activeChatThreadId : '');
        const groups = new Map();
        for (const t of threads) {
            const g = groupLabel(parseUtc(t.updated_at));
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push(t);
        }
        chatsEl.innerHTML = [...groups].map(([label, items]) => `
            <div class="grok-side-group">
                <div class="grok-side-group-label">${esc(label)}</div>
                ${items.map((t) => `
                    <div class="grok-side-item ${String(t.id) === active ? 'is-active' : ''}" data-thread="${t.id}">
                        <button type="button" class="grok-side-item-main" data-open="${t.id}" title="${esc(t.title || 'Chat')}">
                            <span class="grok-side-item-title">${esc(t.title || 'Chat')}</span>
                        </button>
                        <div class="grok-side-item-actions">
                            <button type="button" class="grok-side-mini" data-rename="${t.id}" aria-label="Rename chat"><i class="fa-solid fa-pen"></i></button>
                            <button type="button" class="grok-side-mini is-danger" data-delete="${t.id}" aria-label="Delete chat"><i class="fa-regular fa-trash-can"></i></button>
                        </div>
                    </div>`).join('')}
            </div>`).join('');
    }

    async function openChat(id) {
        activeChatThreadId = Number(id);
        try { localStorage.setItem('activeChatThreadId', String(activeChatThreadId)); } catch (e) { /* ignore */ }
        if (typeof restoreChatThread === 'function') await restoreChatThread();
        loadChats();
        if (narrow()) setOpen(false);
    }

    function startRename(item, id) {
        const titleEl = item.querySelector('.grok-side-item-title');
        const current = titleEl ? titleEl.textContent : '';
        const input = document.createElement('input');
        input.className = 'grok-side-rename';
        input.value = current;
        input.maxLength = 160;
        item.querySelector('.grok-side-item-main').replaceWith(input);
        input.focus();
        input.select();
        let settled = false;
        const finish = async (save) => {
            if (settled) return;
            settled = true;
            const title = input.value.trim();
            if (save && title && title !== current) {
                try { await api.renameChatThread(token(), id, title); }
                catch (e) { toast('Could not rename that chat', 'error'); }
            }
            loadChats();
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); finish(true); }
            if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        });
        input.addEventListener('blur', () => finish(true));
    }

    chatsEl?.addEventListener('click', async (e) => {
        const open = e.target.closest('[data-open]');
        const rename = e.target.closest('[data-rename]');
        const del = e.target.closest('[data-delete]');
        if (open) return openChat(open.dataset.open);
        if (rename) return startRename(rename.closest('.grok-side-item'), rename.dataset.rename);
        if (del) {
            const id = del.dataset.delete;
            if (!confirm('Delete this chat? This cannot be undone.')) return;
            try {
                await api.deleteChatThread(token(), id);
                if (String(activeChatThreadId) === String(id)) document.getElementById('grok-new-chat-btn')?.click();
                loadChats();
            } catch (err) { toast('Could not delete that chat', 'error'); }
        }
    });

    let searchTimer = null;
    searchEl?.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(loadChats, 250);
    });

    $('grok-side-new')?.addEventListener('click', () => {
        document.getElementById('grok-new-chat-btn')?.click();
        showTab('chats');
        loadChats();
        if (narrow()) setOpen(false);
        document.getElementById('grok-chat-input')?.focus();
    });
    // The header's own New Chat button should leave the list in step too.
    document.getElementById('grok-new-chat-btn')?.addEventListener('click', () => setTimeout(loadChats, 50));

    // app.js fires this after each completed answer: a first message gives a
    // new chat its title, and the chat moves to the top of "Today".
    document.addEventListener('companion:turn', loadChats);

    // ── Memory ──────────────────────────────────────────────────────
    const form = $('grok-mem-form');
    const fileEl = $('grok-mem-file');
    const fileName = $('grok-mem-file-name');
    const limitEl = $('grok-mem-limit');
    const classEl = $('grok-mem-class');
    const bookEl = $('grok-mem-book');
    const langEl = $('grok-mem-lang');
    const uploadBtn = $('grok-mem-upload');
    const bar = $('grok-mem-progress');
    const errEl = $('grok-mem-error');
    let maxMb = 20;
    let memPoll = null;

    function showError(msg) {
        if (!errEl) return;
        errEl.textContent = msg || '';
        errEl.hidden = !msg;
    }

    const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

    function pickedFile() {
        const f = fileEl?.files && fileEl.files[0];
        showError('');
        if (!f) {
            if (fileName) fileName.textContent = 'Choose a PDF';
            if (uploadBtn) uploadBtn.disabled = true;
            return null;
        }
        if (fileName) fileName.textContent = `${f.name} · ${fmtSize(f.size)}`;
        // Check here, before a long upload that the server would refuse.
        const isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
        if (!isPdf) { showError('Only PDF files can be added.'); if (uploadBtn) uploadBtn.disabled = true; return null; }
        if (f.size > maxMb * 1048576) { showError(`That file is ${fmtSize(f.size)} — the limit is ${maxMb} MB.`); if (uploadBtn) uploadBtn.disabled = true; return null; }
        if (bookEl && !bookEl.value.trim()) bookEl.value = f.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ');
        if (uploadBtn) uploadBtn.disabled = false;
        return f;
    }
    fileEl?.addEventListener('change', pickedFile);

    // Drag and drop onto the drop zone.
    const drop = $('grok-mem-drop');
    ['dragenter', 'dragover'].forEach((ev) => drop?.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop?.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('is-over'); }));
    drop?.addEventListener('drop', (e) => {
        if (!fileEl || !e.dataTransfer?.files?.length) return;
        fileEl.files = e.dataTransfer.files;
        pickedFile();
    });

    form?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = pickedFile();
        if (!f || !token()) return;
        uploadBtn.disabled = true;
        bar.hidden = false;
        const fill = bar.querySelector('span');
        fill.style.width = '0%';
        try {
            await api.uploadMemoryDoc(token(), f, {
                title: f.name.replace(/\.pdf$/i, ''),
                classLabel: classEl.value,
                bookName: bookEl.value.trim(),
                language: langEl.value
            }, (p) => { fill.style.width = `${Math.round(p * 100)}%`; });
            toast('Added to memory — reading the PDF now', 'success');
            form.reset();
            pickedFile();
            loadMemory();
        } catch (err) {
            showError(err.message);
            uploadBtn.disabled = false;
        } finally {
            setTimeout(() => { bar.hidden = true; }, 400);
        }
    });

    function statusChip(d) {
        if (d.status === 'ready') return '<span class="grok-mem-chip is-ready">Ready</span>';
        if (d.status === 'failed') return `<span class="grok-mem-chip is-failed" title="${esc(d.error || '')}">Could not read</span>`;
        const pct = d.pages ? Math.round((d.pages_done / d.pages) * 100) : 0;
        return `<span class="grok-mem-chip is-working">Reading${d.pages ? ` ${pct}%` : '…'}</span>`;
    }

    async function loadMemory() {
        if (!memList || !token()) return;
        let docs = [];
        try {
            const data = await api.listMemoryDocs(token());
            docs = (data && data.docs) || [];
        } catch (e) {
            memList.innerHTML = '<p class="grok-side-empty">Could not load memory.</p>';
            return;
        }
        if (!docs.length) {
            memList.innerHTML = '<p class="grok-side-empty">Nothing saved yet. Add a PDF above.</p>';
        } else {
            memList.innerHTML = docs.map((d) => `
                <div class="grok-mem-item" data-doc="${d.id}">
                    <div class="grok-mem-item-head">
                        <i class="fa-regular fa-file-pdf"></i>
                        <span class="grok-mem-item-title" title="${esc(d.title)}">${esc(d.title)}</span>
                        ${statusChip(d)}
                    </div>
                    <div class="grok-mem-item-meta">
                        ${esc([d.class_label, d.book_name].filter(Boolean).join(' · ') || 'No class or book name yet')}
                        ${d.pages ? ` · ${d.pages} pages` : ''} · ${fmtSize(d.bytes || 0)}
                    </div>
                    <div class="grok-mem-item-actions">
                        <button type="button" class="grok-side-mini" data-ask="${d.id}" ${d.status !== 'ready' ? 'disabled' : ''}>
                            <i class="fa-regular fa-comment"></i> Ask
                        </button>
                        <button type="button" class="grok-side-mini" data-edit="${d.id}"><i class="fa-solid fa-pen"></i> Label</button>
                        <button type="button" class="grok-side-mini is-danger" data-remove="${d.id}" aria-label="Delete document"><i class="fa-regular fa-trash-can"></i></button>
                    </div>
                </div>`).join('');
        }
        memList._docs = docs;

        // Keep refreshing while anything is still being read (OCR can take minutes).
        clearTimeout(memPoll);
        if (docs.some((d) => d.status === 'processing') && !side.querySelector('[data-side-panel="memory"]').hidden) {
            memPoll = setTimeout(loadMemory, 2000);
        }
    }

    memList?.addEventListener('click', async (e) => {
        const docs = memList._docs || [];
        const ask = e.target.closest('[data-ask]');
        const edit = e.target.closest('[data-edit]');
        const remove = e.target.closest('[data-remove]');

        if (ask) {
            const d = docs.find((x) => String(x.id) === ask.dataset.ask);
            if (!d) return;
            // Name it the way matching expects: class and book name.
            const label = [d.class_label, d.book_name || d.title].filter(Boolean).join(' ');
            const input = document.getElementById('grok-chat-input');
            if (input) {
                input.value = `${label}: `;
                input.focus();
                input.setSelectionRange(input.value.length, input.value.length);
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
            if (narrow()) setOpen(false);
            return;
        }

        if (edit) {
            const d = docs.find((x) => String(x.id) === edit.dataset.edit);
            if (!d) return;
            const item = edit.closest('.grok-mem-item');
            const cls = (d.class_label || '').replace(/\D/g, '');
            item.querySelector('.grok-mem-item-meta').innerHTML = `
                <div class="grok-mem-edit">
                    <select data-f="class" aria-label="Class">
                        <option value="">Class</option>
                        ${Array.from({ length: 12 }, (_, i) => `<option ${String(i + 1) === cls ? 'selected' : ''}>${i + 1}</option>`).join('')}
                    </select>
                    <input data-f="book" value="${esc(d.book_name || '')}" placeholder="Book name" maxlength="200">
                    <button type="button" class="grok-side-mini" data-save="${d.id}">Save</button>
                </div>`;
            item.querySelector('[data-f="book"]').focus();
            return;
        }

        const save = e.target.closest('[data-save]');
        if (save) {
            const item = save.closest('.grok-mem-item');
            try {
                await api.updateMemoryDoc(token(), save.dataset.save, {
                    classLabel: item.querySelector('[data-f="class"]').value,
                    bookName: item.querySelector('[data-f="book"]').value
                });
            } catch (err) { toast('Could not save that label', 'error'); }
            loadMemory();
            return;
        }

        if (remove) {
            if (!confirm('Delete this document from memory?')) return;
            try { await api.deleteMemoryDoc(token(), remove.dataset.remove); }
            catch (err) { toast('Could not delete that document', 'error'); }
            loadMemory();
        }
    });

    async function loadLimits() {
        try {
            const l = await api.getMemoryLimits(token());
            if (l && l.maxMb) maxMb = l.maxMb;
        } catch (e) { /* keep the default */ }
        if (limitEl) limitEl.textContent = `PDF up to ${maxMb} MB`;
    }

    // ── Boot ────────────────────────────────────────────────────────
    // app.js restores the session asynchronously; wait for a token.
    let tries = 0;
    (function boot() {
        if (token()) { loadChats(); loadLimits(); return; }
        if (++tries < 40) setTimeout(boot, 250);
    })();
})();
