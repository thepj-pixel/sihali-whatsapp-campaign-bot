# Campaign Bot Change Log

This file records code and operational changes. Runtime delivery events are written to
`operations_log.jsonl` and intentionally excluded from Git.

## Unreleased

### Added

- Production-readiness workstream and feature-status tracking.
- Testable consent and engagement policy helpers.
- Privacy-conscious operational event logging and dashboard status API.
- Persistent daily-goal settings stored outside the Git working tree.
- Editable four-slot media times in the dashboard.
- Allowlisted dashboard media uploads can sync back to Git on Linux production hosts.

### Changed

- Contact cards contain only the number of the WhatsApp line selected for sending.
- Proactive follow-ups are limited to contacts with explicit accepted consent.
- Permission is requested as a natural assistance question; silence receives at most one reminder.
- Repeated bot answers are replaced with a short context-aware navigation reply.

### Fixed

- Consent prompts now set the state required to process `1/2`, yes/no replies.
- Production tests now return a failing exit code when an assertion fails.

## Baseline takeover audit - 2026-11-03

- Voter database: 3,636 records loaded.
- Casual conversation simulation: 50/50 passed.
- Burst pipeline: zero runtime errors; measured approximately 762 requests/minute.
- Known baseline issue: the five-step test used stale Hindi-only assertions.
- Known baseline issue: documented readiness tests exited successfully despite failures.
