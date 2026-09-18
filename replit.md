# AI Study Hub

An AI-powered learning platform where users can register/login and use various AI tools for studying.

## Architecture

- **Backend**: Node.js + Express (serves both API and frontend static files) on port 5000
- **Frontend**: Vanilla JS/HTML/CSS static files served by the backend
- **Database**: SQLite (file: `backend/database/studyhub.db`)
- **AI**: Google Gemini API (primary), Groq (fallback)

## Project Structure

```
backend/
  server.js          - Express server, serves API + static frontend
  config/db.js       - SQLite connection and schema initialization
  controllers/
    authController.js  - POST /api/auth/register, POST /api/auth/login
    userController.js  - Profile, XP, notes, leaderboard, account
    aiController.js    - POST /api/ai/generate, GET /api/ai/image
  middleware/auth.js   - JWT verification middleware
  database/
    studyhub.db        - SQLite database file
    schema.sql         - Reference schema (MySQL style, not used at runtime)

frontend/
  index.html        - Single-page app markup
  app.js            - Main client logic and UI
  api.js            - REST client (uses relative /api paths)
  data.js           - AI tool catalog and configs
  styles.css        - Base styling
  premium.css       - Design-token layer loaded after styles.css
                      (palette, elevation, radii, motion, responsive,
                      dark-mode corrections). Never edit tokens in
                      styles.css directly — change them here.
  premium.js        - Progressive UI layer: scroll-aware topbar,
                      mobile tab bar, drawer scroll-lock, landing reveals
```

## Routing

The app is a single page with client-side routes handled by
`handleAppRouting()` in `app.js`, kept in the URL via `syncUrl()`:

| Path | Restores |
|---|---|
| `/<section>` | a student-hub section (`/dashboard`, `/flashcards`, `/profile`, …) |
| `/tool/<id>` | a specific AI tool, opened after plan data loads |
| `/teacher/<tab>` | the Teacher Hub on a given tab |
| `/developer/<tab>` | the Developer Hub on a given tab |

Two rules keep refresh working:

1. **Every section id must appear in the `validSections` map.** A missing
   entry silently sends a refresh back to the dashboard.
2. **Asset URLs in `index.html` must be root-absolute** (`/app.js`, not
   `app.js`). On a nested route like `/tool/x`, a relative path resolves to
   `/tool/app.js`; the SPA fallback would answer with `index.html` and the
   browser would fail with `SyntaxError: Unexpected token '<'`. The server
   now 404s anything with an asset extension so this fails loudly.

## AI providers & model routing

Groq is the primary provider (`backend/controllers/aiController.js`). Instead
of one model for everything, `POST /api/ai/generate` accepts a `task` and
routes accordingly:

| `task` | Model | Use for |
|---|---|---|
| `fast` | `openai/gpt-oss-20b` | short casual turns (~1000 tok/s) |
| `general` *(default)* | `openai/gpt-oss-120b` | most work |
| `reasoning` | `openai/gpt-oss-120b` | hard math, step-by-step |
| `vision` | `qwen/qwen3.6-27b` | images (auto-selected when `images` is sent) |
| `longdoc` | `qwen/qwen3.6-27b` | 131K-context documents |
| `research` | `GROQ_RESEARCH_MODEL` or `openai/gpt-oss-120b` | see note below |

Request body also accepts `images` (up to 3 URLs / data URIs — presence of
these forces the vision model) and `wantReasoning` (returns the model's
reasoning in a separate `reasoning` field). The response echoes the `model`
that actually served it.

Three things worth knowing:

1. **Qwen leaks raw `<think>` blocks into `content`** unless
   `reasoning_format` is set. `groqReasoningParams()` sets it per model
   family, and `stripThinkBlocks()` is a backstop — do not remove either.
2. **The on-demand tier caps total tokens per minute at 8000**, and
   `max_tokens` counts toward it. Reasoning requests use 6000; anything
   larger 413s. The handler backs off to a smaller budget, then to the fast
   model, before failing.
3. **`groq/compound` is the only model that can really run web search**, but
   it dispatches to a Llama backend that is rate-limited to unusable on the
   free tier. Set `GROQ_RESEARCH_MODEL=groq/compound` after upgrading.

