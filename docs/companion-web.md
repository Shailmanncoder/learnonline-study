# Companion web requests and conversation continuity

Explicit search/research requests and public HTTPS links take priority over the saved textbook or uploaded PDF. Follow-ups stay in that web conversation until the learner returns to a chapter/book. The latest 32 stored messages are replayed; this is bounded conversation context, not unlimited memory. All three provider paths save exchanges and receive retrieved reference context.

## Web access

Set BRAVE_SEARCH_API_KEY on the backend for full web search. The key stays server-side. The exact submitted query appears in request activity. Up to three search snippets are collected and the first result is opened. Without a key, the UI explicitly says it uses Wikipedia; AWS expands to Amazon Web Services, with that actual query displayed.

Public HTTPS links can be read without a search key. The reader pins a validated public DNS address, validates each redirect, allows three redirects, bounds response size to 512 KB and text to 10,000 characters, and times out requests. It does not sign in, execute JavaScript, read local/private networks, or browse interactively. Pages requiring JavaScript/sign-in and unreadable files report a limitation.

## Answer presentation

Real provider text is streamed into owner-scoped request progress and polled by the browser every 500 ms. The draft uses plain text and a reduced-motion-aware cursor; completed answers use the existing Markdown/math renderer. Activity records actual operations, not hidden model reasoning. Short-first instructions precede longer explanations. Provider retries clear abandoned draft text.

Progress currently lives in one server process; multiple workers need shared progress storage or sticky routing. Restarting the server loses in-flight progress but persisted conversations remain. Web-source text is untrusted reference data. Search snippets are labelled separately from pages read.

## Validation

Regression tests cover AWS topic switching, multi-turn continuation, return to a textbook, private-address rejection, failed retrieval honesty, owner-only progress, and mocked Groq/Gemini/OpenAI-compatible streaming plus source context and saved turns. A live local Gemini run and real Wikipedia/AWS page retrieval were also checked. No production deployment is implied by these checks.

## October 2026 audit changes

Reopened conversations return the newest 200 messages, in chronological order. Explicit preference extraction scans up to 200 user messages. Context remains bounded. Public request IDs are scoped by account and mapped to unique internal run handles, so another account reusing the same ID cannot overwrite or receive the first account's stream. AI Markdown is sanitized with the vendored DOMPurify build before insertion, including developer notes and code reviews; unavailable sanitization falls back to escaped text.
