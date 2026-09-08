# Portal QA audit — cursor-1 (2026-09-06)

**Base URL:** http://localhost:3000

**Accounts:** manager / resident / vendor @test.proplane.local

**Script:** `node scripts/qa-full-portal-audit.mjs`

## Summary

- Total findings: 25
- Novel (file tickets): 25
- Likely duplicate of existing PRP: 0

## Novel findings

| Sev | Portal | Path | Title | PRP |
| --- | --- | --- | --- | --- |
| medium | manager | `/portal/leases` | Leases: console error |  |
| high | manager | `/portal/residents/current` | Residents: session lost — bounced to sign-in |  |
| medium | manager | `/portal/payments/incoming/pending` | Payments incoming: console error |  |
| medium | manager | `/portal/bookings` | Bookings: console error |  |
| high | manager | `/portal/communication/active` | Communication: session lost — bounced to sign-in |  |
| medium | manager | `/portal/teams/managers` | Teams managers: console error |  |
| medium | manager | `/portal/documents/library` | Documents library: console error |  |
| high | manager | `/portal/documents/templates` | Documents templates: session lost — bounced to sign-in |  |
| medium | manager | `/portal/bugs-feedback` | Feedback: console error |  |
| medium | manager | `/portal/app` | App: console error |  |
| high | manager | `/portal/profile` | Settings: session lost — bounced to sign-in |  |
| medium | manager | `/portal/properties` | Properties: ADD row missing |  |
| low | manager | `/portal/properties` | Properties: no seeded rows visible |  |
| medium | resident | `/resident/dashboard` | Dashboard: console error |  |
| medium | resident | `/resident/tour` | Tour: console error |  |
| medium | resident | `/resident/applications` | Applications: console error |  |
| medium | resident | `/resident/lease` | Lease: console error |  |
| medium | resident | `/resident/payments` | Payments: console error |  |
| medium | resident | `/resident/payments/pending` | Payments pending pill: console error |  |
| medium | resident | `/resident/services` | Services: console error |  |
| medium | resident | `/resident/move-in` | House details: console error |  |
| medium | resident | `/resident/communication/active` | Communication: console error |  |
| medium | resident | `/resident/documents/application` | Documents application: console error |  |
| high | vendor | `/vendor/dashboard` | Dashboard: session lost — bounced to sign-in |  |
| medium | vendor | `/vendor/work-orders` | Services: console error |  |

