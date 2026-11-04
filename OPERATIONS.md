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
| One-click fact-sheet upload | Working | TXT/MD/JSON/CSV replace/append tests |
| Seven dashboard sections | Working | In-app browser click test, 4 Nov 2026 |
| VCF/CSV contact import and voter matching | Working | Quoted CSV, VCF, exact-match assertions |
| Multi-line CRM filtering | Working | Browser selection test |
| Permanent domain through Nginx | Configuration ready | Requires domain and VM public IP |
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
```

After this first deployment, the Linux process checks `origin/$DEPLOY_BRANCH` every 35 seconds. When the remote branch is ahead it performs a fast-forward-only merge, runs `npm ci --omit=dev`, and restarts only `whatsapp-bot`. `autoupdate.sh` provides the same safe behavior for a manual run or an external watchdog; do not run a second daemon while the in-process watcher is active.

## Put the dashboard on one permanent domain (no Cloudflare tunnel)

1. In the domain provider, create an `A` record pointing the chosen dashboard hostname to the VM public IPv4 address.
2. On the VM, install Nginx: `sudo apt-get update && sudo apt-get install -y nginx`.
3. Copy `deploy/nginx-whatsapp-bot.conf` to `/etc/nginx/sites-available/whatsapp-bot` and replace `dashboard.example.com` with the real domain.
4. Enable it: `sudo ln -s /etc/nginx/sites-available/whatsapp-bot /etc/nginx/sites-enabled/whatsapp-bot`.
5. Validate and reload: `sudo nginx -t && sudo systemctl reload nginx`.
6. Set the public URL for PM2 and restart:

```bash
PUBLIC_DASHBOARD_URL=http://YOUR_DOMAIN DEPLOY_BRANCH=codex/production-readiness pm2 restart whatsapp-bot --update-env
pm2 save
```

Open the permanent domain and enter the `CAMPAIGN_PIN` configured for the PM2 process. If no custom value is configured, the application fallback is `2026`. The dashboard remains PIN-protected; no temporary tunnel process is required.

`sessions_auth/`, `user_memory.json`, `campaign_runtime.json`, and the operational logs are Git-ignored, so switching branches does not delete the VM's WhatsApp sessions or conversation state.

If a VM cloned an older revision where `user_memory.json` was still tracked, preserve it before the first switch with `cp user_memory.json /tmp/user_memory.json.vm-backup`, then restore that backup after switching branches.
