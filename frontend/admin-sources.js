/* ================================================================
   Verified Source Library — admin screen (/admin/sources)
   Every call is authorised server-side against LIBRARY_ADMINS; this
   page shows nothing until the server confirms admin access.
   ================================================================ */
(function () {
    const app = document.getElementById('vsa-app');
    const token = (() => { try { return localStorage.getItem('authToken'); } catch (e) { return null; } })();
    const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const statusChip = (s) => `<span class="vsa-chip s-${esc(s)}">${esc(String(s).replace(/_/g, ' '))}</span>`;

    async function api(path, opts = {}) {
        const res = await fetch(`/api/library/admin${path}`, {
            ...opts,
            headers: { Authorization: `Bearer ${token}`, ...(opts.body && !(opts.body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw Object.assign(new Error(data.msg || `Request failed (${res.status})`), { status: res.status });
        return data;
    }

    function denied(message) {
        app.innerHTML = `<div class="vsa-denied">
            <h1><i class="fa-solid fa-lock"></i> Admin access required</h1>
            <p class="vsa-muted">${esc(message)}</p>
            <p class="vsa-muted">Sign in to LearnOnline.study with an account listed in the server's <code>LIBRARY_ADMINS</code> setting, then reload this page.</p>
            <p><a class="vsa-btn" href="/">Go to LearnOnline.study</a></p>
        </div>`;
    }

    let me = null;
    let pollTimer = null;

    async function boot() {
        if (!token) return denied('You are not signed in.');
        try { me = (await api('/me')).admin; }
        catch (e) { return denied(e.status === 403 ? 'This account is not a source library administrator.' : e.message); }
        app.innerHTML = `
            <div class="vsa-head">
                <div><h1><i class="fa-solid fa-shield-halved"></i> Verified Source Library</h1>
                <p>Collect from trusted sources, review extracted questions, and control what students see as verified.</p></div>
                <div class="vsa-who">Signed in as <strong>${esc(me.username)}</strong></div>
            </div>
            <div class="vsa-stats" id="vsa-stats"></div>
            <div class="vsa-tabs" role="tablist">
                ${[['review', 'Review questions'], ['documents', 'Documents'], ['ingest', 'Sources & ingestion'], ['upload', 'Upload authorised PDF'], ['jobs', 'Jobs']]
                    .map(([k, l], i) => `<button class="vsa-tab ${i ? '' : 'is-active'}" data-tab="${k}" role="tab">${l}</button>`).join('')}
            </div>
            <section class="vsa-panel" data-panel="review"></section>
            <section class="vsa-panel" data-panel="documents" hidden></section>
            <section class="vsa-panel" data-panel="ingest" hidden></section>
            <section class="vsa-panel" data-panel="upload" hidden></section>
            <section class="vsa-panel" data-panel="jobs" hidden></section>`;
        app.querySelectorAll('[data-tab]').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));
        loadStats();
        showTab('review');
    }

    function panel(name) { return app.querySelector(`[data-panel="${name}"]`); }

    function showTab(name) {
        app.querySelectorAll('[data-tab]').forEach(t => t.classList.toggle('is-active', t.dataset.tab === name));
        app.querySelectorAll('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== name; });
        clearTimeout(pollTimer);
        ({ review: renderReview, documents: renderDocuments, ingest: renderIngest, upload: renderUpload, jobs: renderJobs })[name]();
    }

    async function loadStats() {
        const s = await api('/stats').catch(() => null);
        if (!s) return;
        const cells = [
            ['Documents processed', s.documentsProcessed], ['Questions extracted', s.questionsExtracted],
            ['Auto verified', s.autoVerified], ['Human verified', s.humanVerified],
            ['Needs review', s.needsReview], ['Rejected', s.rejected], ['Failed documents', s.documentsFailed]
        ];
        document.getElementById('vsa-stats').innerHTML = cells.map(([l, v]) => `<div class="vsa-stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('');
    }

    // ── Review ────────────────────────────────────────────────────────
    async function renderReview(filter = 'UNVERIFIED', q = '') {
        const el = panel('review');
        el.innerHTML = `<div class="vsa-card">
            <div class="vsa-row">
                <select id="vsa-status">${['UNVERIFIED', 'AUTO_VERIFIED', 'HUMAN_VERIFIED', 'REJECTED', ''].map(s => `<option value="${s}" ${s === filter ? 'selected' : ''}>${s ? s.replace(/_/g, ' ') : 'All statuses'}</option>`).join('')}</select>
                <input type="text" id="vsa-q" placeholder="Search question text" value="${esc(q)}">
                <button class="vsa-btn" id="vsa-go">Search</button>
            </div></div>
            <div class="vsa-card"><div class="vsa-table-wrap"><table class="vsa-table">
                <thead><tr><th>#</th><th>Question</th><th>Section</th><th>PDF p.</th><th>Printed p.</th><th>Status</th></tr></thead>
                <tbody id="vsa-qrows"><tr><td colspan="6" class="vsa-muted">Loading…</td></tr></tbody></table></div></div>
            <div id="vsa-verify"></div>`;
        const run = () => renderReview(document.getElementById('vsa-status').value, document.getElementById('vsa-q').value);
        document.getElementById('vsa-go').onclick = run;
        document.getElementById('vsa-q').onkeydown = (e) => { if (e.key === 'Enter') run(); };
        document.getElementById('vsa-status').onchange = run;

        const params = new URLSearchParams();
        if (filter) params.set('status', filter);
        if (q) params.set('q', q);
        const { questions } = await api(`/questions?${params}`);
        const body = document.getElementById('vsa-qrows');
        if (!questions.length) { body.innerHTML = '<tr><td colspan="6" class="vsa-muted">Nothing here.</td></tr>'; return; }
        body.innerHTML = questions.map(r => `<tr class="is-clickable" data-q="${r.id}">
            <td>${r.kind === 'example' ? 'Ex ' : ''}${esc(r.question_number ?? '—')}</td>
            <td>${esc(r.preview)}</td><td class="vsa-muted">${esc(r.section ?? '—')}</td>
            <td>${esc(r.start_pdf_page)}${r.end_pdf_page !== r.start_pdf_page ? '–' + esc(r.end_pdf_page) : ''}</td>
            <td>${esc(r.printed_page ?? '—')}</td><td>${statusChip(r.verification_status)}</td></tr>`).join('');
        body.querySelectorAll('[data-q]').forEach(tr => tr.addEventListener('click', () => openVerify(tr.dataset.q)));
    }

    async function pageImage(documentId, page) {
        const res = await fetch(`/api/library/documents/${documentId}/pages/${page}/image`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error('Could not render the page.');
        return URL.createObjectURL(await res.blob());
    }

    async function openVerify(id) {
        const box = document.getElementById('vsa-verify');
        box.innerHTML = '<div class="vsa-card vsa-muted">Loading question…</div>';
        const { question: q, citation, logs } = await api(`/questions/${id}`);
        const checks = (() => { try { return JSON.parse(q.verification_notes || '[]'); } catch (e) { return []; } })();
        const bbox = (() => { try { return JSON.parse(q.bbox_json || '{}'); } catch (e) { return {}; } })();
        box.innerHTML = `<div class="vsa-card"><h2>Verify question ${esc(q.kind === 'example' ? 'Example ' + (q.question_number ?? '') : (q.question_number ?? ''))}</h2>
            <div class="vsa-verify">
                <div>
                    <div class="vsa-row" style="margin-bottom:8px">
                        <span class="vsa-muted">Original document · PDF page</span>
                        <select id="vsa-pagepick">${Array.from({ length: Math.max(q.end_pdf_page, q.start_pdf_page) - q.start_pdf_page + 1 }, (_, i) => q.start_pdf_page + i).map(p => `<option>${p}</option>`).join('')}</select>
                        ${q.source_url ? `<a class="vsa-btn" href="${esc(q.source_url)}#page=${esc(q.start_pdf_page)}" target="_blank" rel="noopener noreferrer">Open official PDF</a>` : ''}
                    </div>
                    <div class="vsa-page" id="vsa-page"><p class="vsa-muted" style="padding:20px">Rendering page…</p></div>
                </div>
                <div>
                    <div class="vsa-grid2">
                        <label class="vsa-field">Book<input type="text" value="${esc(q.book_title)}" disabled></label>
                        <label class="vsa-field">Publisher<input type="text" value="${esc(q.publisher)}" disabled></label>
                        <label class="vsa-field">Class / Subject<input type="text" value="${esc(`Class ${q.class_level ?? '—'} · ${q.subject ?? '—'}`)}" disabled></label>
                        <label class="vsa-field">Chapter<input type="text" id="e-chapter" value="${esc(q.chapter ?? '')}"></label>
                        <label class="vsa-field">Section<input type="text" id="e-section" value="${esc(q.section ?? '')}" placeholder="empty = unknown"></label>
                        <label class="vsa-field">Question number<input type="text" id="e-number" value="${esc(q.question_number ?? '')}" placeholder="empty = not in document"></label>
                        <label class="vsa-field">Printed page<input type="number" id="e-printed" value="${esc(q.printed_page ?? '')}" placeholder="empty = not confirmed"></label>
                        <label class="vsa-field">PDF page<input type="text" value="${esc(q.start_pdf_page)}${q.end_pdf_page !== q.start_pdf_page ? '–' + esc(q.end_pdf_page) : ''}" disabled></label>
                    </div>
                    <label class="vsa-field" style="margin-top:8px">Question text<textarea id="e-text">${esc(q.question_text)}</textarea></label>
                    <div class="vsa-muted" style="margin-top:8px">Status: ${statusChip(q.verification_status)} · Licence: ${esc(q.license_status)} · Usage: ${esc(q.usage_mode)}</div>
                    <ul class="vsa-checks">${checks.map(c => `<li class="${c.ok ? 'ok' : 'no'}">${c.ok ? '✓' : '✗'} ${esc(c.n)}</li>`).join('') || '<li class="vsa-muted">No automatic checks recorded.</li>'}</ul>
                    <div class="vsa-row" style="margin-top:12px">
                        <button class="vsa-btn is-good" id="v-approve"><i class="fa-solid fa-check"></i> Approve</button>
                        <button class="vsa-btn is-bad" id="v-reject"><i class="fa-solid fa-xmark"></i> Reject</button>
                        <button class="vsa-btn" id="v-save"><i class="fa-solid fa-pen"></i> Save metadata</button>
                    </div>
                    <p class="vsa-muted">Saving an edit sets the question back to Unverified until it is approved again.</p>
                    <div class="vsa-citation"><div class="vsa-muted" style="margin-bottom:6px">What students see now:</div>${window.SourceLibraryUI.render({ library: { cards: [{ questionText: q.question_text, citation }] } })}</div>
                    ${logs.length ? `<details style="margin-top:10px"><summary class="vsa-muted">History (${logs.length})</summary><ul class="vsa-checks">${logs.map(l => `<li>${esc(l.created_at)} · ${esc(l.action)} · ${esc(l.from_status)} → ${esc(l.to_status)}</li>`).join('')}</ul></details>` : ''}
                </div>
            </div></div>`;
        window.SourceLibraryUI.wire(box);
        box.scrollIntoView({ behavior: 'smooth', block: 'start' });

        const showPage = async (page) => {
            const holder = document.getElementById('vsa-page');
            try {
                const url = await pageImage(q.document_id, page);
                holder.innerHTML = `<img alt="PDF page ${page}" src="${url}">`;
                // Highlight the stored coordinates (PDF points, origin bottom-left).
                const region = [bbox.start, bbox.end].find(b => b && b.page === Number(page));
                if (region && region.pageHeight && region.pageWidth) {
                    const pad = 6;
                    const hl = document.createElement('div');
                    hl.className = 'vsa-hl';
                    hl.style.left = `${((region.left - pad) / region.pageWidth) * 100}%`;
                    hl.style.top = `${((region.pageHeight - region.top - pad) / region.pageHeight) * 100}%`;
                    hl.style.width = `${((region.right - region.left + 2 * pad) / region.pageWidth) * 100}%`;
                    hl.style.height = `${((region.top - region.bottom + 2 * pad + 4) / region.pageHeight) * 100}%`;
                    holder.appendChild(hl);
                }
            } catch (e) { holder.innerHTML = `<p class="vsa-muted" style="padding:20px">${esc(e.message)}</p>`; }
        };
        showPage(q.start_pdf_page);
        document.getElementById('vsa-pagepick').onchange = (e) => showPage(e.target.value);

        const after = async () => { await loadStats(); await renderReview(document.getElementById('vsa-status')?.value ?? 'UNVERIFIED'); openVerify(id); };
        document.getElementById('v-approve').onclick = async () => { await api(`/questions/${id}/approve`, { method: 'POST', body: '{}' }); after(); };
        document.getElementById('v-reject').onclick = async () => { await api(`/questions/${id}/reject`, { method: 'POST', body: '{}' }); after(); };
        document.getElementById('v-save').onclick = async () => {
            try {
                await api(`/questions/${id}`, { method: 'PATCH', body: JSON.stringify({
                    chapter: document.getElementById('e-chapter').value,
                    section: document.getElementById('e-section').value,
                    question_number: document.getElementById('e-number').value,
                    printed_page: document.getElementById('e-printed').value,
                    question_text: document.getElementById('e-text').value
                }) });
                after();
            } catch (e) { alert(e.message); }
        };
    }

    // ── Documents ─────────────────────────────────────────────────────
    async function renderDocuments() {
        const el = panel('documents');
        el.innerHTML = '<div class="vsa-card vsa-muted">Loading…</div>';
        const { documents } = await api('/documents');
        el.innerHTML = `<div class="vsa-card"><div class="vsa-table-wrap"><table class="vsa-table">
            <thead><tr><th>ID</th><th>Document</th><th>Class · Subject</th><th>Status</th><th>Pages</th><th>Printed pages</th><th>Questions</th><th>Checked</th><th></th></tr></thead><tbody>
            ${documents.map(d => `<tr>
                <td>${d.id}</td>
                <td><strong>${esc(d.discovered_label || d.book_title)}</strong><div class="vsa-muted">${esc(d.book_title)}</div>
                    ${d.document_url && d.document_url.startsWith('https://') ? `<a class="vsa-muted" href="${esc(d.document_url)}" target="_blank" rel="noopener noreferrer">${esc(d.document_url)}</a>` : `<span class="vsa-muted">uploaded</span>`}
                    ${d.content_hash ? `<div class="vsa-muted">SHA-256 ${esc(d.content_hash.slice(0, 16))}…</div>` : ''}
                    ${d.error ? `<div class="vsa-muted" style="color:var(--danger-color)">${esc(d.error)}</div>` : ''}</td>
                <td>Class ${esc(d.class_level ?? '—')} · ${esc(d.subject ?? '—')}<div class="vsa-muted">${esc(d.chapter ?? '')}</div></td>
                <td>${statusChip(d.status)}</td>
                <td>${esc(d.pdf_pages ?? '—')}</td>
                <td class="vsa-muted">${d.printed_page_method ? `${esc(d.printed_page_method)}, offset ${esc(d.printed_page_offset)}` : 'not confirmed'}</td>
                <td>${esc(d.questions)}<div class="vsa-muted">${esc(d.needs_review)} need review</div></td>
                <td class="vsa-muted">${esc(d.date_last_checked || d.processed_at || '—')}</td>
                <td><button class="vsa-btn" data-reprocess="${d.id}">Reprocess</button></td></tr>`).join('') || '<tr><td colspan="9" class="vsa-muted">No documents yet.</td></tr>'}
            </tbody></table></div></div>`;
        el.querySelectorAll('[data-reprocess]').forEach(b => b.addEventListener('click', async () => {
            b.disabled = true;
            await api(`/documents/${b.dataset.reprocess}/reprocess`, { method: 'POST', body: '{}' });
            showTab('jobs');
        }));
    }

    // ── Sources & ingestion ──────────────────────────────────────────
    async function renderIngest() {
        const el = panel('ingest');
        const { sources } = await api('/sources');
        el.innerHTML = `<div class="vsa-card"><h2>Trusted sources</h2><div class="vsa-table-wrap"><table class="vsa-table">
            <thead><tr><th>Source</th><th>Allowed hosts</th><th>Usage</th><th>Redistribution</th></tr></thead><tbody>
            ${sources.map(s => `<tr><td><strong>${esc(s.title)}</strong><div class="vsa-muted">${esc(s.publisher)} · ${esc(s.source_type)}</div><div class="vsa-muted">${esc(s.official_url)}</div></td>
                <td>${esc(s.allowed_hosts)}</td><td>${esc(s.usage_mode)}<div class="vsa-muted">${esc(s.license_status)}</div></td>
                <td>${Number(s.redistribution_allowed) ? 'Allowed' : 'Not allowed — link out only'}</td></tr>`).join('')}
            </tbody></table></div></div>
            <div class="vsa-card"><h2>Discover documents on an official page</h2>
                <div class="vsa-row">
                    <select id="d-source">${sources.filter(s => s.source_type !== 'AUTHORIZED_UPLOAD').map(s => `<option value="${s.id}">${esc(s.title)}</option>`).join('')}</select>
                    <select id="d-class">${Array.from({ length: 12 }, (_, i) => `<option ${i + 1 === 7 ? 'selected' : ''}>${i + 1}</option>`).join('')}</select>
                    <input type="text" id="d-subject" value="Mathematics" placeholder="Subject folder, e.g. Mathematics">
                    <button class="vsa-btn is-primary" id="d-go">Discover</button>
                </div>
                <p class="vsa-muted">Discovery only reads the official listing page. Nothing is downloaded until you choose units.</p>
                <div id="d-out"></div></div>
            <div class="vsa-card"><h2>Add a trusted source</h2>
                <p class="vsa-muted">Only add publishers whose content you have permission to index. Discovery needs an adapter for the source type; without one, use authorised upload.</p>
                <div class="vsa-grid2">
                    <input type="text" id="s-key" placeholder="source_key (e.g. ncert-textbooks)">
                    <input type="text" id="s-publisher" placeholder="Publisher">
                    <input type="text" id="s-type" placeholder="Source type (e.g. NCERT_TEXTBOOK)">
                    <input type="text" id="s-title" placeholder="Title">
                    <input type="text" id="s-url" placeholder="Official listing URL (https)">
                    <input type="text" id="s-hosts" placeholder="Allowed hosts, comma-separated">
                    <select id="s-usage"><option value="metadata_only">metadata_only</option><option value="excerpt_link">excerpt_link</option><option value="licensed_full_text">licensed_full_text</option></select>
                    <input type="text" id="s-license" placeholder="Licence / permission status">
                </div>
                <div class="vsa-row" style="margin-top:8px"><label class="vsa-muted"><input type="checkbox" id="s-redist"> Redistribution allowed</label><button class="vsa-btn" id="s-add">Add source</button></div>
                <p class="vsa-muted" id="s-msg"></p></div>`;

        document.getElementById('d-go').onclick = async () => {
            const out = document.getElementById('d-out');
            out.innerHTML = '<p class="vsa-muted">Reading the official page (rate-limited, honours robots.txt)…</p>';
            try {
                const r = await api(`/sources/${document.getElementById('d-source').value}/discover`, { method: 'POST', body: JSON.stringify({ classLevel: document.getElementById('d-class').value, subject: document.getElementById('d-subject').value }) });
                out.innerHTML = `<p class="vsa-muted">From ${esc(r.pageUrl)} ${r.note ? '· ' + esc(r.note) : ''}</p>
                    <div class="vsa-table-wrap"><table class="vsa-table"><thead><tr><th></th><th>Label on official page</th><th>Chapter</th><th>URL</th></tr></thead><tbody>
                    ${r.candidates.map(c => `<tr><td>${c.documentKind === 'unit' ? `<input type="checkbox" value="${c.unitNumber}" class="d-unit">` : ''}</td><td>${esc(c.label)}</td><td>${esc(c.chapter ?? '—')}</td><td class="vsa-muted">${esc(c.url)}</td></tr>`).join('')}
                    </tbody></table></div>
                    ${r.rejected.length ? `<p class="vsa-muted">${r.rejected.length} link(s) rejected: ${r.rejected.slice(0, 3).map(x => esc(x.reason)).join('; ')}</p>` : ''}
                    <div class="vsa-row" style="margin-top:8px"><button class="vsa-btn is-primary" id="d-ingest">Ingest selected units (max 5)</button></div>`;
                document.getElementById('d-ingest').onclick = async () => {
                    const units = [...out.querySelectorAll('.d-unit:checked')].map(i => Number(i.value));
                    try {
                        await api(`/sources/${document.getElementById('d-source').value}/ingest`, { method: 'POST', body: JSON.stringify({ classLevel: document.getElementById('d-class').value, subject: document.getElementById('d-subject').value, units }) });
                        showTab('jobs');
                    } catch (e) { alert(e.message); }
                };
            } catch (e) { out.innerHTML = `<p class="vsa-muted" style="color:var(--danger-color)">${esc(e.message)}</p>`; }
        };
        document.getElementById('s-add').onclick = async () => {
            const msg = document.getElementById('s-msg');
            try {
                await api('/sources', { method: 'POST', body: JSON.stringify({
                    source_key: document.getElementById('s-key').value, publisher: document.getElementById('s-publisher').value,
                    source_type: document.getElementById('s-type').value, title: document.getElementById('s-title').value,
                    official_url: document.getElementById('s-url').value, allowed_hosts: document.getElementById('s-hosts').value,
                    usage_mode: document.getElementById('s-usage').value, license_status: document.getElementById('s-license').value,
                    redistribution_allowed: document.getElementById('s-redist').checked }) });
                renderIngest();
            } catch (e) { msg.textContent = e.message; }
        };
    }

    // ── Upload ────────────────────────────────────────────────────────
    function renderUpload() {
        const el = panel('upload');
        el.innerHTML = `<div class="vsa-card"><h2>Upload an authorised PDF</h2>
            <p class="vsa-muted">For material you are permitted to index when automated collection is not allowed or not possible. Uploaded questions are never auto-verified: each needs a human approval before students see a citation.</p>
            <div class="vsa-grid2">
                <label class="vsa-field">PDF<input type="file" id="u-file" accept="application/pdf,.pdf"></label>
                <label class="vsa-field">Publisher *<input type="text" id="u-publisher"></label>
                <label class="vsa-field">Book title *<input type="text" id="u-title"></label>
                <label class="vsa-field">Edition<input type="text" id="u-edition" placeholder="leave empty if unknown"></label>
                <label class="vsa-field">Class<input type="text" id="u-class" placeholder="e.g. 7"></label>
                <label class="vsa-field">Subject<input type="text" id="u-subject"></label>
                <label class="vsa-field">Chapter<input type="text" id="u-chapter"></label>
                <label class="vsa-field">Source type<input type="text" id="u-type" value="AUTHORIZED_UPLOAD"></label>
                <label class="vsa-field">Licence / permission *<input type="text" id="u-license" placeholder="e.g. written permission from publisher, 2026-09-18"></label>
                <label class="vsa-field">Usage mode<select id="u-usage"><option value="authorized_upload">authorized_upload</option><option value="metadata_only">metadata_only</option><option value="excerpt_link">excerpt_link</option><option value="licensed_full_text">licensed_full_text</option></select></label>
            </div>
            <div class="vsa-row" style="margin-top:10px">
                <label class="vsa-muted"><input type="checkbox" id="u-redist"> Redistribution allowed (students may view pages in-app)</label>
            </div>
            <div class="vsa-row" style="margin-top:6px">
                <label><input type="checkbox" id="u-confirm"> I am authorised to index this document.</label>
            </div>
            <div class="vsa-row" style="margin-top:10px"><button class="vsa-btn is-primary" id="u-go">Upload and process</button></div>
            <p class="vsa-muted" id="u-msg"></p></div>`;
        document.getElementById('u-go').onclick = async () => {
            const msg = document.getElementById('u-msg');
            const file = document.getElementById('u-file').files[0];
            if (!file) { msg.textContent = 'Choose a PDF.'; return; }
            if (!document.getElementById('u-confirm').checked) { msg.textContent = 'Confirm that you are authorised to index this document.'; return; }
            const params = new URLSearchParams({
                publisher: document.getElementById('u-publisher').value, book_title: document.getElementById('u-title').value,
                edition: document.getElementById('u-edition').value, class_level: document.getElementById('u-class').value,
                subject: document.getElementById('u-subject').value, chapter: document.getElementById('u-chapter').value,
                source_type: document.getElementById('u-type').value, license_status: document.getElementById('u-license').value,
                usage_mode: document.getElementById('u-usage').value, redistribution_allowed: document.getElementById('u-redist').checked ? '1' : '',
                permission_confirmed: 'true'
            });
            msg.textContent = 'Uploading…';
            try {
                const res = await fetch(`/api/library/admin/upload?${params}`, {
                    method: 'POST', body: file,
                    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent(file.name) }
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.msg || 'Upload failed');
                showTab('jobs');
            } catch (e) { msg.textContent = e.message; }
        };
    }

    // ── Jobs ──────────────────────────────────────────────────────────
    async function renderJobs() {
        const el = panel('jobs');
        const { jobs } = await api('/jobs');
        const openId = el.dataset.open;
        el.innerHTML = `<div class="vsa-card"><div class="vsa-table-wrap"><table class="vsa-table">
            <thead><tr><th>ID</th><th>Kind</th><th>Status</th><th>Progress</th><th>Latest</th><th>Created</th></tr></thead><tbody>
            ${jobs.map(j => `<tr class="is-clickable" data-job="${j.id}"><td>${j.id}</td><td>${esc(j.kind)}</td><td>${statusChip(j.status)}</td>
                <td><div class="vsa-bar"><span style="width:${Number(j.progress) || 0}%"></span></div></td>
                <td class="vsa-muted">${esc(j.message ?? '')}</td><td class="vsa-muted">${esc(j.created_at)}</td></tr>`).join('') || '<tr><td colspan="6" class="vsa-muted">No jobs yet.</td></tr>'}
            </tbody></table></div></div><div id="vsa-joblog"></div>`;
        const showLog = async (id) => {
            el.dataset.open = id;
            const { job } = await api(`/jobs/${id}`);
            document.getElementById('vsa-joblog').innerHTML = `<div class="vsa-card"><h2>Job ${job.id} log</h2><div class="vsa-log">${esc(job.log_text || '(no output yet)')}</div></div>`;
        };
        el.querySelectorAll('[data-job]').forEach(tr => tr.addEventListener('click', () => showLog(tr.dataset.job)));
        if (openId || jobs[0]) showLog(openId || jobs[0].id);
        if (jobs.some(j => j.status === 'queued' || j.status === 'running')) {
            pollTimer = setTimeout(() => { if (!panel('jobs').hidden) { renderJobs(); loadStats(); } }, 2500);
        }
    }

    boot();
})();
