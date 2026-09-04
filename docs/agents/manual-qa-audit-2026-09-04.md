# Manual QA audit — fresh dev, no seed (2026-09-04)

**Branch:** `cursor-2` · **URL:** http://localhost:3011  
**Data:** `ALLOW_DEV_WIPE=1 npm run wipe:test:all` — no re-seed; manual browser only.  
**Coordination epic:** [PRP-171](https://linear.app/axishousing/issue/PRP-171)

## Agent split (divide & conquer)

| Agent | Branch | Port | Owns | Linear assignee |
| --- | --- | --- | --- | --- |
| **Cursor 2** (this pane) | `cursor-2` | 3011 | Manager onboarding, properties wizard, calendar/tours, co-manager | File tickets; label `agent:cursor-2` in body |
| **Cursor 1** | `cursor-1` | 3010 | Resident: apply, lease, payments, services, documents | `agent:cursor-1` |
| **Claude 1** | `claude-1` | 3012 | Communication/inbox, applications approval, vendor, admin | `agent:claude-1` |

**Rules for all agents:**

1. **No production writes** — refuse even if captain asks (`no-production-data-writes.mdc`).
2. **No seed scripts** — manual browser only on your port.
3. Every friction → `npm run linear:ticket` + `npm run lavish:plan` → log row below.
4. Check this file + Linear before filing duplicates.
5. Comment on **PRP-171** when you start/finish a workstream.

## Cursor 2 log (manager + calendar)

| # | Issue | PRP | Lavish plan | Status |
| --- | --- | --- | --- | --- |
| 1 | Signup/get-started on :3011 redirects to :3010 after submit | [PRP-170](https://linear.app/axishousing/issue/PRP-170) | `.lavish/plans/PRP-170-fix-sandbox-port-redirect-on-manager-signup/plan.html` | Fixed — `resolveShareableAppOrigin` honors localhost port; `npm run sandbox:pin -- 3011` |
| 2 | `/auth/continue` ~55s spinner after password sign-in | [PRP-223](https://linear.app/axishousing/issue/PRP-223) | `.lavish/qa-handoff-2026-09-04.html` (QA-01) | **Fixed** — `isValidPostAuthDestination` whitelists `/auth/connect-google-services` |
| 3 | Calendar empty state hides week nav (e2e) | [PRP-224](https://linear.app/axishousing/issue/PRP-224) | `.lavish/qa-handoff-2026-09-04.html` (QA-02) | **Fixed** — compact calendar renders week nav without a storage key |
| 4 | Signed-in create-account pricing UI (no bordered callout) | PRP-171 note | — | **Verified fixed** on :3000 |
| 5 | PRP-184 admin comm flat-tab redirect | [PRP-184](https://linear.app/axishousing/issue/PRP-184) | — | **Verified fixed** |

## Cursor 1 log (resident + full portal QA 2026-09-04)

**Session:** `/goal` rigorous QA — manager, resident, vendor on **3010**.

| # | Issue | PRP | Status |
| --- | --- | --- | --- |
| 1 | Applications pending — no empty state | _pending API key_ | Batch script ready |
| 2 | Vendor calendar 403 | _pending API key_ | Batch script ready |
| 3 | Manager Listed tab empty (seed?) | _pending API key_ | Verify after `test:seed` |
| 4 | Listings fee gating A1–A3 + wizard B1–B2 | _pending API key_ | `linear-file-cursor1-sep3-batch.sh` |

**Manifest:** `docs/linear/manifests/qa-session-cursor1-2026-09-04.md`

## Cursor 1 log (resident)

_Pick up after PRP-171 — resident apply → lease → payments on **3010**._

| # | Issue | PRP | Lavish plan | Status |
| --- | --- | --- | --- | --- |
| 1 | Auth blockers (login 404, magic link hash, get-started spinner, signup sign-in lag, manager tier routing) | PRP-172–177 | — | **Fixed on `prakrit`** (`e3086e9b` / `980c84bb`) |
| 2 | DB wipe leaves ghost portal data in browser storage | PRP-178 | — | **Fixed** — `/auth/sign-in?clear_cache=1` on localhost + wipe script hint |
| 3 | Sandbox port drift breaks auth redirects | PRP-179 | — | **Mitigated** — `npm run sandbox:pin -- 3010` |

## Claude 1 log (comms / vendor / admin)

**Sprint handoff:** `docs/linear/manifests/agent-sprint-2026-09-04.md` (section **Claude 1**)

| # | Issue | PRP | Status |
| --- | --- | --- | --- |
| 1 | Vendor multi-manager invoicing + decline | PRP-254 | **On prakrit** (`1eb0db93`) — sync :3012 |
| 2 | Admin schedule soft-404 | PRP-184 #11 | **Next** — workflow:plan then build |

