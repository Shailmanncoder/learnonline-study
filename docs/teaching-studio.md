# Teaching Studio

Implemented in the existing Teacher Hub at `/teacher/studio`.

## Available now

- Teacher-owned active-class selector, classwork and pending-review counts.
- Links to the existing homework grading and worksheet analysis/reteach.
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

- Automatic PDF/image OCR and Office/media extraction are not implemented here. These formats upload and download as attachments. Use extracted text in the draft instructions for now.
- Malware scanning is not implemented. The UI discloses this; binary uploads are never executed or previewed. Add a quarantine/scanning service before untrusted large-scale sharing.
- Data is stored in the existing database (LONGTEXT on MySQL). Back up the new teaching_* tables alongside the main database. MySQL max_allowed_packet must accommodate a base64-encoded 6 MiB file plus query overhead (at least 12 MiB recommended). Storage usage includes private/shared resources and archived classrooms.
- No automatic file deletion or resource quota upgrade is included.
- AI tests use a stub response, not a paid/live provider. Provider readiness and generated-content quality require deployment validation.
- Parent drafts use teacher-provided facts; guardian linking, consent, scheduled reports and message delivery remain to be built.
- Catch-up drafts publish as class notes; individual assignment targeting and outcome-linked follow-up checks remain to be built.
- Existing question analysis/reteach and grading review are linked, not replaced. Longitudinal misconception tracking and before/after learning-gain measurement remain to be built.
- The impact export covers one authorized classroom. Sponsor access, school-level aggregates, pilot cohorts and measured teacher time saved remain to be built.
- Academic-year promotion, transfer and teacher-replacement workflows remain on the agreed roadmap.
- SES/OTP signup remains deferred as requested; no email settings were changed.
- Prepared for the updated-api branch. Production deployment is separate; no production data was used for verification.

## Validation

Full isolated SQLite regression suite on updated-api: 199 tests, 197 passed, 2 existing skips.
New integration test covers private/shared downloads, outsider and blocked-student denial,
revoked teacher roles, invalid file names, empty files, unknown AI source formats,
roster/date validation, private parent drafts, publishing retries and aggregate privacy.
Local browser check on the source checkout before branch transfer: teacher login, Teaching Studio navigation, narrow mobile layout,
and attendance save/reload. Production MySQL and real AI provider calls are unverified.
