/* NCERT textbook answers. Source text stays server-side; the client only
   ever sees the answer and its page citations.

   The student's class and subject already live in the study profile bar, so
   the tutor uses those and asks the server to find the chapter — five
   dropdowns of book-and-chapter picking was a wall in front of the thing
   they came to do. Pinning a specific chapter is still available for when
   they are revising one. */
window.ncertTutor = (() => {
    let profile = { grade: '', subject: '' };   // from saved memory facts
    let pinned = null;                          // optional { bookId, chapterId }
    let panel = null;

    async function request(token, path, body) {
        const response = await fetch(`/api/ncert${path}`, {
            method: body ? 'POST' : 'GET',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            ...(body ? { body: JSON.stringify(body) } : {})
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.msg || 'NCERT library is unavailable. Please try again.');
        return data;
    }

    // The bar stores the class as a bare number ("9"); the corpus keys on
    // the full DIKSHA grade label.
    function gradeLabel(value) {
        return value ? (/^\d+$/.test(String(value)) ? `Class ${value}` : String(value)) : '';
    }

    async function loadProfile(token) {
        try {
            // `api` is a top-level const in api.js — a lexical global, not a
            // window property. api.js is loaded first, so the binding exists.
            const data = await api.getAiMemory(token);
            const facts = (data && data.facts) || [];
            const get = k => (facts.find(f => f.mem_key === k) || {}).mem_value || '';
            profile = { grade: gradeLabel(get('class')), subject: get('subject') };
        } catch { profile = { grade: '', subject: '' }; }
    }

    async function mount(container, token) {
        pinned = null;
        const current = document.createElement('fieldset');
        panel = current;
        current.className = 'ncert-panel';
        const legend = document.createElement('legend');
        legend.textContent = 'NCERT textbook answers';
        const status = document.createElement('p');
        status.setAttribute('role', 'status');
        status.className = 'ncert-status';
        status.textContent = 'Checking your study profile…';
        current.append(legend, status);

        // Optional chapter pinning, collapsed by default.
        const details = document.createElement('details');
        details.className = 'ncert-pin';
        const summary = document.createElement('summary');
        summary.textContent = 'Pin a specific chapter (optional)';
        details.append(summary);
        const selects = {};
        for (const name of ['Book', 'Chapter']) {
            const label = document.createElement('label');
            label.textContent = name;
            const select = document.createElement('select');
            select.setAttribute('aria-label', `NCERT ${name}`);
            label.append(select); details.append(label); selects[name] = select;
        }
        current.append(details);
        container.prepend(current);

        await loadProfile(token);
        if (panel !== current || !current.isConnected) return;

        if (!profile.grade) {
            status.innerHTML = 'Set your class in the study bar above and answers will come straight from your NCERT textbooks, with page references.';
            details.hidden = true;
            return;
        }
        status.textContent = `Answers will use your ${[profile.grade, profile.subject].filter(Boolean).join(' ')} NCERT textbooks, with page references.`;

        // Populate the pinning controls from the student's own shelf only.
        try {
            const { books } = await request(token, '/books');
            if (panel !== current || !current.isConnected) return;
            const mine = books.filter(b => (b.grades || []).includes(profile.grade) &&
                (!profile.subject || (b.subjects || []).includes(profile.subject)));
            const fill = (name, entries, placeholder) => {
                selects[name].replaceChildren(new Option(placeholder, ''));
                for (const e of entries) selects[name].append(new Option(e.label, e.value));
                selects[name].disabled = !entries.length;
            };
            fill('Book', mine.map(b => ({ value: b.id, label: `${b.name} · ${b.year || 'edition not listed'}` })), 'Search all my textbooks');
            fill('Chapter', [], 'Whole book');
            selects.Book.addEventListener('change', () => {
                const book = mine.find(b => b.id === selects.Book.value);
                fill('Chapter', (book?.chapters || [])
                    .filter(c => c.status === 'ready')
                    .map(c => ({ value: c.id, label: c.name })), 'Whole book');
                pinned = null;
            });
            selects.Chapter.addEventListener('change', () => {
                pinned = selects.Book.value && selects.Chapter.value
                    ? { bookId: selects.Book.value, chapterId: selects.Chapter.value } : null;
                status.textContent = pinned
                    ? 'Answers will use only the pinned chapter.'
                    : `Answers will use your ${[profile.grade, profile.subject].filter(Boolean).join(' ')} NCERT textbooks, with page references.`;
            });
        } catch { details.hidden = true; }
    }

    async function ask(token, question) {
        if (pinned) return request(token, '/ask', { ...pinned, question });
        if (!profile.grade) throw new Error('Set your class in the study bar so the right textbook can be used.');
        return request(token, '/ask-auto', { grade: profile.grade, subject: profile.subject || undefined, question });
    }

    function showSources(container, sources = [], matched) {
        if (matched) {
            const found = document.createElement('p');
            found.className = 'ncert-matched';
            found.textContent = `From ${matched}`;
            container.append(found);
        }
        if (!sources.length) return;
        const list = document.createElement('ul');
        list.className = 'ncert-sources';
        const seen = new Set();
        for (const source of sources) {
            const key = `${source.url}#${source.page}`;
            if (seen.has(key)) continue; seen.add(key);
            const item = document.createElement('li');
            if (source.url) {
                const link = document.createElement('a');
                link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
                link.textContent = `${source.book} — ${source.chapter}, PDF page ${source.page}`;
                item.append(link);
            } else {
                item.textContent = `${source.book} — ${source.chapter}, page ${source.page}`;
            }
            list.append(item);
        }
        container.append(list);
    }

    // The tutor is textbook-backed whenever we know the class; without one
    // the caller falls back to the general chat tutor.
    return { mount, ask, showSources, active: () => Boolean(pinned || profile.grade) };
})();
