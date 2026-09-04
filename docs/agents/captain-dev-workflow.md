# Captain dev workflow (PropPlane)

Default pipeline for **every** agent pane (cursor-1, cursor-2, claude-1, codex-*).
The captain reviews plans in **Lavish** before any build.

## Phases (always in order)

```
① TICKET  →  ② PLAN (Lavish)  →  ③ BUILD  →  ④ REVIEW  →  ⑤ PROMOTE
```

| Phase | Agent does | Captain does |
| --- | --- | --- |
| **① Ticket** | Create Linear issue from chat (default) | Skim PRP-### in Linear |
| **② Plan** | Lavish HTML plan + images; **poll** for feedback | Review in browser; annotate; say **approved — build** |
| **③ Build** | Code on keeper or `test/<branch>-<slug>` | — |
| **④ Review** | Test on sandbox port; summarize | Review localhost + diff; say merge to prakrit or request changes |
| **⑤ Promote** | Run promote script when captain asks | Approve `prakrit` merge; sync updates all sandboxes |

**Do not skip ① or ②** unless the captain explicitly says **"no ticket"** or
**"skip plan"** (hotfix only).

---

## ① Ticket (Linear)

**Rule:** If the captain says anything that sounds like work, feedback, or a bug —
**create a ticket first**, even when they did not ask for one.

```bash
npm run linear:ticket -- --chat "<captain message>"
```

- Attach **PRP-###** + URL in chat.
- Route to numbered project + milestone (`docs/linear-ticket-system.md`).
- Link plan folder: `.lavish/plans/PRP-###-slug/`.

---

## ② Plan (Lavish)

Before writing product code:

1. `npx -y lavish-axi playbook plan` (and `comparison` / `diagram` if needed).
2. Scaffold:

```bash
npm run lavish:plan -- --ticket PRP-### --title "..." --summary "..." \
  --image /path/to/cursor-attachment.png --open
```

3. **Images from Cursor chat:** copy every captain attachment into the plan with
   `--image` (stored under `.lavish/plans/.../assets/`). Embed in HTML — do not
   only describe screenshots in prose.
4. Open: `npx -y lavish-axi .lavish/plans/PRP-###-slug/plan.html`
5. Poll until approval: `npx -y lavish-axi poll <plan.html>` (background OK).
6. Apply Lavish annotations; reply with `--agent-reply`.
7. **Stop polling and wait** until captain says **approved — build** (chat or Lavish).

Update the Linear ticket description with a link to the plan path when stable.

---

## ③ Build (branches)

### Keeper branch (default)

Each agent pane owns **one keeper branch** — never feature branches on `origin`.

| Pane | Branch | Port |
| --- | --- | --- |
| Cursor 1 | `cursor-1` | 3010 |
| Cursor 2 | `cursor-2` | 3011 |
| Claude 1 | `claude-1` | 3012 |
| Codex 1/2 | `codex-1` / `codex-2` | 3013 / 3014 |

Commit and push **only** to that keeper branch.

### Test / experiment branches (optional)

For throwaway spikes without polluting the keeper branch:

```bash
scripts/proplane-test-branch.sh start my-idea    # test/cursor-2-my-idea (local)
# … commits …
scripts/proplane-test-branch.sh finish           # merge → cursor-2, delete test branch
# or
scripts/proplane-test-branch.sh abort            # discard
```

Test branches stay **local** — do not push to GitHub unless captain explicitly asks.

---

## ④ Review (sandbox)

1. Run dev server on sandbox port (3011 for cursor-2).
2. Full happy path + edge cases (`docs/ship-gate.md` — not `/demo` alone).
3. Targeted `npm run test:unit`; smoke: `PLAYWRIGHT_SKIP_WEBSERVER=1 PLAYWRIGHT_BASE_URL=http://localhost:3011 npm run test:e2e:ladder-smoke`
4. Comment on Linear: what was tested, PRP link, localhost URL.
5. Tell captain: ready for review on **keeper branch** (not prakrit yet).

---

## ⑤ Promote (captain gate)

Captain reviews on keeper branch → approves merge to **prakrit** (integration).

```bash
# From firstmate (not inside agent worktree edits):
bin/fm-proplane-promote-to-prakrit.sh cursor-2
```

What happens:

1. Merges `origin/cursor-2` (etc.) **into** `prakrit`, pushes `prakrit`.
2. **`fm-prakrit-sync-agent-branches.sh --reset-from-prakrit`** resets **all**
   keeper sandboxes to match `origin/prakrit` so every agent starts from the same
   integration tip.

Captain then verifies **localhost:3000** (prakrit). Later: `main` → Vercel Preview,
then `production` when ready (`proplane-ladder` skill / `npm run ship:production`).

**Never** merge to `prakrit` without captain approval.

---

## Chat triggers

| Captain says | Phase |
| --- | --- |
| Anything describing work/bug/idea | ① Ticket (+ ask clarifying Q if needed) |
| After ticket created | ② Plan in Lavish |
| "approved — build" / "LGTM build" | ③ Build |
| "try a spike" / "experiment" | ③ on `test/<keeper>-<slug>` |
| "merge to prakrit" / "promote" | ⑤ Promote script |
| "no ticket" / "skip plan" | Skip that phase only |

---

## Files & rules

| Artifact | Path |
| --- | --- |
| Cursor rule (always on) | `.cursor/rules/captain-dev-workflow.mdc` |
| Linear filing | `.cursor/rules/linear-chat-tickets.mdc` |
| Linear folders | `docs/linear-ticket-system.md` |
| Branch ladder | firstmate skill `proplane-ladder` |
| Plan scaffold | `npm run lavish:plan` |
| Test branch | `scripts/proplane-test-branch.sh` |

---

## Subagents

Paste phases ①–③ constraints into every subagent brief (security-review, bugbot, explore).

## Production data (hard stop)

**Never write production data** — residents, properties, tasks, leases, charges,
messages, or any live records. Dev/test Supabase only unless the captain issues a
**named one-shot waiver**. See `.cursor/rules/no-production-data-writes.mdc` and
`no-production-live-listings.mdc`.
