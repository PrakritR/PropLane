# Three-agent sprint — open Linear backlog (2026-09-04)

**Goal:** Divide the **23 open PRP tickets** across **cursor-1**, **cursor-2**, and **claude-1**; land shippable slices on each keeper branch; promote all three to **`prakrit`** (http://localhost:3000).

**Coordination epic (done):** [PRP-171](https://linear.app/axishousing/issue/PRP-171) — lane ownership lives in `docs/agents/manual-qa-audit-2026-09-04.md`.

---

## Agent lanes (do not cross without captain OK)

| Agent | Branch | Port | Owns |
| --- | --- | --- | --- |
| **Cursor 1** | `cursor-1` | 3010 | Resident portal: apply, lease, payments, services, documents, browse |
| **Cursor 2** | `cursor-2` | 3011 | Manager portal: onboarding, properties wizard, calendar/tours, co-manager, dashboard |
| **Claude 1** | `claude-1` | 3012 | Communication/inbox, SMS/email, applications approval, vendor, admin |

**Rules**

1. Ticket → `npm run workflow:plan` → captain **`approved — build`** before code.
2. Commit only on your keeper branch; never push feature branches.
3. Comment on your ticket when you start/finish; add `agent:cursor-1` (etc.) in the Linear description.
4. Before starting work: `bin/fm-prakrit-sync-agent-branches.sh <your-branch>` so you branch from latest `prakrit`.
5. No production writes; dev/test Supabase only.

---

## Reality check: 23 tickets ≠ one session

| Bucket | Count | Notes |
| --- | ---: | --- |
| **Epics / platform** | 4 | PRP-264, 274, 279, 282 — multi-week; split into child tickets as work starts |
| **SMS + AI surfaces** | 9 | PRP-265–271, 297, 268, 270, 272, 273 — sequence after comms/payments foundations |
| **Payments slice** | 4 | PRP-275–278 — resident checkout, vendor payout, admin fees, manager dashboard |
| **Vendor / admin** | 2 | PRP-254, 257 |
| **UI audit parent** | 1 | PRP-184 — parent; ship as **11 child fixes** (see below) |
| **Manager auth** | 1 | PRP-193 — one coherent signup surface |
| **Low polish** | 1 | PRP-269 |

**Sprint 1 target (shippable this week):** 6–8 concrete tickets below. Epics stay open until children are filed and done.

---

## Ticket assignment (full backlog)

### Cursor 2 — manager (`cursor-2` :3011)

| PRP | Priority | Title | Sprint |
| --- | --- | --- | --- |
| **193** | High | Unified manager signup (one form, one API) | **Sprint 1 — primary** |
| **278** | High | Manager profitability dashboard | Epic child — after payments bus |
| **267** | High | SMS manager digest | After PRP-279 event bus |
| **270** | High | AI payment reminders / charge actions | After payments path stable |
| **184** | High | UI audit — manager slices: list chrome (#5–8), loading (#10), nested controls on property/tours (#1) | Sprint 1 — pick 2–3 findings |

### Cursor 1 — resident (`cursor-1` :3010)

| PRP | Priority | Title | Sprint |
| --- | --- | --- | --- |
| **275** | High | Residents pay only through PropLane checkout | **Sprint 1 — primary** (scoped slice) |
| **268** | High | AI resident WO lifecycle tools | Sprint 2 |
| **269** | Low | AI resident maintenance + photos | Sprint 2 |
| **184** | High | UI audit — resident: contrast (#2), nested controls on dashboard (#1), scroll regions (#4) | Sprint 1 — contrast + dashboard nested buttons |

### Claude 1 — comms / vendor / admin (`claude-1` :3012)

| PRP | Priority | Title | Sprint |
| --- | --- | --- | --- |
| **254** | High | Vendor multi-manager invoicing | **In progress** (2 commits ahead of prakrit) |
| **193** | — | — | **Do not touch** — cursor-2 |
| **265** | High | SMS: resident texts → create WO | Sprint 1 after 254 lands |
| **266** | High | SMS rent reminders + pay link | Sprint 2 |
| **271** | High | Vendor SMS completion loop | Sprint 2 |
| **297** | High | SMS reply with WO number | Sprint 2 |
| **276** | High | Vendor invoice → Connect payout | Sprint 2 (pairs with 254) |
| **277** | High | Admin platform fee controls | Sprint 2 |
| **257** | High | Admin pricing/fees/limits config | Sprint 3 |
| **184** | High | UI audit **#11 first** — `/admin/communication/schedule` soft-404 | **Sprint 1 — ship first** (correctness) |

### Shared / infra (file child ticket; any lane by area)

| PRP | Owner lane | Notes |
| --- | --- | --- |
| **273** | Infra / AI | Langfuse regression for denied proposals — no portal UI |
| **279** | Claude 1 | Action event bus — blocks SMS fan-out |
| **280** | Infra | SaaS webhooks API |
| **274** | Epic parent | Platform-only payments — children 275–278 |
| **264** | Epic parent | Text-first ops — children 265, 297, … |
| **282** | Growth | Pricing tiers — after 277 |

---

## PRP-184 child split (file as you pick up)

| # | Finding | Agent |
| ---: | --- | --- |
| 11 | Admin schedule soft-404 | **claude-1** (do first) |
| 2 | Colour contrast (home + sign-in) | **cursor-1** (public) + **cursor-2** (portal chrome) |
| 1 | Nested interactive controls | **cursor-1** resident dashboard; **cursor-2** tours/property |
| 4 | Scroll regions without keyboard entry | Split by surface |
| 5–10 | List chrome, header priority, tabs, detail nav, disclosure, skeletons | **cursor-2** (manager lists) primary |

---

## Sprint 1 — start here (parallel, low merge conflict)

| Agent | Ticket | First command |
| --- | --- | --- |
| **claude-1** | PRP-184 #11 + finish **PRP-254** | Promote existing vendor commits; then `workflow:plan --ticket PRP-184` |
| **cursor-2** | **PRP-193** | `npm run workflow:plan -- --ticket PRP-193` |
| **cursor-1** | **PRP-275** (checkout slice) or PRP-184 #2 resident contrast | `npm run workflow:plan -- --ticket PRP-275` |

Each agent works **only in their worktree** until promote.

---

## Promote ladder → `prakrit`

Merge **one branch at a time** (fast-forward merge script). After each promote, other agents sync.

**Recommended order (least cross-lane conflict):**

1. **claude-1** — vendor/admin/comms routes (`pro-vendors`, inbox, admin) — *has unpromoted work now*
2. **cursor-2** — auth/signup, manager UI, calendar
3. **cursor-1** — resident payments, resident UI

```bash
# After each lane is reviewed on its port:
bin/fm-proplane-promote-to-prakrit.sh claude-1
bin/fm-prakrit-sync-agent-branches.sh cursor-2
bin/fm-prakrit-sync-agent-branches.sh cursor-1

bin/fm-proplane-promote-to-prakrit.sh cursor-2
bin/fm-prakrit-sync-agent-branches.sh cursor-1
bin/fm-prakrit-sync-agent-branches.sh claude-1

bin/fm-proplane-promote-to-prakrit.sh cursor-1
```

**Done when:** `origin/prakrit` contains all three keeper tips; open Linear tickets moved to Done or split children filed.

---

## Current branch state (2026-09-04 PM)

| Branch | vs `origin/prakrit` | Notes |
| --- | --- | --- |
| `cursor-1` | ✅ aligned | Move-in + Services header shipped (`62ddbd68`) |
| `cursor-2` | ✅ aligned | |
| `claude-1` | ⬆️ **2 commits ahead** | PRP-254 vendor decline + multi-manager invoicing — **promote first** |

---

## Status log (update as you go)

| Agent | Ticket | Status |
| --- | --- | --- |
| cursor-1 | PRP-275 | **Done** — on `prakrit` |
| cursor-1 | PRP-184 #1 + #2 | **In progress** — resident nested controls + public/auth contrast |
| cursor-2 | PRP-193 | **Done** — on `prakrit` |
| claude-1 | PRP-254 | **Done** — on `prakrit` |
| claude-1 | PRP-192 | **Done** — account deletion script on `prakrit` |
| claude-1 | PRP-184 #11 | **Next** — admin schedule soft-404 |

---

## Agent handoff — paste into each pane (2026-09-04 PM)

### All agents — before you touch code

```bash
bin/fm-prakrit-sync-agent-branches.sh <your-branch>   # cursor-1 | cursor-2 | claude-1
```

Read this file: `docs/linear/manifests/agent-sprint-2026-09-04.md`

**Do not skip:** ticket → `npm run workflow:plan` → captain **`approved — build`** → code on your keeper branch only → promote when captain says merge.

---

### Cursor 1 (`cursor-1` · http://localhost:3010)

**Your ticket:** [PRP-275](https://linear.app/axishousing/issue/PRP-275) — resident PropLane checkout (Sprint 1 slice)

**Plan (review / approve):**
```bash
npx -y lavish-axi /Users/prakrit/firstmate/projects/proplane-cursor-branch-1/.lavish/plans/PRP-275-payments-resident-proplane-checkout-slice/plan.html
```

**After approval:** build on `cursor-1`, test resident pay flow on **3010**, then tell captain to run:
```bash
bin/fm-proplane-promote-to-prakrit.sh cursor-1
```

**Do not work on:** PRP-193 (cursor-2), vendor/SMS/admin (claude-1).

---

### Cursor 2 (`cursor-2` · http://localhost:3011)

**Your ticket:** [PRP-193](https://linear.app/axishousing/issue/PRP-193) — unified manager signup (one form, one API)

**Plan (review / approve):**
```bash
npx -y lavish-axi /Users/prakrit/firstmate/projects/proplane-cursor-2/.lavish/plans/PRP-193-manager-unified-signup-one-form-one-api/plan.html
```

**After approval:** build on `cursor-2`, test both `/auth/create-account` and `?role=manager` on **3011**, then:
```bash
bin/fm-proplane-promote-to-prakrit.sh cursor-2
```

**Do not work on:** resident payments (cursor-1), vendor inbox (claude-1).

---

### Claude 1 (`claude-1` · http://localhost:3012)

**Done:** [PRP-254](https://linear.app/axishousing/issue/PRP-254) vendor invoicing + offer decline → **on prakrit** (`1eb0db93`). Sync your sandbox:

```bash
bin/fm-prakrit-sync-agent-branches.sh claude-1
```

**Next ticket:** [PRP-184](https://linear.app/axishousing/issue/PRP-184) finding **#11** — `/admin/communication/schedule` soft-404 (ship before other audit items)

**Start:**
```bash
npm run workflow:plan -- --ticket PRP-184 --title "[Admin] Fix schedule soft-404" --summary "PRP-184 item 11 only"
```

**After approval:** build on `claude-1`, verify admin Communication routes on **3012**, promote when captain asks.

**Then queue:** PRP-265 (SMS → create work order) — only after #11 ships.

**Do not work on:** PRP-193, PRP-275.

---

### Captain — promote order (remaining)

1. ~~claude-1~~ ✅ merged (`1eb0db93`)
2. **cursor-2** after PRP-193 approved + built
3. **cursor-1** after PRP-275 approved + built

Say **`approved — build`** per plan when ready for each lane.