## Assessment loop (grading → analysis → reteach)

The core teacher workflow, and the reason per-question data is stored:

1. **Grading** — `gradeAttempt()` in `classroomController.js`. Objective
   questions match exactly; subjective answers go to the model with the
   expected answer and a mark cap. A stingy keyword-overlap heuristic covers
   the case where the model is unreachable, and flags the attempt
   `needsReview`. The result is written to `worksheet_attempts.breakdown`
   as one row per question.

   *This replaced a stub that awarded 70% of the marks to any answer longer
   than 10 characters — "asdfghjkl" used to pass.*

2. **Item analysis** — `GET /api/teacher/worksheets/:id/analysis` returns
   per-question correct rates, average marks, and clustered wrong answers
   (the distractor counts are the teaching signal — "Mitochondria ×2" says
   the class is confusing it with chloroplast). Attempts predating the
   `breakdown` column are recomputed from raw answers for objective
   questions. Only each student's latest attempt counts.

3. **Student result** — the submit response and
   `GET /api/classroom/worksheets/:id/my-result` both return `results`:
   each question with the student's answer, the correct answer, marks
   awarded and the marker's feedback. `renderWorksheetResult()` shows the
   marked paper instead of closing on a bare score. Grading was writing a
   sentence of feedback per answer that nothing ever displayed.

4. **Reteach** — `POST /api/teacher/worksheets/:id/reteach` takes the weak
   question ids and generates an easier worksheet on the same concepts,
   reworded, which the teacher can publish to the class in one click.

`GET /api/teacher/worksheets` lists published worksheets with submission
counts; without it a teacher had no route back to a worksheet after
publishing it.

## Trust & claims

Public claims must stay true to the code — the landing page previously
overstated three things and they were corrected:

- **Counters** are product facts, not usage stats. "50+ AI Tools" is real
  (51 in `data.js`); "20+ Tech Stacks" was actually 7 and is now
  "7 Developer Tracks"; "100% Instant AI Grading" was removed — written
  answers can be flagged `needsReview`, so it was false.
- **Badges are not accreditation.** "Developer Skill Certified" → "Skill
  Badge"; "official certificates" → "practice certificate". The Terms say
  explicitly that nothing here is board-accredited.
- **Model names** are not promised in headline copy ("AI-assisted"), because
  routing picks the model per task and most tools are prompt templates.

`LEGAL_DOCS` in `app.js` holds Privacy, Terms and Contact. **The
vendor list in the privacy policy is the real set of third parties that
receive data** (Groq, Gemini, Sarvam, Pollinations) — if you add an
integration, update it or the policy becomes false. `[REVIEW]` markers flag
what still needs a lawyer, notably parental consent for under-18s under
India's DPDP Act.

Billing and all paid-access gates have been removed. See README.md for the current setup.

## NCERT textbook corpus

Books are discovered from the DIKSHA/NCERT channel and imported automatically
— **no manual book or content ids**. Run `npm run sync:ncert`; progress is
written to `backend/database/ncert-sync-status.json` and a lock file prevents
two importers running at once. It resumes after interruption using the
resource cache in `database/ncert-resource-cache`.

**Chapter grading** (`gradeChapter()` in `services/ncertSource.js`) decides
whether a chapter is usable:

| status | meaning |
|---|---|
| `ready` | ≥60% of pages readable and ≥1500 chars — safe to teach from |
| `needs_review` | real text but gaps a human should check |
| `unavailable` | image-only/scanned — needs OCR, not review |

The original rule required *every* page to carry ≥40 chars, so one full-page
illustration condemned an otherwise perfect chapter. 177 already-downloaded
chapters (2.6M chars) were stuck in review because of it. If you change these
thresholds, run `npm run ncert:regrade` — it re-grades stored chapters
without re-downloading anything.

**Downloads time out on stalls, not on total time.** Chapter PDFs reach
~57MB and take ~105s on a normal link; the original 120s total timeout failed
them intermittently and stored them as zero-page chapters. `download()` now
aborts only when no bytes arrive for 90s, so a slow but healthy transfer
finishes. One such "unavailable" Urdu Class 7 chapter extracts to 20 readable
pages once allowed to complete.

