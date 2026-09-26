(() => {
    'use strict';
    const $ = id => document.getElementById(id);
    let current = null, classId = '', loading = 0;
    const edits = new Map();
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const token = () => localStorage.getItem('authToken');
    const endpoint = suffix => `/api/teaching-studio/classes/${encodeURIComponent(classId)}${suffix}`;
    async function request(url, body) {
        const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST',
            headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.msg || data.error?.message || 'The request failed. Please retry.');
        return data;
    }
    function status(text, error = false) {
        $('studio-status').textContent = text;
        $('studio-status').classList.toggle('studio-error', error);
    }
    async function action(button, work) {
        button.disabled = true;
        try { await work(); } catch (e) { status(e.message, true); }
        finally { button.disabled = false; }
    }
    function saveFile(blob, name) {
        const url = URL.createObjectURL(blob), link = document.createElement('a');
        link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
    async function download(file, selectedClass) {
        const response = await fetch(`/api/teaching-studio/classes/${selectedClass}/resources/${file.id}/download`, { headers: { Authorization: `Bearer ${token()}` } });
        if (!response.ok) throw new Error('File is unavailable or you no longer have access.');
        saveFile(await response.blob(), file.name);
    }
    window.loadTeachingStudio = async () => {
        const generation = ++loading;
        status('Loading your classrooms…');
        $('studio-body').hidden = true;
        try {
            const data = await request('/api/teacher/classes');
            if (generation !== loading) return;
            const classes = data.classes.filter(c => c.status === 'active');
            $('studio-class').innerHTML = '<option value="">Choose a classroom</option>' + classes.map(c => `<option value="${c.id}">${esc(c.name)} · ${esc(c.subject)}</option>`).join('');
            if (!classes.length) { status('Create a classroom in My Classes to begin.'); return; }
            if (!classes.some(c => String(c.id) === classId)) classId = String(classes[0].id);
            $('studio-class').value = classId;
            await refresh();
        } catch (e) { status(e.message, true); }
    };
    async function refresh() {
        if (!classId) { $('studio-body').hidden = true; return; }
        const selected = classId, generation = ++loading;
        status('Loading class activity…');
        $('studio-body').hidden = true;
        const data = await request(endpoint(''));
        if (generation !== loading || selected !== classId) return;
        current = data;
        $('studio-body').hidden = false;
        const impact = current.impact;
        $('studio-metrics').innerHTML = [ ['Enrolled learners', impact.enrolled], ['Awaiting homework review', current.homework.reduce((n,h) => n + Number(h.pending),0)], ['Completed worksheet attempts', impact.completedAttempts], ['Average worksheet score', impact.averageScore == null ? 'Not recorded' : impact.averageScore + '%'] ].map(([label,value]) => `<article><strong>${value}</strong><span>${label}</span></article>`).join('');
        $('studio-today').innerHTML = current.homework.length ? current.homework.map(h => `<li><strong>${esc(h.title)}</strong><span>${h.due_date ? 'Due ' + esc(h.due_date) : 'No due date'} · ${Number(h.pending)} awaiting review</span></li>`).join('') : '<li>No homework yet. Create an assignment in Homework Manager.</li>';
        $('studio-resources').innerHTML = current.resources.length ? current.resources.map(f => `<li><div><strong>${esc(f.name)}</strong><span>${(f.bytes / 1024).toFixed(1)} KB · ${f.readable ? 'Text available to AI (first 24,000 characters)' : 'Attachment only — paste text to use with AI'} · ${f.shared ? 'Shared with class' : 'Private to teachers'}</span></div><div class="studio-actions"><button type="button" data-download="${f.id}">Download</button><button type="button" data-share="${f.id}">${f.shared ? 'Make private' : 'Share with class'}</button></div></li>`).join('') : '<li>Upload the first teaching resource for this class.</li>';
        $('studio-source').innerHTML = '<option value="">Use the topic and instructions below</option>' + current.resources.filter(f => f.readable).map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
        $('studio-drafts').innerHTML = current.drafts.length ? current.drafts.map(d => `<details class="studio-draft"><summary>${esc(d.title)} · ${esc(d.kind)} · ${d.published_note ? 'Published' : 'Private draft'}</summary><label for="draft-${d.id}">Review and edit before sharing</label><textarea id="draft-${d.id}" rows="14" maxlength="30000">${esc(edits.get(d.id) ?? d.content)}</textarea><div class="studio-actions"><button data-save="${d.id}">Save edits</button><button data-export="${d.id}">Download text</button>${d.kind !== 'parent' && !d.published_note ? `<button data-publish="${d.id}">Approve and publish to class notes</button>` : ''}</div>${d.kind === 'parent' ? '<p>Private parent draft. Verify the facts and guardian identity before sharing outside this app.</p>' : ''}</details>`).join('') : '<p>Your generated drafts will appear here. Nothing is published automatically.</p>';
        renderAttendance();
        status('Classroom ready. Uploads start private; AI drafts require your review.');
    }
    function renderAttendance() {
        const day = $('studio-day').value;
        $('studio-roster').innerHTML = current.students.length ? current.students.map(s => {
            const record = current.attendance.find(a => a.student_id === s.id && a.day === day);
            return `<label class="studio-attendance-row">${esc(s.username)}<select data-student="${s.id}" aria-label="Attendance for ${esc(s.username)}"><option value="">Not marked</option>${['present','absent','excused'].map(v => `<option value="${v}" ${record?.status === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>`;
        }).join('') : '<p>No active students enrolled yet.</p>';
        $('studio-attendance-save').disabled = !current.students.length;
    }
    $('studio-class').addEventListener('change', async event => {
        classId = event.target.value; current = null;
        try { await refresh(); } catch (e) { status(e.message,true); }
    });
    $('studio-upload').addEventListener('submit', event => {
        event.preventDefault();
        action($('studio-upload-submit'), async () => {
            const files = Array.from($('studio-files').files);
            if (!files.length) throw new Error('Choose at least one file.');
            if (files.some(f => !f.size || f.size > 6 * 1024 * 1024)) throw new Error('Each file must be nonempty and no larger than 6 MB.');
            const target = endpoint('/resources');
            let completed = 0;
            try {
                for (const file of files) {
                    status(`Uploading ${completed + 1} of ${files.length}: ${file.name}`);
                    const data = await new Promise((resolve,reject) => {
                        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]);
                        reader.onerror = () => reject(new Error('Could not read ' + file.name)); reader.readAsDataURL(file);
                    });
                    await request(target, { name: file.name, data }); completed++;
                }
                $('studio-files').value = ''; await refresh(); status(`${completed} file(s) uploaded privately.`);
            } catch (e) { await refresh(); throw new Error(`${completed} file(s) uploaded. ${e.message}`); }
        });
    });
    $('studio-generate').addEventListener('submit', event => {
        event.preventDefault();
        action($('studio-generate-submit'), async () => {
            status('Preparing your draft. You will review it before publication…');
            await request(endpoint('/drafts/generate'), { kind: $('studio-kind').value, title: $('studio-title').value,
                instructions: $('studio-instructions').value, resourceId: $('studio-source').value || null });
            await refresh(); $('studio-drafts').scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    });
    $('studio-day').value = new Date().toLocaleDateString('en-CA');
    $('studio-day').max = new Date().toISOString().slice(0,10);
    $('studio-day').addEventListener('change', () => current && renderAttendance());
    $('studio-attendance-save').addEventListener('click', event => action(event.target, async () => {
        const entries = Array.from($('studio-roster').querySelectorAll('select')).map(s => ({ studentId: Number(s.dataset.student), status: s.value }));
        if (entries.some(e => !e.status)) throw new Error('Mark each student before saving.');
        await request(endpoint('/attendance'), { day: $('studio-day').value, entries });
        await refresh(); status('Attendance saved.');
    }));
    $('studio-impact').addEventListener('click', () => {
        if (!current) return;
        saveFile(new Blob([JSON.stringify({ generatedAt: new Date().toISOString(), ...current.impact },null,2)], { type:'application/json' }), 'class-impact.json');
    });
    $('studio-drafts').addEventListener('input', event => {
        if (event.target.matches('textarea')) edits.set(event.target.id.slice(6), event.target.value);
    });
    $('studio-body').addEventListener('click', event => {
        const button = event.target.closest('button');
        if (!button) return;
        const { download: id, share, save, publish, export: exportId } = button.dataset;
        if (id) action(button, () => download(current.resources.find(f => f.id === id), classId));
        if (share) action(button, async () => { const file = current.resources.find(f => f.id === share); await request(endpoint(`/resources/${share}/share`),{shared: !file.shared}); await refresh(); });
        if (save || publish) action(button, async () => {
            const draft = current.drafts.find(d => d.id === (save || publish));
            await request(endpoint(`/drafts/${draft.id}`), { content: $('draft-' + draft.id).value, version: draft.version, publish: !!publish });
            edits.delete(draft.id);
            await refresh(); status(publish ? 'Approved material published in class notes.' : 'Draft saved.');
        });
        if (exportId) { const draft = current.drafts.find(d => d.id === exportId); saveFile(new Blob([$('draft-' + draft.id).value],{type:'text/plain'}), 'teaching-draft.txt'); }
    });
    window.addEventListener('beforeunload', event => { if (edits.size) { event.preventDefault(); event.returnValue = ''; } });
    window.loadSharedTeachingResources = async () => {
        const area = $('student-teaching-resources');
        area.textContent = 'Loading shared resources…';
        try {
            const { resources } = await request('/api/teaching-studio/student/resources');
            area.innerHTML = resources.length ? '<h3>Resources from your teachers</h3>' + resources.map(f => `<button type="button" data-file="${f.id}">${esc(f.name)} · ${esc(f.class_name)} · Download</button>`).join('') : '<p>No files shared with your classes yet.</p>';
            area.querySelectorAll('button').forEach(button => button.addEventListener('click', async () => {
                button.disabled = true;
                try { const f = resources.find(f => f.id === button.dataset.file); await download(f, f.class_id); }
                catch (e) { area.textContent = e.message; }
                finally { button.disabled = false; }
            }));
        } catch(e) { area.textContent = e.message; }
    };
    if (document.getElementById('teacher-tab-studio').classList.contains('active')) window.loadTeachingStudio();
    if (document.getElementById('classroom').classList.contains('active') && token()) window.loadSharedTeachingResources();
})();
