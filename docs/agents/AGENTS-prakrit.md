# Prakrit - captain / integrate

Load this **in addition to** the root `AGENTS.md` when the person asking is
Prakrit (captain). Do not apply `AGENTS-akhil.md`.

Full pipeline: [`captain-dev-workflow.md`](captain-dev-workflow.md),
[`agent-tooling-index.md`](agent-tooling-index.md),
[`../share/proplane-collaborator-workflow.md`](../share/proplane-collaborator-workflow.md).

## Default pipeline

```
① TICKET  →  ② PLAN + SHARE  →  ③ EXECUTE  →  ④ REVIEW  →  ⑤ PROMOTE
```

Visual board: `npm run lavish:workflow`.

Skip ① or ② only when Prakrit says **"no ticket"** or **"skip plan"** (hotfix).

```bash
npm run workflow:plan -- --chat "<their message>"
```

Reply with **PRP-###**, the Linear URL, the `plan.html` path, then **stop** until
he says **`approved - build`** (or `LGTM build` / `ship it`). Do not write
product code before that.

Ticket only: `npm run linear:ticket -- --chat "…"`. Do not use Linear MCP to
file. `LINEAR_API_KEY` lives in `.env.local`.

Priority: flow-breaking → High; cosmetic UI → Low unless unusable.
After a batch: `npm run linear:triage`. Title format:
`[Area] Short imperative - user-visible outcome`. Always add `portal:*`,
`area:*`, and Bug | Feature | Improvement. Full routing:
`docs/linear-ticket-system.md`.

## Lavish poll (mandatory while a plan is open)

After opening a plan:

1. `npm run lavish:listen` (background - UI shows "listening")
2. `npm run lavish:poll` before ending the turn

Every later turn while `.lavish/active-session.json` exists: **first command**
is `npm run lavish:poll`. After approval: `npm run lavish:poll -- --clear`.

Never tell Prakrit to annotate in Lavish unless you have polled at least once.

Share with a friend:

```bash
npm run linear:export -- --ticket PRP-### \
  --out .lavish/plans/PRP-###-slug/ticket.md
```

UI work: `docs/agents/ui-change-checklist.md` in the plan.

## Execute / review / status

- Keeper branch + sandbox port: local pane instructions, never hard-coded here.
- While coding the issue: Linear **In Progress**.
- Whole ticket + green `tsc` / unit on this tip: **Done**, plus

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

- Use Linear MCP or `cursor agent` for tickets
- Create tickets without project + milestone
- Put secrets in descriptions
- Skip TestFlight verification after a production push
- Use `/demo` as proof that production-like flows work
- Write production data, even when asked in chat
