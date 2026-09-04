# Portal QA audit — cursor-1 (2026-09-04)

**Base URL:** http://localhost:3010

**Accounts:** manager / resident / vendor @test.proplane.local

**Script:** `node scripts/qa-full-portal-audit.mjs`

## Summary

- Total findings: 30
- Novel (file tickets): 30
- Likely duplicate of existing PRP: 0

## Novel findings

| Sev | Portal | Path | Title | PRP |
| --- | --- | --- | --- | --- |
| medium | manager | `/portal/leases` | Leases: console error |  |
| medium | manager | `/portal/residents/current` | Residents: main content nearly empty |  |
| medium | manager | `/portal/residents/current` | Residents: console error |  |
| medium | manager | `/portal/tasks` | Tasks: console error |  |
| medium | manager | `/portal/calendar` | Calendar: console error |  |
| high | manager | `/portal/bookings` | Bookings: session lost — bounced to sign-in |  |
| medium | manager | `/portal/communication/active` | Communication: console error |  |
| medium | manager | `/portal/teams/vendors` | Teams vendors: console error |  |
| medium | manager | `/portal/promotion` | Promotion: console error |  |
| medium | manager | `/portal/financials/income` | Finances income: console error |  |
| medium | manager | `/portal/financials/expenses` | Finances expenses: console error |  |
| medium | manager | `/portal/financials/general-ledger` | Finances GL: console error |  |
| medium | manager | `/portal/documents/library` | Documents library: console error |  |
| medium | manager | `/portal/documents/templates` | Documents templates: console error |  |
| medium | manager | `/portal/bugs-feedback` | Feedback: console error |  |
| medium | manager | `/portal/app` | App: console error |  |
| medium | manager | `/portal/profile` | Settings: console error |  |
| medium | manager | `/portal/properties` | Properties: ADD row missing |  |
| low | manager | `/portal/properties` | Properties: no seeded rows visible |  |
| medium | resident | `/resident/dashboard` | Dashboard: console error |  |
| medium | resident | `/resident/tour` | Tour: console error |  |
| medium | resident | `/resident/applications` | Applications: console error |  |
| medium | resident | `/resident/lease` | Lease: console error |  |
| medium | resident | `/resident/payments` | Payments: console error |  |
| medium | resident | `/resident/payments/pending` | Payments pending pill: console error |  |
| medium | resident | `/resident/services` | Services: console error |  |
| medium | resident | `/resident/move-in` | House details: main content nearly empty |  |
| medium | resident | `/resident/move-in` | House details: console error |  |
| medium | resident | `/resident/communication/active` | Communication: console error |  |
| medium | vendor | `/vendor/calendar` | Calendar: console error |  |

