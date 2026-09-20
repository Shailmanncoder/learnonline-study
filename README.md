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


## Online Auto Study prototype

Open **Online Auto Study** in the student sidebar (route `/online-auto-study`). The local workspace includes class 1–12 selection, sample books and chapters, a scripted tutor, notes, flashcards, quizzes, and an NCERT ingestion explanation. It loads on first use and keeps its selected chapter while switching StudyHub sections. The full workspace is also available at `/auto-study/index.html`.

This integrated preview uses authored sample content; it is not connected to the existing live AI or NCERT retrieval services and does not save progress. Its files live in `frontend/auto-study/`, so it does not rely on the private Sites deployment. Access to this static demo follows the StudyHub host's access settings; the “demo” label does not imply private hosting.

### Auto Study: what is still a demo, and what connecting it would take

Auto Study remains authored sample content with scripted tutor replies. It
makes no network calls at all — no `fetch`, no token, no storage — so a demo
quiz answer cannot reach a grade, an XP total or any account record. Its demo
labels ("Sample-content demo", "Not connected", "Demo replies only") describe
the current state accurately and should not be removed while that is true.

To connect it for real, in rough order:

- **Catalog identity.** The class/book/chapter picker uses invented ids. Real
  navigation needs NCERT's own book and chapter identifiers, plus edition and
  language, since "Class 7 Science" names several different books across years
  and media.
- **Chapter sources.** Chapter text, with page numbers preserved, so an answer
  can cite the page it came from. `backend/services/ncert*` already ingests and
  retrieves this; a connection should call those services rather than building
  a second ingestion path, and must not silently import a database dump.
- **Citations.** The tutor should show which passage it used and say plainly
  when the book does not support an answer.
- **Saved progress.** Nothing is persisted today. Saving would mean per-account
  rows, which brings it under the same ownership and deletion rules as the rest
  of the app.

Until those exist, the honest description is the one already on the page.

## Classroom integrity (September 2026)

Permissions are decided by the account row, not by the token or the request.
`middleware/auth` loads the account on every authenticated request, rejects a
token whose account no longer exists, and reports the stored role — a token
issued before a role change grants nothing. The teacher router is gated on that
role, so a student cannot reach a teacher endpoint by opening the teacher
portal.

A class code requests teacher access; it does not grant it. The request is
stored pending and the class owner approves it and chooses the role, from
subject teacher or class teacher. Owner is never assignable. Roster changes and
code regeneration need owner or class teacher; archiving and approving teachers
need the owner. Archived classes stay readable and take no new work.

Assessments keep their answers. Student-facing worksheet responses are redacted,
and `GET /api/classroom/worksheets/:id/start` serves the questions needed to
answer without the key. Submission requires an active enrollment in an active
class, a published worksheet inside its window, known question ids, and an
attempt remaining. Practice quizzes are stored server-side and graded by quiz
id, so a browser cannot supply its own marking scheme.

Submissions carry an idempotency key, unique per (worksheet, student, key), so
a retry returns the recorded result rather than creating a second attempt. XP is
paid against `reward_grants`, keyed by the work completed, so retries, new
attempts, regrades and resubmissions cannot pay twice.

A machine grade is a proposal. Where the model could not mark an answer, or the
keyword fallback did, the attempt is stored provisional, shows as provisional,
and earns nothing until a teacher finalises it in the review queue. Both scores,
the reviewer and the time are recorded. Students may request a review of their
own result.

Reporting distinguishes latest from best attempt and says which it is showing,
counts distinct students, reports the class size as the denominator, averages
finalised attempts only, and shows provisional work separately from zero.

**Migrations** are additive and repeatable on both SQLite and MySQL, and run on
start. They add `study_quizzes`, `reward_grants`,
`homework_submission_revisions`, `grade_reviews`, `class_join_attempts`, and
columns for submission idempotency, grading status, teacher-membership status,
worksheet availability and estimated minutes. Existing rows keep working: a NULL
`submission_key` marks a pre-existing attempt and stays distinct under the
unique index on both engines, `grading_status` defaults to `graded`, and
`teacher_classes.status` defaults to `active` so current teachers keep access.

**Historical values are preserved, not rewritten.** `users.time_spent` and old
`activity.time_spent` rows include assignment durations that were counted as
measured study time; those totals are left alone, but new rows record the
configured duration as `estimated_minutes` and add nothing to measured time.
Attempts predating `grading_status` read as final, which is what they meant.

**Known limitations.** Rate limiting is per-process, so multiple workers
multiply the effective limit; a shared store would be needed for a real quota.
`middleware/classroomAuth.js` documents a richer permission model than the one
enforced and queries three tables that do not exist — it is marked NOT IN USE
and reconciling it needs a product decision. Sign-in still distinguishes
"account not found" from "wrong password", which the sign-up flow depends on but
which also confirms whether a username exists. Teacher self-registration remains
open: anyone may choose a teacher account at signup, which is a product decision
rather than a bug, but it means teacher-portal access is self-service.
