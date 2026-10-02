# Connected Study Studio — October 2026

This extends the existing application. It does not replace the 50-tool catalogue, existing classrooms, Companion, source library or teacher workflows. No deployment is performed by this change.

## Entry points

- Student: **Study Studio**, `/study-studio`; **Learning labs**, `/learning-labs`.
- Teacher: **Learning Studio**, `/teacher/learning`. Existing **Teaching Studio** remains at `/teacher/studio`.
- Companion: **Memory → What my Companion remembers** for editable account preferences.
- Existing **Study Roadmap** now saves new plans to the signed-in account and generates them on the server.
- **My Learning** now includes the next available Studio activity and due seven-day checks, with direct links to the pack.

## Connected lesson workflow

Create a chapter pack from a topic, pasted material, a document, or a reviewed teacher source. A pack contains objectives, a lesson, worked example, recall cards, oral-practice prompts and distinct starting, practice, follow-up and retention checks. Class, board, edition and explanation language remain attached to it.

Generation validates structure and equal concept coverage, then separately solves each assessment question without its answer key. Ambiguous questions and disagreement with the author's key trigger repair; generation stops after three attempts. This reduces mistakes but is **AI review, not certified correctness**. Every pack remains a private draft until a teacher or its personal owner reviews it. AI-written questions carry no invented exact textbook citations. Current NCERT alignment is not assumed from a supplied edition label.

Teachers can edit every lesson, question, option and answer explanation, target active learners, set a due date and explicitly approve a version. Published content and its source snapshot are immutable; duplicate a pack for a revision. Concurrent edits and repeat publication are rejected. Students receive only assigned material while their enrolment and class remain active. The baseline gates the lesson; later questions and answer keys stay server-side. Retention opens seven days after the independent follow-up. Check conditions are self-reported, not proctored.

Check-my-working accepts typed steps or extracted file text. Hint mode asks for another attempt; full-method mode explains and adds a transfer question. Teach-back practice uses typed text or browser-supported dictation with an editable transcript. Teacher feedback is separate from AI feedback and can be reviewed in the teacher portal. These responses are practice, not official grades.

## Source handling

The existing private teacher library accepts attachments of any extension within its 6 MiB per-file and 60 MiB per-teacher limits. New extraction supports PDF, PNG/JPG/JPEG/WebP, DOCX, PPTX and plain text. A personal source and a photo of working can also be extracted without creating a shared file.

PDF extraction preserves numbered source pages; OCR reads English/Hindi locally. Office extraction reads bounded document/slide XML without running macros or unpacking to disk. OCR, equations, handwriting, diagrams and Office pagination require human review. Teacher resources must be marked reviewed before use in the new pack generator. Unsupported media remain downloadable attachments; arbitrary file types are not automatically understood.

Limits: 40 source sections, 80,000 extracted characters, five scanned PDF pages OCRed, a two-minute worker deadline and bounded worker memory. Pack text input is 24,000 characters; working input is 6,000. The UI reports truncation and unsupported/failed extraction. Files are not malware-scanned. Binary downloads remain authenticated attachments. OCR models must be present at the backend's configured local paths.

## Labs and personalisation

Five deterministic explorations cover constant-acceleration motion, the area model for `(a+b)^2`, equivalent fractions, simplified atoms and probability experiments. Each has prediction, controls, an accessible visual/readout, written reflection and a new practice check. Written observations can be downloaded; they are not silently counted as mastery.

Saved Companion preferences include spoken video language, explanation language, class, board and answer length. Users can replace or forget facts. Video-language routing uses explicit current instructions first, contextual refinements next and the saved preference as a fallback. A pack pre-fills its topic, class, language and edition into the existing video workflow; no automatic claim of best-video or latest-NCERT verification is added.

## Roadmaps

New account plans use persisted jobs, short batches, leases and a heartbeat. Closing a tab does not cancel the job. Restarted servers can recover an expired lease. Pause, resume, completed-day updates, calendar export and downloads remain available. A missing or invalid batch leaves a paused partial plan instead of an invented completion. One active plan per account is enforced.

Rescheduling shifts unfinished dates and the target date together; completed days keep their dates. It is calendar adjustment, not a claim that the entire syllabus has automatically adapted to mastery. Browser plans with the current day structure can be imported. Existing browser-only plans are preserved. Production needs persistent database storage and an always-running worker process for background progress.

## Teacher evidence

Class insights use the latest independent check per learner and pack; later success clears earlier misses in that pack. Assisted practice does not establish an independent difficulty signal. A teacher can inspect the questions, prepare a targeted follow-up and review submitted working/teach-back feedback.

The downloadable class aggregate contains matched baseline/follow-up counts, score change in percentage points, missing follow-ups, delayed-check results and self-reported preparation minutes. It does not export student names or claim causal improvement or measured time saved. The authenticated teacher view contains the class roster and identifiable work. A public sponsor dashboard, guardian delivery, organisation-wide reports and matched-cohort evaluation are not included.

## Operations and validation

Tables `studio_*` are additive in the selected SQLite/MySQL database; back them up with existing application data. Account cleanup covers the new records. Studio AI/extraction actions share a 40-request daily per-account allowance; the existing provider limits also apply. A request can involve generation, repair and review calls. Provider keys and routing are unchanged. Structured JSON output and sanitized provider-error logging were added to the shared AI service.

Local validation uses isolated test identities and databases, not real classroom records. Automated coverage includes ownership, blocked enrolment, draft immutability, hidden answer keys, sequential/idempotent grading, content-review rejection, source-review concurrency, daily-plan integration, extraction limits and recoverable roadmap jobs. Browser checks cover teacher approval, student baseline/unlock, all five labs, preference persistence, daily-plan deep links, exact-day roadmap completion, refresh persistence and rescheduling at desktop and phone widths.

Live provider checks exercised image OCR, practice hint feedback, a complete three-day roadmap and a Hindi/Hinglish pack with 12 independently solved assessment questions. PDF text extraction and its rendered-page OCR fallback were checked with real document fixtures. The final isolated suite passed 197 tests with two existing source-dataset skips; syntax checks and diff whitespace checks passed. Some draft packs were deliberately rejected by the stricter content gate. Production MySQL, high-load behaviour, actual microphone/audio hardware, malware scanning and restoration of the local NCERT/pgvector corpus still require environment-specific work.
