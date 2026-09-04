# Linear ticket batch — cursor-1 (2026-09-03)

Captain session work sorted into **10 — Listings & Properties**. File tickets
**before** any Lavish plan (`workflow:plan` / `lavish:plan`).

**Backlog sort (all tickets):** Project → Priority → Assignee. See
`docs/linear-ticket-system.md` → **Priority & backlog sort**.

## Blocker

`LINEAR_API_KEY` is not in this worktree’s `.env.local`. Add it from
https://linear.app/settings/api then run:

```bash
bash scripts/linear-file-cursor1-sep3-batch.sh
npm run linear:triage   # normalize open backlog (PRP-185–196 + new tickets)
```

Preview payloads without creating:

```bash
bash scripts/linear-file-cursor1-sep3-batch.sh --dry-run
```

---

## Section A — Pricing & rooms (fee logic — not built yet)

| # | Title | Milestone | Priority | Status on cursor-1 |
| --- | --- | --- | --- | --- |
| A1 | [Listings] Gate MTM and Custom surcharge rows on lease lengths | Pricing & rooms | **Medium** | **Planned** (DRAFT Lavish only) |
| A2 | [Listings] Bill OTHER FEES only when fee checkbox is enabled | Pricing & rooms | **High** (billing bug) | **Planned** |
| A3 | [Listings] Default OTHER FEES + remove rollover MTM checkbox | Create wizard* | **Low** | **Planned** |

\*A3 is pricing UX but lives on Create wizard step — filed under **Create wizard**
milestone per folder map (wizard step cleanup).

**Lavish:** one plan per ticket **after** PRP-### exists. Suggested grouping:
optional single epic parent if captain wants one board card for “Pricing step
overhaul”.

Assets already copied for A1–A3:

- `.lavish/plans/DRAFT-lease-fee-gating/assets/lease-lengths.jpg`
- `.lavish/plans/DRAFT-lease-fee-gating/assets/other-fees.jpg`

When filing A1, rename folder to `PRP-###-lease-fee-gating` and attach images
on `lavish:plan -- --image …`.

---

## Section B — Create wizard (UI — largely implemented on cursor-1)

| # | Title | Milestone | Priority | Status on cursor-1 |
| --- | --- | --- | --- | --- |
| B1 | [Listings] Bathroom step — fixtures, no whole-house, no auto type | Create wizard | **Low** | **Implemented** — verify + close |
| B2 | [Listings] Wizard ADD rows — rooms, bathrooms, shared spaces | Create wizard | **Low** | **Implemented** — verify + close |

---

## Existing backlog triage (screenshot 2026-09-03)

Run `npm run linear:triage` after the API key is set. Expected sort:

| P | ID | Project | Assignee | Title (short) |
| --- | --- | --- | --- | --- |
| High | PRP-187 | 02 Manager | M | Signup hangs on “Creating…” |
| High | PRP-189 | 02 Manager | M | Login error only — no signup path |
| High | PRP-193 | 02 Manager | M | Two signup doors / divergent APIs |
| Medium | PRP-196 | 02 Manager | M | Sign-in email case-sensitive |
| Medium | PRP-186 | 02 Manager | M | Hub signup missing phone |
| Medium | PRP-195 | 01 Infra or 02 | M | Ghost properties after DB wipe |
| Medium | PRP-192 | 01 Infra | M | No supported account deletion |
| Low | PRP-188 | 02 Manager | M | Google sign-in message on optional step |
| Low | PRP-184 | 12 Marketing / UI | M | UI audit contrast findings |
| Low | PRP-185 | 02 Manager | M | Rename manager-* → pro-* |
| Low | PRP-190 | 01 Infra | M | seed:dev prunes agents |
| Low | PRP-191 | 01 Infra | M | Playwright MCP allowed-origins |
| Low | PRP-194 | 01 Infra | M | Port-per-lane Next dev server |

---

## After all tickets exist

Do **not** run `npm run workflow:plan` until every row above has a **PRP-###**.

Then per ticket:

```bash
npm run lavish:plan -- --ticket PRP-### --title "…" --summary "…" [--image path]
npm run linear:export -- --ticket PRP-### --out .lavish/plans/PRP-###-slug/ticket.md
```

Captain says **approved — build** per ticket (A1–A3 still need implementation).

---

## Filed issues (2026-09-04)

| Ticket | Section | Priority | Linear URL |
| --- | --- | --- | --- |
| PRP-218 | A1 | Medium | https://linear.app/axishousing/issue/PRP-218 |
| PRP-219 | A2 | High | https://linear.app/axishousing/issue/PRP-219 |
| PRP-220 | A3 | Low | https://linear.app/axishousing/issue/PRP-220 |
| PRP-221 | B1 | Low | https://linear.app/axishousing/issue/PRP-221 |
| PRP-222 | B2 | Low | https://linear.app/axishousing/issue/PRP-222 |

QA audit tickets: PRP-214–217 — see `qa-session-cursor1-2026-09-04.md`
