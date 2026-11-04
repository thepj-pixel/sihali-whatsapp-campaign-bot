# Agent Takeover Guide

This document is the current technical handoff for the WhatsApp campaign bot. It supersedes deployment and status claims in `CAMPAIGN_BOT_MASTER_HANDOFF.md`; use that older file only for historical product context.

## Current source of truth

- Deployment branch: `codex/production-readiness`
- Runtime: Node.js, Express, Baileys, PM2, and Nginx
- Main entry point: `server.js`
- Dashboard port inside the VM: `3000`
- Dashboard PIN: `CAMPAIGN_PIN` environment variable; a built-in fallback is used if unset
- Permanent address: `PUBLIC_DASHBOARD_URL`; Nginx proxies port 80/443 to `127.0.0.1:3000`
- Voter database: `voters_cleaned.json`, containing 3,636 records
- Updated verified facts: `campaign_profile.json`
- Held claim: detailed interlocking/CC-road assertions must not be published until separately verified

The exact source commit for a transfer package is recorded in its `PACKAGE_MANIFEST.md`.

## Verified functionality

- Seven dashboard sections are wired and browser-tested: Live Voter Chat, Diagnostics, Poster Studio, AI Playground, WhatsApp CRM, Contacts/VCF/CSV, and Media Bank.
- Multi-line WhatsApp support: `sim_636`, `baba_aux`, and `canada`.
- Each WhatsApp line sends a contact card containing only its own phone number.
- TXT/MD/JSON/CSV fact-sheet import supports replace or append.
- VCF and quoted CSV contact import supports exact unique-name voter matching.
- Voter slip lookup and JPG generation use 3,636 tracked voter records.
- Context memory stores the latest topic, concern, question, consent state, and per-line chat history.
- Exact and near-duplicate replies are replaced with topic-aware navigation.
- A rejection disables automated outreach. Only an explicit later re-enrolment can restore it.
- Proactive messages are limited to consented contacts and reset when the person replies.
- Four configurable media schedule windows and a unique-contact daily-goal tracker are available.
- Linux checks `origin/$DEPLOY_BRANCH` every approximately 35 seconds and performs fast-forward-only auto-updates.

Run `npm run test:all` for the complete regression suite. Run `npm run test:production` for the faster deployment/dashboard suite.

## Important files

| File | Responsibility |
|---|---|
| `server.js` | Express dashboard, WhatsApp sessions, message routing, APIs, scheduling, and Linux updater |
| `ai_assistant_service.js` | Local response routing and external AI fallbacks |
| `engagement_policy.js` | Consent, opt-out, proactive eligibility, and per-line vCards |
| `conversation_context.js` | Structured topic, concern, question, and follow-up context |
| `reply_quality.js` | Repetition and near-duplicate detection |
| `campaign_profile.json/js` | Editable verified facts and conversation style |
| `campaign_agenda.js` | Daily talking points and four media slots |
| `contacts_manager.js` | VCF/CSV contacts and voter matching |
| `voter_engine.js` | Voter lookup and disambiguation |
| `voter_card_generator.js` | Voter-slip JPG generation and cache |
| `poster_engine.js` | Poster generation |
| `daily_goal.js` | Daily unique-contact goal and progress |
| `operations_tracker.js` | Operational event tracking |
| `deploy/nginx-whatsapp-bot.conf` | Permanent-domain/IP reverse proxy template |
| `OPERATIONS.md` | Deployment and domain instructions |
| `CHANGELOG.md` | Maintained release/change record |
| `DASHBOARD_TEST_REPORT.md` | Last dashboard interaction report |

## Runtime data not included in transfer packages

These files are deliberately machine-specific and must never be copied between agents or repositories:

- `.git/` and `node_modules/`
- `.env` and `api_config.json`
- `sessions_auth/` WhatsApp credentials
- `user_memory.json` live conversation state
- `campaign_runtime.json`, logs, message feeds, QR/session keys, and caches

On an existing VM, keep those files in place when updating code. On a new VM, WhatsApp lines must be linked again by scanning their QR pages.

## Required configuration

Copy `.env.example` to the environment manager or configure the values directly in PM2. Never commit real API keys or WhatsApp session credentials.

Minimum production values:

```text
PORT=3000
CAMPAIGN_PIN=<private dashboard PIN>
DEPLOY_BRANCH=codex/production-readiness
PUBLIC_DASHBOARD_URL=https://your-domain.example
NVIDIA_API_KEY=<provider key>
```

`GROQ_API_KEY` and `GEMINI_API_KEY` are optional fallbacks. `MEDIA_GIT_SYNC=false` and `PROFILE_GIT_SYNC=false` disable dashboard-originated Git pushes if the new environment should be read-only.

## VM deployment

```bash
cd /home/patrikryian/sihali-whatsapp-campaign-bot
git fetch origin
git switch codex/production-readiness
git pull --ff-only origin codex/production-readiness
npm ci --omit=dev
DEPLOY_BRANCH=codex/production-readiness pm2 restart whatsapp-bot --update-env
pm2 save
curl -fsS http://127.0.0.1:3000/health
```

For public access, configure DNS or the VM public IP with `deploy/nginx-whatsapp-bot.conf`, then set `PUBLIC_DASHBOARD_URL`. `127.0.0.1:3000` is reachable only from inside the same machine.

## First takeover checklist

1. Run `npm ci` and `npm run test:all` without live WhatsApp sending.
2. Confirm `/health` reports `mode: live` and inspect every session status.
3. Open the permanent public dashboard using the configured PIN and click all seven sections.
4. Verify that `sim_636` and `canada` are connected; scan `/scan/baba_aux` if the auxiliary line is `QR_READY`.
5. Use the AI Playground and mocked tests to review clarity, context, factual grounding, and repetition.
6. Perform any live delivery test only to an operator-owned number.
7. Confirm the voter database loads 3,636 records and that voter JPG generation works.
8. Review `campaign_profile.json` before publishing updated facts.
9. Record every material change in `CHANGELOG.md` and update `DASHBOARD_TEST_REPORT.md` after browser verification.

## Known operational state at packaging time

- The production branch includes the clean-VM voter database fallback.
- The latest supplied VM health output showed `sim_636` and `canada` connected and `baba_aux` waiting for a QR scan.
- That VM reported `publicDashboardUrl: null`; public dashboard access still requires Nginx plus an IP/domain and `PUBLIC_DASHBOARD_URL`.
- Old PM2 error logs can contain historical `Bad MAC`, missing `voters.json`, or pre-fix initialization errors. Judge current health using a fresh restart timestamp and new log lines.

## Boundaries for the next agent

- Do not fabricate facts, achievements, dates, voter records, or issue-resolution promises.
- Preserve explicit opt-outs and do not treat silence as permission.
- Do not run bulk or live-message tests against real voter numbers.
- Keep live secrets and WhatsApp session files out of Git and transfer archives.
- Preserve user-created runtime data during Git updates.
