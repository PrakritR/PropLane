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
he did not ask for a plan. Not a markdown file, not a chat outline: an opened
Lavish artifact he can click through and annotate. Skip it only when he says
**"skip plan"** / **"just do it"**, the ask is a one-line factual answer, the
work is read-only investigation, or it is an urgent production fix. When in
doubt, build the plan.

```bash
npm run workflow:plan -- --chat "<his exact message>"
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
Never start a second plan for the same request.

## The agent system: astra → sol → terra + luna

Captain's standing structure for anything bigger than a one-file edit. The model
ladder is deliberate: **thinking is expensive, typing is not.** Spend the big
model where a wrong call compounds (the plan, the judgement) and the cheap model
where the work is mechanical and its output is checkable.

```
                    ┌──────────────────────┐
   the captain ───► │  astra    · fable    │   plan · owns the Lavish artifact
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │  sol      · opus     │   judge · owns the breakdown
                    └──────────┬───────────┘
                     ┌─────────┴─────────┐
          ┌──────────▼──────┐   ┌────────▼────────┐
          │ terra  · sonnet │   │ luna   · sonnet │
          │ build           │   │ prove           │
          └─────────────────┘   └─────────────────┘
```

| Agent | Model | Owns | Never does |
| --- | --- | --- | --- |
| **astra** | Fable | The captain's request end to end. Writes and iterates the Lavish plan, holds the build contract, is the **only** tier that speaks to the captain. | Write product code. Relay raw sub-agent output. |
| **sol** | Opus | Turning an approved plan into work: file-by-file breakdown, sequencing, and **every judgement call** — is this diff right, is this evidence sufficient, is this finding inside the contract. | Talk to the captain. Re-plan; a departure goes back to astra. |
| **terra** | Sonnet | Writing the code, in an isolated worktree. One coherent change per run, scope handed to it. | Decide scope. Declare itself done. |
| **luna** | Sonnet | Gathering proof: seeded real data, the browser, the edges, raw `tsc` / unit exit codes, the diff. Reports **evidence, verbatim**. | Write product code. Render a verdict, or soften a failure into a caveat. |

### Why the cheap tier is safe here

A Sonnet that *judges* is the failure mode — it calls a red suite "mostly green".
So the leaves never judge. terra produces a diff; luna produces evidence; **sol
is the only tier that turns either into a verdict.** That keeps the expensive
model reading two short artifacts instead of doing the work, which is where the
token saving actually comes from.

### Rules that make it work

- **One voice.** Only astra reports to the captain, in outcomes — never a
  relayed transcript, never a task id.
- **Fan out at the leaves, not the trunk.** terra and luna parallelize freely
  (one terra per independent ticket, each in its own worktree). astra and sol
  stay singular — two orchestrators means two plans.
- **luna is not optional.** An unproven terra run is unfinished work, and sol
  reports it as unfinished. Green `tsc` is not proof; the feature driven in a
  browser on seeded data is.
- **The plan is still the gate.** astra does not release sol before the captain
  says **`approved — build`**. The hierarchy speeds ② → ③; it never skips ①.
- **Escalate, don't improvise.** A leaf that hits something the plan did not
  anticipate stops and returns the finding. sol decides if it is inside the
  contract; if not it goes to astra, and astra puts it to the captain.
- **Brief like the model is cheap and the context is not.** A leaf gets the
  files, the acceptance test, and the constraint — not the conversation.
- Sub-agents inherit every hard stop in the root `AGENTS.md` — production lock,
  the staging ladder, RLS, the tool layer, no fabricated listing photos, no
  Linear tickets. Delegation never launders a boundary.


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

- Write product code before **`approved — build`**
- Let a Sonnet leaf render a verdict — evidence up, judgement at `sol`
- Run two orchestrators on one request
- File a Linear ticket he did not ask for
- Show him a plan whose UI tab describes the screen instead of drawing it
- End a turn with a plan open and no `npm run lavish:poll`
- Use Linear MCP or `cursor agent` for tickets
- Create tickets without project + milestone
- Put secrets in descriptions
- Skip TestFlight verification after a production push
- Use `/demo` as proof that production-like flows work
- Write production data, even when asked in chat
