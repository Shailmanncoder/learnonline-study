'use strict';
const $ = id => document.getElementById(id);
const escapeText = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const API_BASE = '/api';

let state = {
  classes: [], catalog: {}, chapters: [], classLevel: null, subject: null, chapter: null,
  tool: 'tutor', started: false, messages: [], card: 0, flipped: false, quizAnswer: null, loading: false
};

async function fetchCatalog() {
  try {
    state.loading = true;
    const res = await fetch(`${API_BASE}/ncert/catalog`);
    if (!res.ok) throw new Error('Failed to fetch catalog');
    const data = await res.json();
    state.classes = data.classes || [];
    state.catalog = data.catalog || {};
    state.classLevel = state.classes[5] || state.classes[0];
    renderClasses();
    renderBooks();
    announce('NCERT catalog loaded');
  } catch (err) {
    console.error('Catalog fetch error:', err);
    announce('Could not load NCERT catalog. Using sample content.');
  } finally {
    state.loading = false;
  }
}

async function fetchChapters() {
  if (!state.classLevel || !state.subject) return;
  try {
    state.loading = true;
    const res = await fetch(`${API_BASE}/ncert/study/${state.classLevel}/${encodeURIComponent(state.subject)}`);
    if (!res.ok) throw new Error('Failed to fetch chapters');
    const data = await res.json();
    state.chapters = data.chapters || [];
    state.chapter = null;
    renderChapters();
  } catch (err) {
    console.error('Chapters fetch error:', err);
    announce('Could not load chapters');
  } finally {
    state.loading = false;
  }
}

function announce(text) { $('announce').textContent = text; }

function resetChapter() {
  Object.assign(state, { tool: 'tutor', started: false, messages: [], card: 0, flipped: false, quizAnswer: null });
}

function renderClasses() {
  const classes = state.classes.length ? state.classes : Array.from({length:12}, (_,i) => String(i+1));
  $('classes').innerHTML = classes.map(c =>
    `<button class="class-choice ${state.classLevel === c ? 'selected' : ''}" data-class="${c}" aria-pressed="${state.classLevel === c}" aria-label="Class ${c}"><small>CLASS</small><strong>${c}</strong></button>`
  ).join('');
  $('stage-label').textContent = state.classLevel ? `Class ${state.classLevel}` : 'Select a class';
  $('classes').querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      state.classLevel = b.dataset.class;
      state.subject = null;
      state.chapter = null;
      resetChapter();
      renderBooks();
      fetchChapters();
      announce(`Class ${state.classLevel} selected`);
    };
  });
}

function renderBooks() {
  const books = state.catalog[state.classLevel] || [];
  $('book-count').textContent = `${books.length} subject${books.length !== 1 ? 's' : ''}`;
  $('books').innerHTML = books.map((subject, idx) => {
    const colors = ['#e9efff', '#e6f3f0', '#fff0e3'];
    return `<button class="book ${state.subject === subject ? 'selected' : ''}" data-subject="${subject}" aria-pressed="${state.subject === subject}" aria-label="${subject}">
      <div class="book-cover" style="--cover:${colors[idx % 3]}"><small>CLASS ${state.classLevel}</small><span class="subject-icon" aria-hidden="true">${subject[0]}</span></div>
      <div class="book-bottom"><div><h3>${subject}</h3><p>NCERT Edition</p></div><span class="book-check" aria-hidden="true">✓</span></div></button>`;
  }).join('');
  $('books').querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      state.subject = b.dataset.subject;
      state.chapter = null;
      resetChapter();
      fetchChapters();
      announce(`${state.subject} selected`);
    };
  });
}

function renderChapters() {
  $('chapter-count').textContent = `${state.chapters.length} chapter${state.chapters.length !== 1 ? 's' : ''}`;
  $('chapters').innerHTML = state.chapters.map((ch, i) =>
    `<button class="chapter ${state.chapter?.id === ch.id ? 'selected' : ''}" data-chapter="${ch.id}" aria-pressed="${state.chapter?.id === ch.id}">
      <span class="chapter-num">${String(i+1).padStart(2,'0')}</span>
      <div><h3>${ch.title}</h3><p>NCERT textbook</p></div>
      <span class="chapter-arrow" aria-hidden="true">↗</span>
    </button>`
  ).join('');
  $('chapters').querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      const chId = b.dataset.chapter;
      state.chapter = state.chapters.find(ch => String(ch.id) === chId);
      resetChapter();
      renderChapters();
      renderStudy();
      announce(`${state.chapter?.title} selected`);
    };
  });
}

