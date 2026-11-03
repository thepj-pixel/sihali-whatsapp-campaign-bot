# Operations and Feature Status

| Area | Status | Verification |
|---|---|---|
| Voter lookup and disambiguation | Working | Local lookup and burst suite |
| Voter JPG card generation | Working | Render and cache assertions |
| Casual conversation routing | Working | 50-message simulation |
| Consent state machine | Working | Production workflow suite |
| Single-line contact card | Working | Production workflow suite |
| Context repetition guard | Working | Production workflow suite |
| Consent-only proactive follow-up | Working | Production workflow suite |
| Daily media upload | Working; live Git credentials required | Allowlist and asset checks |
| Daily schedule editing | Working | Dashboard/API and schedule validation |
| Live WhatsApp delivery | Requires operator test | Never exercised by automated tests |

## Operating rules

1. Automated outreach requires explicit accepted consent.
2. A rejection disables automated outreach. Re-enrolment must be initiated explicitly by the contact.
3. Each WhatsApp line sends only its own contact number in the vCard.
4. Automated tests use mocks and must not send live WhatsApp messages.
5. Every release updates `CHANGELOG.md`, this status table, and the production workflow test.
