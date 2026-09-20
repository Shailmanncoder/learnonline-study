# StudyHub

StudyHub provides AI study tools, NCERT retrieval, notes, worksheets, classrooms, and progress tracking. All tools are available to signed-in users without payment, subscriptions, trials, or tool selection. Teacher/classroom authorization still applies.

## Local setup

1. Install Node.js 20 or newer, then run `cd backend && npm ci`.
2. Copy `backend/.env.example` to `backend/.env` (or `.env.example` to `.env` if already in `backend`).
3. Generate `JWT_SECRET` with `openssl rand -hex 32`. Missing, short, or known fallback secrets prevent startup. Rotating it signs out existing sessions.
4. Set `DB_DRIVER=mysql` with your existing MySQL settings, or deliberately choose `DB_DRIVER=sqlite` for a local database. MySQL errors stop startup; the app never silently switches datasets. SQLite defaults to `backend/database/studyhub.db`; `SQLITE_PATH` overrides it.
5. Set the AI provider keys you use. Without a provider the existing app returns simulated responses; that is not a live AI verification.
6. Run `npm start` from `backend`, then open `http://localhost:5001` (the example environment sets that port).

The MySQL initializer currently creates the database/tables, so its account needs the corresponding privileges. Do not switch `DB_DRIVER` on an existing deployment without deliberately migrating its data.

## NCERT and source library

NCERT semantic retrieval uses a separate PostgreSQL/pgvector database through `NCERT_PG_URL`. The existing `ncert.dump` is a custom-format PostgreSQL backup: inspect it with `pg_restore --list`, and restore only into an intentionally chosen database. Its contents are not automatically restored by startup or tests. OCR language files and `model-cache/` support document extraction and local embeddings.

For Docker, set database hosts in `backend/.env` to reachable addresses (typically `host.docker.internal` for host services), then run `docker compose up --build`. Compose loads the private environment file instead of embedding secrets. SQLite data is persisted in the `studyhub-data` volume. The image excludes private environment files and existing local database contents.

## Verified Source Library

Practice questions are served from a database of real NCERT Exemplar questions
rather than written by a model. The collector fetches only allowlisted official
URLs (robots.txt respected, size and timeout limits, redirects revalidated),
extracts each page with coordinates, and reads questions with a deterministic
parser — no model is involved in deciding what a question is or where it came
from. Every citation is built from stored database fields.

A question is `AUTO_VERIFIED` only when nine checks pass, including that its
text is present on the recorded page, that its number sits next to it, and that
the chapter's numbering is intact up to that question. Where numbering breaks,
the questions after the break are kept for human review instead of being
trusted. The rule throughout: **a missing citation is acceptable, a fake
citation never is.** Unverifiable sources show "Exact source not verified."

Current coverage (Classes 6-12 English editions): 270 documents, 15,277
questions, 14,438 auto-verified, 11,151 with a confirmed printed page number.
Answer keys listed as chapters are excluded by both their listing label and the
PDF's own opening heading, so an answer never becomes a question.

Ingested PDFs are **not** committed: they are publisher material we are
licensed to fetch and cite, not to redistribute. Rebuild a local copy with
`node scripts/library-collect.js --class 7 --subject Mathematics --all-units`,
and check coverage with `node scripts/library-coverage.js`. Admin review lives
at `/admin/sources`, restricted to the usernames in `LIBRARY_ADMINS`.

## Study tools in the chat

Asking the Companion for a worksheet, quiz, flashcards, notes or a mind map
runs the tool and returns an interactive card in the conversation
(`backend/services/chatTools.js`, `frontend/chatTools.js`). Worksheets prefer
verified library questions, each with its own citation and a link to the exact
page; follow-ups such as "5 more" or "make it harder" continue the same tool
and skip questions already given. Anything a model wrote is labelled as
AI-written and carries no book, page or question number, and marking is
labelled as AI-checked.

## Verification

`cd backend && npm test` uses disposable SQLite databases, disables provider credentials, and runs authentication, removed-payment-endpoint, source-library, memory, and NCERT tests. Tests requiring an ingested source library are skipped without that dataset. No test uses the real account database. `npm run test:ncert` runs just the NCERT suite in the same isolated setup.

## Billing removal and credential cleanup

The payment controller, Razorpay dependency, checkout script, pricing dialogs, upgrades, subscription API methods, and all paid-access gates have been removed. Former `/api/payment/*` routes return 404. Fresh databases no longer create billing tables or plan columns. Existing historical billing records are deliberately left untouched; no destructive database migration is run.

The local JWT secret was replaced during remediation. The exposed provider key was removed from configuration, but deleting a key from files does **not** revoke it. Revoke the old key in its provider account and enter a new key in `backend/.env`. Never distribute `.env`, configuration backups, or user databases. The rebuilt distribution ZIP excludes those files and includes the current application code.

## My Learning workspace (September 2026)

Open **My Learning** in the student sidebar for a daily plan combining due mistake reviews, flashcards, outstanding homework, and saved exam goals. Goals include a date, daily practice time, and syllabus topics. Daily check-ins persist per account and local calendar day; they represent activity, not verified mastery. Recent quiz accuracy helps prioritize matching syllabus topics. **Progress & export** downloads the account's goals, mistake history, quiz scores, and check-ins as JSON.

New practice quizzes store their answer keys on the server. The browser submits a quiz ID and answers; duplicate submissions return the saved result without awarding XP again. Wrong answers enter the mistake notebook. Correct retests are scheduled one and three days apart, with retirement after three successful spaced reviews; incorrect retests become due after approximately ten minutes. These repeated questions measure retention, not independent concept mastery. Historical quiz scores are retained and may predate server-side grading.

Classroom worksheet submissions require active enrollment in an active class and a published worksheet. Student list/feed responses omit solutions. Homework resubmission clears old grading; repeat homework and worksheet submissions do not repeatedly award completion XP. These routes no longer invent study minutes. Worksheet totals derive from question marks. Uncertain fallback grades are provisional and earn no XP until reviewed. Teachers use **Review queue** in their own sidebar to finalize flagged answers, write feedback, and notify students. Reviews are logged and validated against each question's maximum marks.

The learning tables are created additively on first use for the configured SQLite or MySQL database. Multi-step scoring and rewards use transactions; SQLite requests are serialized so other requests cannot join an open transaction. Account deletion also removes the new learning records. No existing account data is reset by these additions.

Validation: `npm test` includes isolated HTTP journeys for quiz ownership, duplicate submissions, mistake scheduling, goals and export isolation, answer-key hiding, enrollment, homework regrading, teacher reviews, and rollback. Browser checks covered the student workspace, saved goals, check-ins, retest feedback and direct reload. Live model generation, MySQL deployment behavior, and production capacity require deployment-specific verification. The new features do not change AI provider routing or configure model credentials.

## Online Auto Study prototype

Open **Online Auto Study** in the student sidebar (route `/online-auto-study`). The local workspace includes class 1–12 selection, sample books and chapters, a scripted tutor, notes, flashcards, quizzes, and an NCERT ingestion explanation. It loads on first use and keeps its selected chapter while switching StudyHub sections. The full workspace is also available at `/auto-study/index.html`.

This integrated preview uses authored sample content; it is not connected to the existing live AI or NCERT retrieval services and does not save progress. Its files live in `frontend/auto-study/`, so it does not rely on the private Sites deployment. Access to this static demo follows the StudyHub host's access settings; the “demo” label does not imply private hosting.