`npm run ncert:repair` re-fetches any chapter still stored with zero pages.
The importer also retries them on its next pass, because the resource cache
only short-circuits entries that actually have pages — and it re-grades
cached pages on read, so a change to `gradeChapter()` reaches cached content
without re-downloading.

**Two lookup paths:**

- `POST /api/ncert/ask` — caller supplies `bookId` + `chapterId`.
- `POST /api/ncert/ask-auto` — caller supplies `grade`, optional `subject`
  and `medium`, and the question. The chapter is chosen automatically.
  This is what makes "set your class, ask a question" work.

### Semantic search (Postgres + pgvector)

SQLite stores each book as a single JSON payload, so retrieval had to load a
whole book to score it and could only match literal keywords — a student
asking *"why do things fall down"* never reached GRAVITATION, because the
chapter never uses the word "fall down". The corpus is therefore mirrored
into Postgres with `pgvector`, one row per chunk with a 384-dim embedding.

- `services/ncertPg.js` — schema and queries. `grade`/`subject`/`medium` are
  denormalised onto `ncert_chunks` so a filtered vector search stays one
  index scan. The HNSW index is built **after** loading (`buildVectorIndex()`);
  maintaining it per-insert is far slower.
- `services/embedder.js` — `Xenova/all-MiniLM-L6-v2` via
  `@huggingface/transformers`, running locally on CPU. No API cost, no
  per-query latency to a vendor, ~46 chunks/sec end-to-end during import.
- `scripts/migrate-ncert-pg.js` — reads SQLite, chunks ready chapters at
  1400 chars / 1100 step (matching the keyword chunking), embeds, inserts.
  **Re-runnable**: chapters that already have chunks are skipped, so run it
  again to pick up whatever the importer has added since.

Set `NCERT_PG_URL`. Local dev uses the `studyhub-pgvector` container:

```
docker run -d --name studyhub-pgvector -e POSTGRES_PASSWORD=studyhub \
  -e POSTGRES_USER=studyhub -e POSTGRES_DB=studyhub -p 5440:5432 \
  -v studyhub-pgvector-data:/var/lib/postgresql/data pgvector/pgvector:pg16
```

### Mobile: the page scrolls, not an inner div

The shell sized `.app-wrapper` to the viewport and scrolled `.main-content`
inside it. On desktop that is fine; on a phone it reads as "the site does not
scroll". When the document itself cannot scroll the browser's address bar
never retracts, so the real visible area stays smaller than `100dvh` reports
and the bottom of every page sits behind the browser chrome. Measured at
375x812: document `scrollHeight` equalled `innerHeight` exactly while
`.main-content` held 2773px of content.

Under 768px the shell is now `height: auto` with `overflow: visible`, so the
document scrolls normally and the fixed tab bar gets clearance via
`padding-bottom`. The chat view keeps its own scroller — its composer is
docked, so the thread must scroll under a fixed input rather than with the
page.

Note when testing this by hand: `html { scroll-behavior: smooth }` animates
even a direct `scrollTop = n` assignment, so reading `scrollTop` straight
after returns the OLD value. That made a working fix look broken twice.

### Wikipedia fallback

`services/webLookup.js` is used ONLY when the corpus has nothing, so the
textbook stays primary and the tutor stops answering from model memory with
no source. It is skipped while a chapter is locked (there the student asked
for that chapter and nothing else) and for task requests like "make me a
revision timetable", which are not lookups.

The fetched text is untrusted third-party content: the block states plainly
that it is NOT the textbook, names Wikipedia, and tells the model never to
follow instructions inside it. Hosts are matched exactly
(`^[a-z-]{2,12}\.(wikipedia|wikibooks)\.org$`) and re-checked after
redirects — a suffix test would accept `wikipedia.org.evil.test`.

**Wikipedia's search answers natural-language questions badly.** "why do
things fall down" returned *Stranger Things season 5*, sharing only the word
"things". An article is only used if the question substantially names its
title (`namesTitle >= 0.6`). Calibrated on 11 realistic queries: 0.5 let two
junk articles through, 0.6 let none, at the cost of one borderline good
match. A rejected article means no web context and an honest "I don't know";
a wrong one gets cited to a student.

### Chapter lock — staying on one chapter, gated to it

