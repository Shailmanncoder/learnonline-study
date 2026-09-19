/* Learning workspace: all saved state belongs to the authenticated account. */
(() => {
    const root = document.getElementById('learning-hub');
    let activeTab = 'today';
    let requestVersion = 0;
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
    const date = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
    async function request(path, body, method) {
        const r = await fetch('/api/' + path, { method: method || (body ? 'POST' : 'GET'), headers: { Authorization: `Bearer ${authToken}`, 'Content-Type':'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
        const data = await r.json();
        if (!r.ok) throw new Error(data.msg || data.error?.message || 'Please try again.');
        return data;
    }
    function navigate(target, topic) {
        document.querySelector(`.nav-item[data-target="${target}"]`)?.click();
        if (topic) document.getElementById('qz-topic').value = topic;
    }
    function message(text) { root.querySelector('.lh-status').textContent = text; document.getElementById('teacher-review-status').textContent = text; }
    async function load() {
        if (!authToken) return;
        const version = ++requestVersion;
        const accountToken = authToken;
        const content = root.querySelector('.lh-content');
        content.innerHTML = '<p role="status">Loading your learning workspace…</p>';
        root.querySelectorAll('[data-lh-tab]').forEach(b => { b.classList.toggle('active', b.dataset.lhTab === activeTab); b.setAttribute('aria-pressed', String(b.dataset.lhTab === activeTab)); });
        try {
            const data = await request('learning/dashboard?day=' + date());
            if (version !== requestVersion || authToken !== accountToken) return;
            root.querySelector('.lh-stats').innerHTML = [[data.stats.dueMistakes,'Mistakes due'],[data.stats.dueCards,'Cards due'],[data.stats.activeGoals,'Active goals']].map(([n,t]) => `<div><strong>${n}</strong><span>${t}</span></div>`).join('');
            if (activeTab === 'today') renderToday(content, data);
            if (activeTab === 'goals') renderGoals(content, data);
            if (activeTab === 'progress') renderProgress(content, data);
            if (activeTab === 'mistakes') await renderMistakes(content, version, accountToken);
            if (activeTab === 'reviews') await renderReviews(content, version, accountToken);
        } catch (e) { if (version === requestVersion) { content.innerHTML = '<p>Could not load your workspace. Use Refresh to try again.</p>'; message(e.message); } }
    }
    function renderToday(el, data) {
        el.innerHTML = `<div class="lh-heading"><div><h2>Your next steps</h2><p>Built from due reviews, class homework, and your exam goals. Check-ins record activity, not mastery.</p></div><span class="lh-pill">${data.tasks.filter(t => t.completed).length}/${data.tasks.length} checked off</span></div><div class="lh-grid">${data.tasks.map((t,i) => `<article class="lh-card ${t.completed ? 'lh-done' : ''}"><span class="lh-kicker">${t.minutes} MIN · ${esc(t.action.replaceAll('-',' '))}</span><h3>${esc(t.title)}</h3><p>${esc(t.reason)}</p><div class="lh-actions"><button class="btn btn-primary" data-task="${i}">Start</button><label><input type="checkbox" data-check="${i}" ${t.completed ? 'checked' : ''}> Done today</label></div></article>`).join('')}</div>`;
        el.querySelectorAll('[data-task]').forEach(b => b.onclick = () => { const t = data.tasks[Number(b.dataset.task)]; if(t.action === 'mistakes') { activeTab = 'mistakes'; load(); } else navigate(t.action, t.topic); });
        el.querySelectorAll('[data-check]').forEach(b => b.onchange = async () => { b.disabled = true; try { await request('learning/checkins', { day: data.day, taskKey: data.tasks[Number(b.dataset.check)].key, completed: b.checked }); await load(); } catch(e) { b.checked = !b.checked; b.disabled = false; message(e.message); } });
    }
    function renderGoals(el, data) {
        el.innerHTML = `<div class="lh-heading"><div><h2>Make room for your goals</h2><p>Save an exam and syllabus. Your daily plan brings the next practice topic to you.</p></div></div><div class="lh-grid"><form class="lh-card lh-form" id="lh-goal-form"><h3>Add an exam goal</h3><label>Exam or goal<input name="title" required maxlength="160" placeholder="September science assessment"></label><label>Exam date<input name="examDate" type="date" min="${date()}" required></label><label>Daily practice minutes<input name="minutes" type="number" min="10" max="240" value="25" required></label><label>Topics, one per line<textarea name="topics" rows="4" required placeholder="Photosynthesis&#10;Cell structure"></textarea></label><button class="btn btn-primary">Save goal</button></form><div>${data.goals.length ? data.goals.map(g => `<article class="lh-card"><span class="lh-kicker">${esc(g.exam_date)} · ${g.minutes} MIN / DAY</span><h3>${esc(g.title)}</h3><p>${g.topics.map(esc).join(' · ')}</p><button class="btn btn-secondary" data-delete="${esc(g.id)}">Remove goal</button></article>`).join('') : '<article class="lh-card"><h3>A clear target, a smaller next step</h3><p>Your goals are saved to your account. Start with the next exam or topic you want to feel confident about.</p></article>'}</div></div>`;
        el.querySelector('form').onsubmit = async e => { e.preventDefault(); const form=e.currentTarget, button=form.querySelector('button'), f = new FormData(form); button.disabled=true; try { await request('learning/goals', { title:f.get('title'), examDate:f.get('examDate'), minutes:Number(f.get('minutes')), topics:f.get('topics').split('\n') }); message('Goal saved. Your daily plan has been updated.'); await load(); } catch(err) {message(err.message);button.disabled=false;} };
        el.querySelectorAll('[data-delete]').forEach(b => b.onclick = async () => { b.disabled=true; try {await request('learning/goals/' + b.dataset.delete, null, 'DELETE'); await load();} catch(e){message(e.message);b.disabled=false;} });
    }
    async function renderMistakes(el, version, accountToken) {
        const { mistakes } = await request('learning/mistakes');
        if(version !== requestVersion || accountToken !== authToken) return;
        const now = new Date().toISOString();
        el.innerHTML = `<div class="lh-heading"><div><h2>Turn mistakes into understanding</h2><p>Choose an answer before seeing the explanation. Three successful spaced reviews retire a question. Quiz questions are AI-written; report questionable answers to your teacher.</p></div></div><div class="lh-grid">${mistakes.length ? mistakes.map((m,i) => `<article class="lh-card"><span class="lh-kicker">${esc(m.topic)} · ${m.resolved ? 'REVIEWED' : m.due_at <= now ? 'DUE NOW' : 'NEXT: ' + esc(new Date(m.due_at).toLocaleString())}</span><h3>${esc(m.question)}</h3><p>${m.successes}/3 successful spaced reviews</p><div class="lh-options">${m.options.map((o,j) => `<button data-mistake="${i}" data-answer="${j}" ${m.resolved || m.due_at > now ? 'disabled' : ''}>${String.fromCharCode(65+j)}. ${esc(o)}</button>`).join('')}</div><p class="lh-feedback" role="status"></p></article>`).join('') : '<article class="lh-card"><h3>A fresh start</h3><p>Missed questions from your next practice quiz will appear here automatically.</p><button class="btn btn-primary" id="lh-first-quiz">Take a quiz</button></article>'}</div>`;
        el.querySelector('#lh-first-quiz')?.addEventListener('click', () => navigate('quiz-generator'));
        el.querySelectorAll('[data-mistake]').forEach(b => b.onclick = async () => {
            const card=b.closest('article'), buttons=card.querySelectorAll('button'), m=mistakes[Number(b.dataset.mistake)]; buttons.forEach(x=>x.disabled=true);
            try { const r=await request('learning/mistakes/'+m.id+'/review', {answer:Number(b.dataset.answer)}); card.querySelector('.lh-kicker').textContent = m.topic + (r.resolved ? ' · REVIEWED' : ' · NEXT: ' + new Date(r.dueAt).toLocaleString()); card.querySelector('h3 + p').textContent = `${r.correct ? m.successes + 1 : 0}/3 successful spaced reviews`; card.querySelector('.lh-feedback').textContent = `${r.correct ? 'Correct.' : 'Keep practising. Correct answer: ' + m.options[r.correctIndex] + '.'} ${r.explanation || ''} ${r.resolved ? 'Three spaced successes — question retired.' : 'Next review: ' + new Date(r.dueAt).toLocaleString()}`; }
            catch(e){ message(e.message); buttons.forEach(x=>x.disabled=false); }
        });
    }
    function renderProgress(el, data) {
        el.innerHTML = `<div class="lh-heading"><div><h2>Evidence of your progress</h2><p>Accuracy across your latest 40 quiz attempts. It is a practice signal, not proof of mastery. Earlier attempts may predate server-verified grading.</p></div></div><div class="lh-grid">${data.topics.length ? data.topics.map(t=>`<article class="lh-card"><h3>${esc(t.topic)}</h3><strong class="lh-score">${t.accuracy}%</strong><progress value="${t.accuracy}" max="100" aria-label="${esc(t.topic)} accuracy"></progress><p>${t.score}/${t.total} correct · ${t.attempts} attempt${t.attempts===1?'':'s'}</p><button class="btn btn-secondary" data-practice="${esc(t.topic)}">Practise this topic</button></article>`).join('') : '<article class="lh-card"><h3>No quiz evidence yet</h3><p>Take a practice quiz to start building your picture.</p></article>'}</div><button class="btn btn-secondary" id="lh-export">Download my learning history</button>`;
        el.querySelectorAll('[data-practice]').forEach(b=>b.onclick=()=>navigate('quiz-generator', b.dataset.practice));
        el.querySelector('#lh-export').onclick=async()=>{try {const data=await request('learning/export');const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='studyhub-learning-history.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){message(e.message);}};
    }
    async function renderReviews(el, version, accountToken) {
        const { attempts } = await request('review/queue');
        if(version !== requestVersion || accountToken !== authToken) return;
        el.innerHTML = `<div class="lh-heading"><div><h2>Teacher review queue</h2><p>Finalize uncertain marks with your own feedback. Only worksheets from your assigned classes appear here.</p></div></div>${attempts.length ? attempts.map((a,i)=>`<form class="lh-card lh-form" data-review="${i}"><span class="lh-kicker">${esc(a.className)} · ${esc(a.student)}</span><h3>${esc(a.title)}</h3>${a.breakdown.filter(r=>r.needsReview).map((r,j)=>{const q=a.questions.find(q=>String(q.id)===String(r.id));return `<fieldset><legend>${esc(q?.question || 'Question '+r.id)}</legend><p>Student answer: ${esc(r.answer || '(blank)')}</p><p>Expected: ${esc(q?.correct_answer || '(not provided)')}</p><label>Marks out of ${r.marks}<input name="marks-${j}" type="number" min="0" max="${r.marks}" step="0.5" value="${r.awarded}" required></label><label>Feedback<textarea name="feedback-${j}" maxlength="2000" required></textarea></label></fieldset>`;}).join('')}<button class="btn btn-primary">Finalize marks and notify student</button></form>`).join('') : '<article class="lh-card"><h3>No answers awaiting review</h3><p>Uncertain worksheet grades will appear here when students submit them.</p></article>'}`;
        el.querySelectorAll('[data-review]').forEach(form=>form.onsubmit=async e=>{e.preventDefault();const button=form.querySelector('button');button.disabled=true;const a=attempts[Number(form.dataset.review)],f=new FormData(form);try{await request('review/'+a.id,{grades:a.breakdown.filter(r=>r.needsReview).map((r,j)=>({id:r.id,awarded:Number(f.get('marks-'+j)),feedback:f.get('feedback-'+j)}))});message('Review saved. The student has been notified.');if(el.id === 'teacher-review-content') await window.loadTeacherReviews(); else await load();}catch(e){message(e.message);button.disabled=false;}});
    }
    root.querySelectorAll('[data-lh-tab]').forEach(b=>b.onclick=()=>{activeTab=b.dataset.lhTab;message('');load();});
    root.querySelector('[data-lh-refresh]').onclick=load;
    window.loadLearningWorkspace = load;
    window.loadTeacherReviews = async () => {
        const el = document.getElementById('teacher-review-content');
        el.innerHTML = '<p>Loading review queue…</p>';
        try { await renderReviews(el, ++requestVersion, authToken); }
        catch(e) { el.textContent = e.message; }
    };
    if(document.getElementById('teacher-tab-reviews').classList.contains('active')) window.loadTeacherReviews();
    window.addEventListener('popstate',()=>{if(root.classList.contains('active'))load();});
    if(root.classList.contains('active'))load();
})();
