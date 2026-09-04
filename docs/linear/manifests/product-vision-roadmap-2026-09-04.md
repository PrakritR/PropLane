# Product vision roadmap — Linear batch (2026-09-04)

Captain long-term goal: **text-first operations** (work order number drives actions),
**personal AI assistant** for manager / resident / vendor / landlord, **unified SaaS
messaging**, and **platform-only payments** (residents pay on PropLane; vendors paid
through Connect). **Launch assumption:** no PropLane service-fee markup — staff can
still override per manager in admin when needed (`resolveServiceFeePayerFor`).

## Existing epics / issues (do not duplicate)

| ID | Title |
| --- | --- |
| PRP-102 | [Epic] Unified messaging hub (SMS + email + in-app) |
| PRP-252 | Vendor Payments payer label bug |
| PRP-253 | Resident dead-end Pay when Connect incomplete |
| PRP-232 | SECURITY: ownerless work order write surface |

## Agent action smoke (2026-09-04)

Unit coverage run (no live LLM):

```bash
npm run test:unit -- tests/unit/tools/work-order-writes.test.ts \
  tests/unit/tools/resident-portal.test.ts \
  tests/unit/agent/loop-write-proposal.test.ts \
  tests/unit/agent/manager-inline-writes.test.ts \
  tests/unit/manager-sms-agent.test.ts
```

**Result:** 6559 tests passed — `create_work_order`, `report_maintenance_issue`,
`previewWriteTool` / confirm gate, manager SMS registry gating all green.

**Gaps** (file as implementation tickets): resident WO lifecycle, photos via chat,
payment reminder tools, text WO-number routing — see `docs/agents/agent-capability-backlog.md`.

## Batch script

`bash scripts/linear-file-vision-roadmap-batch.sh`

## Tickets filed (2026-09-04)

| ID | Title |
| --- | --- |
| PRP-264 | [Epic] Text-first operations — WO number drives actions |
| PRP-265 | [SMS] Resident texts maintenance → WO + notify |
| PRP-266 | [SMS] Automated rent payment reminders + pay link |
| PRP-267 | [SMS] Manager digest — needs attention |
| PRP-268 | [AI] Resident WO lifecycle tools |
| PRP-269 | [AI] Resident maintenance full fields + photos |
| PRP-270 | [AI] Manager payment reminders via confirm card |
| PRP-272 | [AI] Agent action quality gate — top-20 write tools |
| PRP-273 | [AI] Langfuse regression for denied proposals |
| PRP-274 | [Epic] Platform-only payments |
| PRP-275 | [Payments] Residents pay only through checkout |
| PRP-276 | [Payments] Vendor Connect payout single path |
| PRP-277 | [Admin] Platform service fee staff override |
| PRP-278 | [Payments] Manager profitability dashboard |
| PRP-279 | [Comm] Action event bus (child of PRP-102) |
| PRP-280 | [Infra] SaaS webhooks API |
| PRP-281 | [Growth] Unit economics model |
| PRP-282 | [Growth] Pricing tiers — AI + SMS caps |
| PRP-283 | [QA] Four-portal assistant manual test |
| PRP-297 | [SMS] Reply with WO number for status/actions (PRP-102) |

**Parent epic for messaging:** PRP-102 (existing).

---

## Mobile UX phase 2 (after desktop website)

Captain sequencing: **desktop website complete first**, then 390px mobile web, then native app.

- Script: `npm run qa:mobile` (`scripts/qa-mobile-portal-audit.mjs`)
- **Blocker:** [PRP-223](https://linear.app/axishousing/issue/PRP-223) `/auth/continue` hang — mobile audit cannot reach portal chrome until fixed
- Filed (preliminary): PRP-303, PRP-304 — re-run mobile audit after PRP-223
- Epic to file: `[Epic] Mobile UX phase 2 — all portals easy at 390px` (Linear API limit hit during session)

## QA continuation

After filing, run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3010 node scripts/qa-exhaustive-portal-audit.mjs --file-tickets
PLAYWRIGHT_BASE_URL=http://localhost:3010 node scripts/qa-supplementary-portal-audit.mjs --file-tickets
```

Screenshots: `docs/linear/qa-screenshots/2026-09-04/`