Once a student names a chapter they stay on it until they say otherwise.
`services/chapterLock.js` stores the chapter id as an ordinary memory fact,
so it survives reloads and threads; `buildLockedContext()` then supplies
that chapter's own text and **gates** the answer to it.

That gating is the opposite of the unlocked Companion behaviour, and
deliberate: a student revising one chapter is better served by *"this chapter
does not answer that"* than by a fluent answer drawn from somewhere else.
Verified — asking about photosynthesis while locked on दो बैलों की कथा returns
`यह पाठ इस प्रश्न का उत्तर नहीं देता है।` with no general-knowledge fallback.

Release phrases (`exit chapter`, `पाठ बदलो`, `दूसरा पाठ`, `doosra paath`, both
word orders) clear it. A lock whose chapter has since been re-graded as
garbled is dropped rather than served.

**Selection inside the chapter is literal, not embedding-based.**
`all-MiniLM-L6-v2` is an English model: measured on Devanagari, related text
scores 0.817 and *unrelated* text 0.603 — a band so narrow that top-k ranking
returned near-random pages and never once found the अभ्यास section. Within a
single chapter the candidate set is ~40 chunks, so term overlap is scored
directly, in both scripts (students type `abhyas ke prashn`; the text is
`अभ्यास के प्रश्न`). 6–17ms, and it finds the exercises.

Three sizing traps, all found by testing rather than reasoning:

- **The whole chapter costs ~7,000 tokens** and tripped the account's
  8,000 TPM limit on one question. Only a budgeted slice is sent.
- **Taking the chapter's first N characters** cut off exercises and word
  lists, which sit at ~89% through. When nothing matches literally the
  chunks are sampled at a stride across the whole chapter instead.
- **`titleScore` is the wrong scorer for switching.** It divides by QUERY
  tokens, so `ab reedh ki haddi paath padhna hai` scored 0.50 and failed to
  switch while the bare `reedh ki haddi` scored 1.00. `namesTitle` scores the
  share of the TITLE's tokens and is stable at 0.67 across every phrasing.

### Answers pitched at the class

`readingLevel()` turns the stored class into an explicit language directive:
Class 1-5 gets very short sentences, everyday words and a 120-word cap;
Class 6-8 plain explanations over formal definitions, 180 words; Class 9-10
the textbook's own terms explained in plain words; Class 11-12 precise but
still bounded to the chapter's depth. Without it the tutor wrote at its own
register, which for a Class 6 reader is unusable.

### Two different corruptions, not one

The broken font map is only half of it. Some PDFs embed **legacy 8-bit
Devanagari fonts** (Kruti Dev, Chanakya, Shusha) where the stored bytes are
Latin and only the font makes them look like Hindi. क्षितिज भाग-1 extracted as:

```
dkO; [kaM ân; fla/q efr lhi lekukA ... & rqylhnkl
```

which is `काव्य खंड हृदय सिंधु मति सीप समाना ... तुलसीदास`.

**`scanIndic()` scored these 0.000 and passed them.** It counts faults per
Devanagari character, and these contain no Devanagari at all — so they
shipped as `ready`, and the model answered from them and invented authors.
**1,149 chapters**, 925 of them Hindi, on top of the 3,140 already known.

`looksLegacyEncoded(text, medium)` catches them by script mismatch: a book in
an Indic-script medium whose text is ≥80% Latin letters (over a 300-letter
floor). English and Urdu are exempt — Latin and Arabic script respectively.
`gradeChapter()` now takes the medium so it can apply this, and
`npm run ncert:garbled` no longer filters candidates by script — doing so
skipped exactly the chapters that most needed catching.

The lesson worth keeping: a validity check that only looks for *malformed*
text of the expected script will not notice text of the *wrong* script.

### OCR recovers what the font map destroyed

`npm run ncert:ocr` renders each page with unpdf and reads the pixels with
Tesseract, sidestepping the broken font entirely. On the same Class 9 Hindi
page that extracted as `आगे झुकने की जरूर ती नहीं है ... मक बाबा`, OCR produced
`आगे झुकने की जरूरत नहीं है ... कि बाबा` — integrity **0.0000**, confidence 93%.

