# Operations and Feature Status

| Area | Status | Verification |
|---|---|---|
| Voter lookup and disambiguation | Working | Local lookup and burst suite |
| Voter JPG card generation | Working | Render and cache assertions |
| Casual conversation routing | Working | 50-message simulation |
| Consent state machine | Working | Production workflow suite |
| Single-line contact card | Working | Production workflow suite |
| Context repetition guard | Working | Production workflow suite |
| Structured conversation context | Working | Topic/concern/follow-up assertions |
| Editable verified facts and talking style | Working | Dashboard/API and prompt integration |
| Consent-only proactive follow-up | Working | Production workflow suite |
| Context-aware proactive follow-up | Working | Production workflow suite |
| Automatic daily-goal progress | Working | Unique consented-contact tracking |
| Daily media upload | Working; live Git credentials required | Allowlist and asset checks |
| Daily schedule editing | Working | Dashboard/API and schedule validation |
| Live WhatsApp delivery | Requires operator test | Never exercised by automated tests |

## Operating rules

1. Automated outreach requires explicit accepted consent.
2. A rejection disables automated outreach. Re-enrolment must be initiated explicitly by the contact.
3. Each WhatsApp line sends only its own contact number in the vCard.
4. Automated tests use mocks and must not send live WhatsApp messages.
5. Every release updates `CHANGELOG.md`, this status table, and the production workflow test.

## Deploy the production-readiness branch on the VM

```bash
cd /home/patrikryian/sihali-whatsapp-campaign-bot
git fetch origin
git switch codex/production-readiness
git pull --ff-only origin codex/production-readiness
npm ci --omit=dev
DEPLOY_BRANCH=codex/production-readiness pm2 restart whatsapp-bot --update-env
pm2 save
curl -fsS http://127.0.0.1:3000/health
pm2 logs whatsapp-bot --lines 60 --nostream
pm2 logs tunnel --lines 30 --nostream
```

The final command prints the current public `https://...trycloudflare.com` dashboard URL. The tunnel address can change after a tunnel restart. Open that URL and enter the `CAMPAIGN_PIN` configured for the PM2 process. If no custom value is configured, the current application fallback is `2026`.

`sessions_auth/`, `user_memory.json`, `campaign_runtime.json`, and the operational logs are Git-ignored, so switching branches does not delete the VM's WhatsApp sessions or conversation state.
