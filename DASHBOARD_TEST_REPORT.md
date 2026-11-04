# Dashboard production test report

Date: 4 November 2026  
Mode: local `DASHBOARD_ONLY=true` (no WhatsApp connection and no message delivery)

## Browser-verified

| Section / workflow | Result |
|---|---|
| Live Voter Chat tab | Pass |
| Diagnostics & Self-Test Log tab | Pass |
| Live Poster Studio tab | Pass; poster preview generated and download control enabled |
| AI Playground & Lab tab | Pass; voter search returned ward, serial, EPIC, house and booth data |
| WhatsApp Web Live CRM tab | Pass; all/primary/baba/canada line filter works |
| Voter Contacts & VCF/CSV tab | Pass; contact rows render with voter-match status |
| Media Bank & Uploader tab | Pass; 41 active verified facts and one-click upload controls visible |
| Browser console | Pass; zero errors after repairs |

## Automated verification

- Production workflow assertions cover tab wiring, fixed-domain configuration, one-click facts parsing, quoted CSV, VCF, exact voter matching, contact-card isolation, near-duplicate replies, and daily schedules.
- Full conversation, engagement-ladder, readiness, and 300-message burst suites must pass before the release commit is pushed.

Live WhatsApp delivery is deliberately not exercised by automated tests. On the VM, send one operator-approved text, poster, video, contact card, and voter slip to a test phone from each connected line before contacting real voters.