The recovered text is re-checked with the same `scanIndic()` before anything
is written, so a page OCR also cannot read stays quarantined rather than
becoming a plausible-looking answer. Each chapter then writes its text to
SQLite, re-embeds, and the run re-ranks editions at the end — a book demoted
for being unreadable becomes current again once it is readable.

Two traps worth remembering: **pdf.js detaches the typed array it is given**,
so every page render needs its own copy or page 2 fails with "Cannot transfer
object of unsupported type"; and reusing one document proxy is *slower*
(154ms/page) than a fresh copy (124ms).

Note the integrity check is Devanagari-specific, so recovered Bengali-script
(Assamese) and other non-Devanagari text passes it trivially and is not
actually verified.

### Naming a book, and the order system messages are added

The newest usable edition is the default, but a student may name the book
they mean — `from the 2022 lab manual`, `kshitij se batao`, `गंगा किताब`.
`namesTitle()` scores the reverse of `titleScore()`: the share of the TITLE's
tokens present in the question, so a long question naming a short book still
matches. Generic words are excluded, or a book called *Science Textbook*
would be "named" by every question containing "science". Romanised Indic
words vary mainly in vowels, so tokens also compare by consonant skeleton
(`ganit`/`ganita`, `kshitij`/`ksitija`) — and skeleton equality is tested
BEFORE the prefix rule, or the weaker 0.5 match wins and the book is missed.

`buildChapterLocator()` matches book titles as well as chapter titles.
"Ganga" is the 2026 Class 9 Hindi textbook, not a chapter in क्षितिज; without
this the tutor reported the student's own book as non-existent.

**System-message order decides which instruction wins.** The locator is
unshifted LAST so it ends up closest to the question. Placed before the
chapter index it lost outright — the model followed the concrete chapter list
and declared a real book non-existent. Both notes now also say explicitly
that they override any chapter list, because the two were contradicting each
other.

### Romanised Hindi, and never denying a real chapter

Students type chapter names as they say them — `aisi baate bhi hoti hain`
for `ऐसी भी बातें होती हैं`. `services/translit.js` romanises Devanagari and
folds the spellings that vary informally (long/short vowels, `ph`/`f`,
aspirates, final nasals) so both forms collide. Devanagari's inherent vowel
matters: क is `ka`, not `k`, or no romanised title ever lines up.

Matching only the current, readable shelf produced the worst answer in the
system: *"that title does not appear in your Class 9 Hindi textbook"* — about
`पाठ 4 - ऐसी भी बातें होती हैं`, which is in `गंगा (2026)`, the student's real
current edition, demoted only because its text is garbled. **Telling a
student their own book does not exist is worse than admitting we cannot read
it.**

`buildChapterLocator()` searches every edition on the shelf regardless of
status and, on a match above 0.45, tells the model the chapter is real and
why it cannot be quoted. The syllabus index was rewritten to match: it now
says a chapter is "not in THIS book" rather than asserting non-existence —
the two instructions previously contradicted each other and the model
followed the wrong one.

### Devanagari extraction is broken at the source

Many DIKSHA PDFs carry a broken font-to-Unicode map, so extraction yields
text that *looks* like Hindi but is not:

| extracted | should be |
|---|---|
| `बातीें होतीी हैं` | `बातें होती हैं` |
| `मक` | `कि` |
| `अहधकार` | `अंधकार` |
| `किे किोने-किोने` | `के कोने-कोने` |

This is the worst failure mode available: a model reads it as ordinary prose,
answers confidently from nonsense, and cites a real page number for it. A
student sees a well-formatted answer with a working source link.

`scanIndic()` in `services/ncertSource.js` catches it structurally rather
than by dictionary. A dependent vowel sign must follow a consonant; two in a
row (`किे` = क + ि + े), or one stranded after a space, cannot occur in valid
Devanagari. Clean text scores **0.000**, corrupted pages **0.08–0.17**; the
threshold is 0.02 over a 200-character floor.

`gradeChapter()` returns status `garbled` for these — never `ready`, however
much text there is — and `search()` excludes them. **3,140 of 4,762
Devanagari chapters were affected**: Hindi 703/713, Sanskrit 386/386,
Marathi 312/312, Dogri, Nepali, Maithili, Konkani, Bodo, Sindhi, Santhali
essentially in full. Run `npm run ncert:garbled` to re-scan after any change
to extraction.

