# Campaign Bot Change Log

This file records code and operational changes. Runtime delivery events are written to
`operations_log.jsonl` and intentionally excluded from Git.

## Unreleased

### Added

- Seven-section dashboard smoke coverage, dashboard-only test mode, and CRM filtering by WhatsApp line.
- One-click `.txt`, `.md`, `.json`, or `.csv` verified-facts import with replace/append modes.
- Exact-name voter matching metadata for imported VCF/CSV contacts.
- Permanent-domain Nginx reverse-proxy template; temporary Cloudflare tunnels are no longer required.
- Structured conversation memory for the latest topic, concern, question, and unanswered bot question.
- Context-aware proactive follow-ups that refer to the voter's actual issue instead of rotating generic scripts.
- Dashboard editor and API for verified facts and the campaign talking pattern.
- Automatic unique-contact progress tracking for the daily goal (phone numbers are stored as short hashes).
- Configurable `DEPLOY_BRANCH` support for VM auto-updates.
- Production-readiness workstream and feature-status tracking.
- Testable consent and engagement policy helpers.
- Privacy-conscious operational event logging and dashboard status API.
- Persistent daily-goal settings stored outside the Git working tree.
- Editable four-slot media times in the dashboard.
- Allowlisted dashboard media uploads can sync back to Git on Linux production hosts.

### Changed

- Updated the live fact profile from the two 4 November parcha sheets; completed work and future commitments are explicitly separated, while held road-work details are excluded.
- Reply-quality checks now reject near-duplicate wording, not only byte-for-byte duplicates, and redirect to the saved conversation topic or concern.
- The default daily agenda now uses verified water, health, and issue-listening themes without held road-work claims.
- Contact imports now preserve contact-only records when there is no unique voter match.
- The voter-database contact action imports only records containing a real phone number; it never invents numbers.
- Dashboard diagnostics now read only the bot process logs.
- Live AI prompts now include the dashboard-managed verified facts, talking style, and structured voter context.
- A fresh voter reply resets that contact's proactive-follow-up sequence.
- VM updates use fast-forward Git merges from the configured deployment branch instead of overwriting the working tree.
- The VM updater restarts only when the remote branch is ahead, so a local dashboard commit cannot cause a restart loop.
- Contact cards contain only the number of the WhatsApp line selected for sending.
- Proactive follow-ups are limited to contacts with explicit accepted consent.
- Permission is requested as a natural assistance question; silence receives at most one reminder.
- Repeated bot answers are replaced with a short context-aware navigation reply.

### Fixed

- Removed the live `user_memory.json` database from Git tracking so VM deployments preserve conversation state and are no longer blocked by runtime memory changes.
- Repaired two inline dashboard-script syntax errors that prevented every non-default tab from opening.
- Added the missing contact-table HTML escaping helper that previously broke the Voter Contacts tab at runtime.
- CSV uploads are now parsed as CSV instead of being sent through the VCF-only parser.
- Consent prompts now set the state required to process `1/2`, yes/no replies.
- Production tests now return a failing exit code when an assertion fails.

## Baseline takeover audit - 2026-11-03

- Voter database: 3,636 records loaded.
- Casual conversation simulation: 50/50 passed.
- Burst pipeline: zero runtime errors; measured approximately 762 requests/minute.
- Known baseline issue: the five-step test used stale Hindi-only assertions.
- Known baseline issue: documented readiness tests exited successfully despite failures.
