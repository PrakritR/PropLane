# QA + product vision session — cursor-1 (2026-09-04)

**Sandbox:** http://localhost:3010 · `@test.proplane.local` accounts

---

## Product vision tickets (captain long-term goal)

**Manifest:** `docs/linear/manifests/product-vision-roadmap-2026-09-04.md`

**Batch:** `bash scripts/linear-file-vision-roadmap-batch.sh`

| Range | Theme |
| --- | --- |
| PRP-264, PRP-297 | Text-first operations + WO-number SMS |
| PRP-265–267, PRP-279 | SMS automation + event bus (under PRP-102) |
| PRP-268–270, PRP-272–273, PRP-283 | AI assistant depth + quality gates |
| PRP-274–278 | Platform-only payments + profitability |
| PRP-277 | Admin service-fee override (launch: no PropLane markup) |
| PRP-280–282 | SaaS webhooks + business model |

**Agent smoke:** 6559 unit tests passed including `create_work_order`, `report_maintenance_issue`, confirm gate.

**Manual assistant checklist:** `docs/agents/portal-full-qa-script.md` §6 (PRP-283).

---

## Portal QA coverage

| Pass | Script | Result |
| --- | --- | --- |
| Route sweep | `npm run qa:portal-audit` | Done (earlier session) |
| Deep interactions | `npm run qa:portal-deep` | Done |
| Exhaustive (all tabs × 4 portals + public) | `qa-exhaustive-portal-audit.mjs` | **197 signals**, 5 novel filed PRP-298–302 |
| Supplementary (financials, admin UI) | `qa-supplementary-portal-audit.mjs` | 2 novel (admin inbox filters PRP-258, accounts CTA) |

**Exhaustive manifest:** `docs/linear/manifests/qa-exhaustive-2026-09-04.md`

**Screenshots:** `docs/linear/qa-screenshots/2026-09-04/`

### Novel QA tickets this session (deduped)

PRP-214–222 (listings + seed), PRP-234–250 (resident auth noise), PRP-258, PRP-298–302.

### Still manual (not automated)

Per `docs/agents/portal-full-qa-script.md`:

- Add-property wizard publish end-to-end
- Invite vendor → bid → complete WO → payout
- Approve application → lease send → resident sign → pay rent (Stripe test)
- Assistant live prompts on all three portals (needs `ANTHROPIC_API_KEY`)
- Mobile 390px walkthrough per section

---

## Mobile UX (phase 2 — after desktop website)

**Captain order:** finish **desktop website** first; mobile web at 390px is phase 2; native app phase 3.

| Item | Status |
| --- | --- |
| `npm run qa:mobile` script | Added — `scripts/qa-mobile-portal-audit.mjs` |
| Mobile audit run | **Blocked** — sign-in lands on `/auth/continue` hang ([PRP-223](https://linear.app/axishousing/issue/PRP-223)) |
| Tickets filed | [PRP-303](https://linear.app/axishousing/issue/PRP-303), [PRP-304](https://linear.app/axishousing/issue/PRP-304) (re-run after PRP-223) |
| Epic (file when API allows) | `[Epic] Mobile UX phase 2 — all portals at 390px` — draft in `docs/linear/manifests/product-vision-roadmap-2026-09-04.md` |

Manifest: `docs/linear/manifests/qa-mobile-2026-09-04.json`

**After PRP-223 fix:** `PLAYWRIGHT_BASE_URL=http://localhost:3010 npm run qa:mobile -- --file-tickets`

---

## Commands

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3010 node scripts/qa-exhaustive-portal-audit.mjs --file-tickets
PLAYWRIGHT_BASE_URL=http://localhost:3010 node scripts/qa-supplementary-portal-audit.mjs --file-tickets
npm run linear:triage
```