Two consequences worth knowing:

- **Edition ranks must be recomputed after marking.** Class 9 Hindi ranked
  `गंगा` (2026) first on 12 chapters that were all corrupt, ahead of
  `क्षितिज भाग-1` with 13 clean ones. The rank rule already prefers books
  with readable chapters, so re-running `computeEditionRanks()` fixes it —
  but it must run *after* the garbled scan, not before.
- **Quarantine alone is not enough.** Removing the citations just moved the
  model from confidently-wrong-with-sources to confidently-wrong-without —
  it invented an author for a real chapter. `shelfHealth()` now reports when
  a shelf exists but has no usable text, and the context tells the model to
  say so rather than supply titles, authors or quotations from memory.

**Language subjects are not in English medium.** The Class 9 Hindi book is
filed under medium `Hindi`; assuming `English` found no shelf at all and let
the model answer from memory. `mediumFor()` infers it from the subject, with
the student's stated medium taking priority.

### Editions: prefer the book actually in force

DIKSHA carries several editions per shelf, and title and year are both
unreliable. Class 9 Science holds three: **Exploration** (2026, the current
book), **Science Lab Manual** (2022), and **"(NEW) Ncert Science Textbook
For Class IX"** — which is the *superseded* syllabus, is labelled NEW, and
carries **no year at all**. Ranking on either signal alone picks the wrong
book. The observed failure: a student asking about their first three
chapters got MATTER IN OUR SURROUNDINGS / IS MATTER AROUND US PURE / ATOMS
AND MOLECULES, when their book opens with EXPLORATION.

Year alone is a bad proxy for "the textbook" — the shelf also holds lab
manuals, comics and explicitly-marked demo books. Class 10 Science ranked
`Science Lab Manual` (2022) above `Science Textbook for Class X`, put a
`Comic Book` with zero readable chapters above both, and carries two books
titled *Demo — Not For Regular Use*.

`computeEditionRanks()` therefore ranks within each (grade, subject, medium)
by, in order: **kind** (real textbooks, then manuals/supplements, demos
last), **whether it has any readable chapter at all** (a book with none can
never be the current edition), **numeric year** descending nulls last,
then readable-chapter count and sync time. Rank 0 is the current edition.
It re-runs at the end of every migration pass, because which book is current
changes as new editions import.

Both retrieval paths search `currentOnly` first and widen to older editions
only when the current one has nothing above threshold — a superseded chapter
still beats model memory. Widening never lowers the grounding bar.

**The question outranks the profile.** The study bar says which shelf a
student usually works on, but `detectShelf()` reads any class and subject
named in the question itself — "what chapters are in class 9 maths" from a
Science profile used to answer *"I don't have that"* and then recite the
syllabus from model memory, while Ganita Manjari sat in the corpus. A class
named without a subject does **not** inherit the profile's subject; it lists
that class's subjects and their current books instead, since dumping every
chapter of 30 subjects would truncate and misrepresent the class.

**Naming chapters is a catalog question, not a content question.** Vector
search cannot answer "discuss the first three chapters", so the model fell
back on whichever edition it was trained on. `buildSyllabusIndex()` supplies
the student's real chapter list whenever a class is known, with an explicit
instruction never to present another edition's chapter names as current.

### The AI Companion retrieves too

`useMemory` used to mean only "tell the model the student's class". The
directive said *follow the Class 9 Science syllabus*, but nothing was
retrieved, so the answer still came out of model weights wearing NCERT
vocabulary. `services/ncertContext.js` now embeds the student's actual
question, searches their own shelf, and injects the real passages.

The difference from the strict tutor is deliberate: here retrieval
**augments rather than gates**. The Companion is a general assistant —
refusing "help me plan my revision timetable" because it is not in NCERT
would break it. Nothing above `MIN_SCORE` (0.35, stricter than the tutor's
0.25 because unsolicited context is worse than none) means nothing is
injected and the model answers as before. Verified both ways: a gravitation
question returns 5 cited passages, a timetable request returns none and
still answers.

