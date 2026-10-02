# Teaching Studio

Implemented in the existing Teacher Hub at `/teacher/studio`.

## Available now

- Teacher-owned active-class selector, classwork and pending-review counts.
- Links to the existing homework grading, worksheet analysis/reteach and review queue.
- Persistent private file library; any file extension, 6 MiB per file and 60 MiB per uploading teacher.
- Explicit teacher sharing and revocation; actively enrolled students find shared files in Classrooms.
- Authenticated attachment downloads only, no public storage URLs or inline execution.
- AI lesson plans, catch-up practice and private parent-update drafts, using the configured AI service.
- Plain-text source extraction for TXT, Markdown, CSV, JSON and LOG (first 24,000 characters).
- Teacher editing and explicit publication into existing class notes; parent drafts cannot be published to the class.
- Optimistic draft version checks and duplicate-publication protection.
- Daily attendance with active-roster validation.
- Downloadable class aggregates without student names. No fabricated impact claims.
- Fresh account role and active class/enrolment checks, auditing and 30 AI requests per teacher per UTC day.

## Operational limits and remaining agreed roadmap

The newer connected Learning Studio at `/teacher/learning` extends this implementation; see [Connected Study Studio](connected-study-studio.md).

- Learning Studio now adds reviewed PDF/image OCR and DOCX/PPTX text extraction to this shared resource library. Audio/video and other unsupported formats remain attachments; see its documented extraction limits.
- Malware scanning is not implemented. The UI discloses this; binary uploads are never executed or previewed. Add a quarantine/scanning service before untrusted large-scale sharing.
- Data is stored in the existing database (LONGTEXT on MySQL). Back up the new teaching_* tables alongside the main database. MySQL max_allowed_packet must accommodate a base64-encoded 6 MiB file plus query overhead (at least 12 MiB recommended). Storage usage includes private/shared resources and archived classrooms.
- No automatic file deletion or resource quota upgrade is included.
- AI tests use a stub response, not a paid/live provider. Provider readiness and generated-content quality require deployment validation.
- Parent drafts use teacher-provided facts; guardian linking, consent, scheduled reports and message delivery remain to be built.
- Catch-up drafts here publish as class notes. Learning Studio adds individually targeted packs and staged follow-up checks.
- Existing question analysis/reteach and grading review remain available. Learning Studio adds latest-check concept evidence and matched starting/follow-up scores, with explicit measurement limits.
- The impact export covers one authorized classroom. Sponsor access, school-level aggregates, pilot cohorts and measured teacher time saved remain to be built.
- Academic-year promotion, transfer and teacher-replacement workflows remain on the agreed roadmap.
- SES/OTP signup remains deferred as requested; no email settings were changed.
- This change has not been pushed or deployed. No production data was used for verification.

## Validation

Full isolated SQLite regression suite: 163 tests, 161 passed, 2 existing skips.
New integration test covers private/shared downloads, outsider and blocked-student denial,
revoked teacher roles, invalid file names, empty files, unknown AI source formats,
roster/date validation, private parent drafts, publishing retries and aggregate privacy.
Local browser check: teacher login, Teaching Studio navigation, narrow mobile layout,
and attendance save/reload. Production MySQL and real AI provider calls are unverified.

## October 2026 integrity audit

A class code now creates a pending co-teacher request. Only the classroom owner can approve or reject it in Teaching Studio. Approval grants the subject-teacher role; client-provided owner roles are ignored. Rejected requests can be submitted again. All teacher routes verify the account's live database role, and deleted accounts lose access immediately. Homework submission requires an active class and an assigned (published) task. Account deletion includes Teaching Studio records and teacher join requests. Mobile navigation now fits below the header so logout remains reachable.

Current full-suite results and remaining deployment limits are recorded in `audit-2026-10-01.md`.
