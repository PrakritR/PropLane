# Prakrit - captain / integrate

Load this **in addition to** the root `AGENTS.md` when the person asking is
Prakrit (captain). Do not apply `AGENTS-akhil.md`.

Full pipeline: [`captain-dev-workflow.md`](captain-dev-workflow.md),
[`agent-tooling-index.md`](agent-tooling-index.md),
[`../share/proplane-collaborator-workflow.md`](../share/proplane-collaborator-workflow.md).

## Default pipeline

```
① LAVISH PLAN  →  ② EXECUTE  →  ③ REVIEW  →  ④ PROMOTE
```

Visual board: `npm run lavish:workflow`.

**Every request that changes code or UI starts as a Lavish plan.** Not a markdown
file, not a chat outline - an opened Lavish artifact he can click through and
annotate. Skip it only when he says **"skip plan"** / **"just do it"**, the ask is
a one-line factual answer, the work is read-only investigation, or it is an urgent
production fix. When in doubt, build the plan.

```bash
npm run workflow:plan -- --chat "<their message>"
```

Reply with the plan URL and the `plan.html` path, then **stop** until he says
**`approved - build`** (or `LGTM build` / `ship it`). Do not write product code
before that. He will iterate on the plan across several rounds first - that is
expected, not a sign the plan failed.

### The plan is the spec

Whatever the plan shows is exactly what gets built, so it has to be buildable as
drawn:

- **Real UI, rendered** in PropLane's own design system (its Tailwind config,
  tokens, and components) - the screen itself, never a description of it.
- **Semi-interactive**: tabs switch, modals open, rows select, empty / loading /
  error states are reachable by clicking. He has to feel the flow.
- **Before and after** for any change to an existing screen - screenshot the real
  page as it stands today and put it beside the proposal.
- **Options side by side with a recommendation** wherever a genuine decision
  exists; collect the choice in the artifact (`lavish-axi playbook input`).
- **The build contract**: files touched, schema/data changes, the edges that will
  be driven to prove it, and what is deliberately out of scope.
- Open every matching playbook before writing HTML
  (`npx -y lavish-axi playbook plan|comparison|input|diagram|table|code`).
- UI work: fold `docs/agents/ui-change-checklist.md` into the plan.

### Linear tickets are OFF by default

Do not file, open, or auto-create a Linear issue for a bug, a finding, or a
sweep result. Report it in chat or in the plan and fix or queue it there. This
overrides any skill or checklist step that says "file one ticket per finding" -
`npm run linear:ticket`, `linear:triage`, and the Linear MCP write tools are off
unless he asks for a ticket by name in that message. Reading, searching, and
commenting on existing issues stays fine, as does
`npm run linear:comment -- --ticket PRP-### --sha <commit> --lane <keeper>` when
he points at an existing ticket.

## Lavish poll - the chat only works if this is running

The plan's chat, annotations, and queued prompts reach the agent through the
poll and nowhere else. A plan opened without a live poll is a dead page: he
types into it and nothing happens. **Never end a turn with a plan open and no
poll running.**

After opening a plan:

1. `npm run lavish:listen` (background - UI shows "listening")
2. `npm run lavish:poll` before ending the turn

Every later turn while `.lavish/active-session.json` exists: **first command**
is `npm run lavish:poll`. After approval: `npm run lavish:poll -- --clear`.

Iterating is the normal case, not an exception:

- Apply his feedback by editing the **same** plan file, never a new one, so the
  URL he has open keeps working.
- Reply inside the browser where he is looking
  (`npx -y lavish-axi poll <file> --agent-reply "<what changed>"`), then poll
  again. Keep the loop open for as many rounds as he wants.
- Never end the session on your own initiative - he closes it, or it closes when
  the built work has shipped. If the poll is killed or times out, just re-run it;
  queued feedback is never lost.

Never tell Prakrit to annotate in Lavish unless you have polled at least once.

## Execute / review / status

- Keeper branch + sandbox port: local pane instructions, never hard-coded here.
- Status moves apply **only** when he pointed the work at an existing PRP ticket;
  otherwise there is no ticket and nothing to move (see *Linear tickets are OFF*).
- While coding that issue: Linear **In Progress**.
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