`/generate` returns those passages as `sources`, and the chat renders them
as a citation footer under the answer. That also retired the fabricated
"Ran 4 searches / Opened page" thinking panel — it now reports the real
retrieval ("found 5 matching passages", naming the chapters) and shows the
plain reasoning line when nothing was retrieved.

**Filtered vector search needs iterative scans.** An HNSW index returns its
nearest neighbours and only *then* applies the `WHERE` clause, so a class
filter can eliminate every row the index offered — the query returns nothing
while the answer sits in the table. Measured on the live corpus: 13 of 36
class-scoped queries returned zero rows; `why do things fall down` scoped to
Class 9 found nothing because the global nearest chunks were all Class 6,
while exact search found GRAVITATION at 0.467. It is data-dependent, so it
fails **silently and intermittently** — and `MIN_SCORE` then reports it as
"no content imported yet", which is confidently wrong.

`createPgCorpus()` therefore sets `hnsw.iterative_scan = relaxed_order` and
`hnsw.ef_search = 100` on every new pooled connection (session settings do
not persist across them). That takes the same sweep from 13 empty results to
3 — and those 3 are real, being a class not yet migrated.

`createVectorTutor()` embeds the question, searches the class's shelf, and
**discards hits below `MIN_SCORE` (0.25) without calling the model**. Every
chunk has some nearest neighbour: on a shelf with no relevant chapter the
top match still scores ~0.15, and answering from that is precisely the
confident-but-wrong behaviour this corpus exists to prevent.

If Postgres is unreachable or `NCERT_PG_URL` is unset, `/ask-auto` falls back
to the keyword tutor — a Postgres outage degrades answers rather than taking
the tutor offline. The keyword path is also tried when semantic search comes
back ungrounded, since literal phrasing can still hit.

Answers are grounded: the model must cite `sourceIds` drawn from the supplied
excerpts, and **an answer whose citations don't match is rejected** rather
than shown. Every response carries page-level provenance (URL, sha256,
revision, licence).

`npm run ncert:coverage` reports the truth from the database rather than the
sync counters, which only describe the current run.

## Rendering AI output

Model output is markdown with LaTeX, and the two fight each other. Use
`renderAiMarkdown()` in `app.js` — never `marked.parse()` directly — then
call `renderChatMath()` on the element:

1. Math (`$$…$$`, `\\[…\\]`, `$…$`) and code fences are stashed as
   placeholders **before** markdown runs. Without this, marked reads `_` as
   emphasis and eats backslashes, so `n_1\\sin i` reached KaTeX already
   broken and rendered as raw text.
2. `marked` runs with `gfm` and `breaks: true` — models hard-wrap prose, and
   without `breaks` it collapses into a wall of text.
3. Math is restored untouched, then KaTeX renders it.

Typography lives in premium.css §30 (`.ai-prose` and the bubble selectors).
Model output leans on headings heavily; before this they inherited the page's
display headings and a `###` rendered at 20px inside a chat bubble, which is
what made answers look messy.

## Syllabus grounding

Board, class and subject are separate memory facts (`board`, `class`,
`subject`), set from the study-profile bar on the AI Companion welcome
screen. `buildSyllabusDirective()` turns them into a system instruction that
pins the answer to the right textbook and the right depth.

The effect is real: asked "Explain refraction", ungrounded output covers
sound and seismic waves; grounded output names the NCERT chapter
("Light – Reflection and Refraction") and stays at Class 10 depth.

**This is prompt grounding, not retrieval.** The model is instructed to
follow NCERT; it is not reading the actual textbook. True retrieval would
need an indexed NCERT corpus with embeddings. Real web search needs
`groq/compound`, which is rate-limited to unusable on the current tier.

## AI Companion memory

The chat was fully stateless — `grokChatHistory` was declared and cleared in
three places but never written to or sent, so *"now do the same for the next
one"* meant nothing. Memory now has three layers:

1. **Conversation** — `chat_threads` / `chat_messages`. `POST /api/ai/generate`
   accepts `threadId`, replays the last `HISTORY_TURNS` (16) turns before the
   current message, and appends the exchange afterwards. Thread titles are
   taken from the first user message.
2. **Persistence** — the active thread id is kept in `localStorage`;
   `restoreChatThread()` re-renders it on load, so context survives a refresh.
   `GET /api/ai/threads` lists recent conversations.