function renderStudy() {
  const title = state.chapter?.title || 'Select a chapter';
  $('study-context').innerHTML = `<h2 id="study-heading">${title}</h2>
    <div class="context-meta">Class ${state.classLevel} <span aria-hidden="true">/</span> ${state.subject}<br>NCERT textbook</div>`;
  $('tool-tabs').querySelectorAll('button').forEach(b => {
    b.classList.toggle('active', b.dataset.tool === state.tool);
    b.setAttribute('aria-pressed', String(b.dataset.tool === state.tool));
    b.onclick = () => { state.tool = b.dataset.tool; renderStudy(); };
  });
  if (state.tool === 'tutor') renderTutor();
  if (state.tool === 'notes') renderNotes();
  if (state.tool === 'cards') renderCards();
  if (state.tool === 'quiz') renderQuiz();
}

function renderTutor() {
  const el = $('tool-content');
  if (!state.started) {
    el.innerHTML = `<div class="tutor-start"><div class="tutor-icon" aria-hidden="true">✦</div>
      <h3>Ask about this chapter.</h3>
      <p>Get explanations, worked examples, and practice questions based on the NCERT text.</p>
      <button class="primary wide" id="start-tutor">Open tutor →</button>
      <p class="disclaimer">Tutor uses NCERT textbooks when available. Responses are grounded in the chapter.</p></div>`;
    $('start-tutor').onclick = () => {
      state.started = true;
      state.messages = [{ role: 'tutor', text: `I'm ready to help with ${state.chapter?.title || 'this chapter'}. What would you like to know?` }];
      renderTutor();
      $('tutor-question').focus();
    };
    return;
  }
  el.innerHTML = `<div class="chat-log" id="chat-log" role="log" aria-label="Tutor conversation">
    ${state.messages.map(m => `<div class="bubble ${m.role === 'user' ? 'user' : ''}"><small>${m.role === 'user' ? 'You' : 'Tutor'}</small>${escapeText(m.text)}</div>`).join('')}
    </div><div class="prompts"><button data-prompt="Explain the main idea">Explain</button><button data-prompt="Show a worked example">Example</button><button data-prompt="Practice question">Practice</button></div>
    <form class="chat-form" id="chat-form"><label class="sr-only" for="tutor-question">Ask about this chapter</label>
    <input id="tutor-question" maxlength="500" placeholder="Ask about this chapter…" required><button class="primary" aria-label="Send question">↑</button></form></div>`;
  el.querySelectorAll('[data-prompt]').forEach(b => b.onclick = () => send(b.dataset.prompt));
  $('chat-form').onsubmit = e => { e.preventDefault(); send($('tutor-question').value); };
  $('chat-log').scrollTop = $('chat-log').scrollHeight;
}

