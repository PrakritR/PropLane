# Prakrit - captain / integrate

Load this **in addition to** the root `AGENTS.md` when the person asking is
Prakrit (captain). Do not apply `AGENTS-akhil.md`.

Full pipeline: [`captain-dev-workflow.md`](captain-dev-workflow.md),
[`agent-tooling-index.md`](agent-tooling-index.md),
[`../share/proplane-collaborator-workflow.md`](../share/proplane-collaborator-workflow.md).

## Default pipeline

```
① LAVISH PLAN  →  ② ITERATE ON THE PLAN  →  ③ EXECUTE  →  ④ REVIEW  →  ⑤ PROMOTE
```

Visual board: `npm run lavish:workflow`.

**Every message from Prakrit becomes a Lavish plan before any product code.**
A bug, an idea, a screenshot, one line in chat — plan it and open it, even when
he did not ask for a plan.

```bash
npm run workflow:plan -- --chat "<his exact message>"
```

Reply with the `plan.html` path and one line on what it proposes, then **stop**
until he says **`approved — build`** (or `LGTM build` / `ship it`). No product
code before that.

Skip only on an explicit **`skip plan`** (hotfix).

### No tickets unless he asks

**Do not file Linear tickets for issues.** The plan is the artifact. File one
only on an explicit "file a ticket" / "log this in Linear", via
`npm run linear:ticket -- --chat "…"` (never Linear MCP; `LINEAR_API_KEY` lives
in `.env.local`). Everything else — described bugs, QA findings, screenshots —
becomes a plan.

### The plan quality bar

Full standard: [`lavish-plan-standard.md`](lavish-plan-standard.md). The
scaffold is a shell of `slot` placeholders; fill every one before he sees it.

| Tab | Must contain |
| --- | --- |
| Overview | today (verified in the running app) → after, in/out of scope |
| **UI** | the screen **mocked** in PropLane tokens — before/after, desktop/mobile, empty + loading + error |
| Build | file-by-file table, data/contract changes, order of work |
| Decide | open questions as pickable options, each with cost/benefit |
| Risks & tests | failure modes; real seeded data + edges, never `/demo` as proof |

The plan is the spec — **what it shows is exactly what gets built**. A departure
during build means updating `plan.html` and saying what moved.

It stays **editable and semi-interactive**: he rewrites any section in place and
presses *Queue my edits*; decision forms submit one answer; before/after and
desktop/mobile toggles let him check the screen without asking.

## Lavish chat (mandatory while a plan is open)

1. `npm run lavish:listen` right after opening (UI shows "listening")
2. `npm run lavish:poll` before ending the turn

Every later turn while `.lavish/active-session.json` exists: **first command**
is `npm run lavish:poll`. Apply his edits verbatim, re-open the same plan, and
answer him inside it:

```bash
npm run lavish:poll -- --reply "Applied — reload the plan"
```

After approval: `npm run lavish:poll -- --clear`.

Never tell Prakrit to annotate in Lavish unless you have polled at least once.
Never start a second plan for the same request.

UI work: put `docs/agents/ui-change-checklist.md` in the plan.

## Execute / review / status

- Keeper branch + sandbox port: local pane instructions, never hard-coded here.
- Build **what the plan shows**; a departure means updating `plan.html` first.
- Linear only when he asked for a ticket. Then: **In Progress** while coding,
  **Done** only on a whole-ticket fix with green `tsc` / unit on this tip, plus

```bash
npm run linear:comment -- --ticket PRP-### --sha <commit> --lane <keeper>
```

- Partial / parked: **Backlog**. Do not mark Done for a partial fix.
- Do not move a peer/captain-verified Done issue back to Backlog.

## Promote (Prakrit only)

Agents never run this. Prakrit does:

```bash
npm run ship:to-prakrit -- --source <keeper>
npm run ship:staging
npm run ship:production
```

`ship:to-prakrit` runs security review + no-mistakes, then opens
`http://localhost:3000` on `.proplane-review-path`.

Before production: `npm run ship:preflight`. After the production push, watch
the **iOS TestFlight** GitHub Action. Confirm `ASC_KEY_ID` / `ASC_ISSUER_ID` /
`ASC_KEY_P8` exist.

## Reviews on Prakrit work

Before finishing a feature branch or shipping: security-review + bugbot on the
branch diff, plus cache/rendering/perf when UI/routes changed, plus
web-native parity when portal/nav/push/routes changed. Fix high/critical
findings before ship.

**no-mistakes is in play for Prakrit.** Use it at the end of substantial work
unless he waives that named step.

## Captain-owned setup (cannot be done from the repo)

1. QA hostnames `staging-prop-lane.space` / `staging.prop-lane.space` on `staging`
2. GitHub Environments `preview` / `staging` / `production` protection
3. Branch protection on `main`, `staging`, and `production`

## Do not

- Write product code before **`approved — build`**
- File a Linear ticket he did not ask for
- Show him a plan whose UI tab describes the screen instead of drawing it
- End a turn with a plan open and no `npm run lavish:poll`
- Use Linear MCP or `cursor agent` for tickets
- Create tickets without project + milestone
- Put secrets in descriptions
- Skip TestFlight verification after a production push
- Use `/demo` as proof that production-like flows work
- Write production data, even when asked in chat