3. **Study context** — `services/studyMemory.js` assembles a compact system
   message from the student's real record: level, enrolled classes, recent
   worksheet scores, and the specific misconceptions the grading engine
   already identified (from `worksheet_attempts.breakdown`). Sent when
   `useMemory: true`. Durable facts the student states are stored in
   `user_memory` and included.

Layer 3 is the differentiated one: ask "what should I revise?" with no topic
and the tutor answers with the questions this student actually got wrong.

Keep the context small — it rides on every request and the on-demand tier
caps total tokens per minute at 8000.

## Notifications

`notifyClassStudents()` has always inserted rows on publish, and
`/api/classroom/notifications/{list,read}` have always existed — but nothing
fetched them and no bell had a click handler. All three portals now share one
implementation: any `[data-notif-btn]` with a sibling `[data-notif-panel]` is
wired automatically, with an unread badge, a 90s poll and mark-all-read. Add a
bell to a new portal by copying that markup; no JS needed.

## Diagram generation

AI-generated Mermaid is not trusted directly — models routinely emit
`H2O[Water Splitting (Photolysis)]`, and Mermaid reads the `(` as shape
syntax. `renderMermaidDiagram()` in `app.js` extracts the code, validates it
with `mermaid.parse()`, quotes offending labels via `repairMermaidLabels()`,
re-validates, and only then renders — falling back to showing the source and
the parse error instead of Mermaid's "Syntax error in text" graphic.

## One shell, three portals

Student, Teacher and Developer share a single shell — same header anatomy
(logo left; context control, theme toggle, notifications, user dropdown
right), same sidebar, same active-nav pill, same user pill and dropdown.
The only difference is the accent, set per wrapper in premium.css §24:

| Portal | Wrapper | Accent |
|---|---|---|
| Student | `.app-wrapper` | blue `--brand-500` |
| Teacher | `.teacher-portal-wrapper` | emerald `#059669` |
| Developer | `.devhub-portal-wrapper` | indigo `#6366F1` |

Portal-specific styling should set `--accent` / `--accent-dark` and let the
shared rules do the rest, rather than hard-coding a hex.

## Portals are role-locked

An account is a student, a teacher or a developer, enforced server-side at
login. There is deliberately **no in-app portal switcher** — changing portal
means logging out and signing in with that account. `switchPortal()` still
exists, but only for routing and session restore; both it and
`handleAppRouting()` bounce a student who reaches a `/teacher/*` URL back to
their own dashboard (URL corrected, no sign-in modal dangled).

Every portal has its own logout, all routed through the shared
`#logout-modal` → `performFullLogout()`.

## Auth & sessions

`isAuthenticated()` gates both `handleAppRouting()` and `switchPortal()`.
Routing is reachable from a logo click, the Back button or a pasted URL, so
the check belongs there — not only on the login path. `performFullLogout()`
clears every key in `SESSION_KEYS` and uses `location.replace('/')` so the
in-app URL does not stay in history.

## Theming

`applyTheme('light' | 'dark')` in `app.js` is the single entry point. It
stamps `data-theme` on both `<html>` and `<body>`, swaps the topbar icon and
the `theme-color` meta, and persists to `localStorage.theme`. First-time
visitors follow `prefers-color-scheme`.

Colours in `styles.css` and in inline `style="..."` attributes resolve
through CSS variables (`--surface`, `--surface-inset`, `--text-primary`,
`--text-secondary`, `--border-color`) so both themes stay in sync. Use those
variables rather than literal hex values for anything theme-dependent.

## Key Configuration

- Backend runs on port 5000, binding to 0.0.0.0
- Frontend API calls use relative `/api` paths (no hardcoded localhost)
- JWT secret: set in `backend/.env` as `JWT_SECRET`
- Gemini API key: set in `backend/.env` as `GEMINI_API_KEY`
- Groq API key: set in `backend/.env` as `GROQ_API_KEY`

## Running

The workflow `Start application` runs: `cd backend && node server.js`

## User Features

- Register/Login with JWT auth
- AI tools: chat tutor, writing help, math, summarizers, creative tools
- Notes management
- XP/leveling system
- Global leaderboard
- User profiles with avatar and bio