async function send(text) {
  text = text.trim();
  if (!text) return;
  state.messages.push({ role: 'user', text });

  try {
    const res = await fetch(`${API_BASE}/ncert/ask-auto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grade: state.classLevel,
        subject: state.subject,
        question: text
      })
    });

    const data = await res.json();
    const reply = data.answer || data.msg || 'Unable to generate a response. Try another question.';
    state.messages.push({ role: 'tutor', text: reply });
  } catch (err) {
    console.error('Tutor error:', err);
    state.messages.push({ role: 'tutor', text: 'Connection error. Please try again.' });
  }

  state.messages = state.messages.slice(-20);
  renderTutor();
  $('tutor-question').focus();
}

function renderNotes() {
  $('tool-content').innerHTML = `<div class="tool-heading"><h3>Chapter overview</h3><span>From NCERT</span></div>
    <p class="tool-copy">Detailed chapter notes would appear here from the NCERT textbook.</p>
    <div class="quiz-feedback"><strong>Try asking the tutor</strong>
    <p>"Explain the main ideas" or "Show me an example" to explore this chapter.</p></div>
    <p class="disclaimer">Switch to the Tutor tool to ask questions about this chapter.</p>`;
}

function renderCards() {
  if (!state.chapter || state.chapters.length === 0) {
    $('tool-content').innerHTML = '<p class="disclaimer">Select a chapter to view flashcards.</p>';
    return;
  }
  const cards = [
    { q: 'What is the main topic of this chapter?', a: state.chapter.title },
    { q: 'Explain the key concepts in your own words.', a: 'Ask the tutor for a detailed explanation.' },
    { q: 'Give an example from this chapter.', a: 'Ask the tutor for worked examples.' }
  ];
  state.card = Math.min(state.card, cards.length - 1);
  const item = cards[state.card];
  $('tool-content').innerHTML = `<div class="tool-heading"><h3>Recall before you reveal</h3><span>${state.card + 1} / ${cards.length}</span></div>
    <button class="flashcard" id="flashcard" aria-label="${state.flipped ? 'Show question' : 'Reveal answer'}">
    <small>${state.flipped ? 'ANSWER' : 'QUESTION'}</small>${escapeText(state.flipped ? item.a : item.q)}</button>
    <p class="disclaimer">Tap the card to ${state.flipped ? 'see the question' : 'reveal the answer'}.</p>
    <div class="card-controls"><button class="secondary" id="prev-card" ${state.card === 0 ? 'disabled' : ''}>← Previous</button>
    <button class="secondary" id="next-card" ${state.card === cards.length - 1 ? 'disabled' : ''}>Next →</button></div>`;
  $('flashcard').onclick = () => { state.flipped = !state.flipped; renderCards(); };
  $('prev-card').onclick = () => { state.card--; state.flipped = false; renderCards(); };
  $('next-card').onclick = () => { state.card++; state.flipped = false; renderCards(); };
}

function renderQuiz() {
  if (!state.chapter || state.chapters.length === 0) {
    $('tool-content').innerHTML = '<p class="disclaimer">Select a chapter to view quiz questions.</p>';
    return;
  }
  const questions = state.chapter.questions || [];
  if (questions.length === 0) {
    $('tool-content').innerHTML = '<p class="disclaimer">No quiz questions available for this chapter yet.</p>';
    return;
  }
  const q = questions[0];
  const answered = state.quizAnswer !== null;
  $('tool-content').innerHTML = `<div class="tool-heading"><h3>One quick check</h3><span>From NCERT</span></div>
    <p class="tool-copy">${q.question}</p><div class="quiz-options">${(q.options || []).map((o, i) =>
    `<button class="quiz-option ${answered ? (i === q.correctIndex ? 'correct' : i === state.quizAnswer ? 'wrong' : '') : ''}" data-answer="${i}" ${answered ? 'disabled' : ''}>${String.fromCharCode(65 + i)}. ${o}</button>`
  ).join('')}</div>${answered ? `<div class="quiz-feedback" role="status"><strong>${state.quizAnswer === q.correctIndex ? 'That\'s right.' : 'Not quite. Try again.'}</strong></div>
    <button class="secondary" id="retry-quiz" style="margin-top:15px">Try again</button>` : '<p class="disclaimer">Choose an answer to check it.</p>'}`;
  $('tool-content').querySelectorAll('[data-answer]').forEach(b => b.onclick = () => { state.quizAnswer = Number(b.dataset.answer); renderQuiz(); });
  if (answered) $('retry-quiz').onclick = () => { state.quizAnswer = null; renderQuiz(); };
}

function view(source) {
  $('library-view').hidden = source;
  $('sources-view').hidden = !source;
  $('library-nav').classList.toggle('active', !source);
  $('sources-nav').classList.toggle('active', source);
  $('library-nav').setAttribute('aria-current', source ? 'false' : 'page');
  $('sources-nav').setAttribute('aria-current', source ? 'page' : 'false');
  window.scrollTo({ top: 0, behavior: 'instant' });
}

$('library-nav').onclick = () => { location.hash = 'library'; };
$('sources-nav').onclick = $('source-footer').onclick = () => { location.hash = 'sources'; };
$('source-back').onclick = () => { location.hash = 'library'; };
window.addEventListener('hashchange', () => view(location.hash === '#sources'));

fetchCatalog();
view(location.hash === '#sources');
