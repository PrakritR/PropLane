# Prakrit - captain / integrate

Load this **in addition to** the root `AGENTS.md` when the person asking is
Prakrit (captain). Do not apply `AGENTS-akhil.md`.

Full pipeline: [`captain-dev-workflow.md`](captain-dev-workflow.md),
[`agent-tooling-index.md`](agent-tooling-index.md),
[`../share/proplane-collaborator-workflow.md`](../share/proplane-collaborator-workflow.md).

## Default pipeline

```
① SYNC  →  ② STUDIO PLAN  →  ③ ITERATE ON THE PLAN  →  ④ BUILD + gate:prompt  →  ⑤ PROMOTE
```

**Every prompt to a lane starts by syncing that lane with `prakrit`** (merging
`origin/prakrit`, and `origin/main` if `prakrit` is behind it), **then writing or
updating the lane's plan in the PropLane studio** (`~/proplane-mock-kit`,
`node tools/studio-plan.mjs new --lane <lane> --id <id> --title "<title>"`).
A bug, an idea, a screenshot, one line in chat — plan it and open it, even when
he did not ask for a plan. Skip it only when he says **"skip plan"** / **"just
do it"**, the ask is a one-line factual answer, the work is read-only
investigation, or it is an urgent production fix. When in doubt, build the plan.

Reply with the studio URL for the lane, then **stop** until the plan's status is
`approved` — he sets that from the studio's Approve button, or by typing
**`build`** in the lane's own pane. Do not write product code before that. He
will iterate on the plan across several rounds first - that is expected, not a
sign the plan failed.

Once approved: build on the lane, run `npm run gate:prompt` (vitest on the
changed files, eslint on the changed files, `tsc --noEmit`, real exit codes),
and serve the lane's port for review. Code reaches `prakrit` only when he types
**`/promote prakrit`** in the lane's pane - see "Standing branches, lanes, and
the promote ladder" below.

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
  exists; collect the choice in the plan's decision form.
- **The build contract**: files touched, schema/data changes, the edges that will
  be driven to prove it, and what is deliberately out of scope.
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

## Prior art check - every prompt, before the plan

**Standing order (Sep 20, 2026): on every prompt that will change code or UI,
look on GitHub first for open-source repos with more than 1,000 stars that do
something similar to what is being built, and let what they do well shape the
plan.** It is a simple check, not research: one or two searches, the top hits
only, and a look at how each solved the same problem (data model, UX shape,
edge cases, tests). It runs before the plan is written so the plan can
borrow the pattern, and the plan names what was borrowed and from where.

```bash
gh-axi repo search "<what the prompt is about> in:name,description,readme" --stars ">1000" --limit 5
```

- Use `gh-axi` (or the GitHub search API); never clone into the repo.
- Borrow ideas and shapes, never code you cannot license: PropLane ships under
  its own terms, so copy a pattern, not a file, and note the source in the plan.
- Skip only where the plan itself is skipped ("skip plan", a one-line answer,
  read-only investigation, an urgent production fix).
- No hits over 1,000 stars is a fine outcome; say so in one line and move on.

## Studio inbox - the chat only works if this is running

The lane plan's chat, annotations, and queued prompts reach the agent through
the studio inbox watcher and nowhere else. A plan left open with no watcher
running is a dead page: he types into it and nothing happens. **Never end a
turn with a plan open and no watcher running.**

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

## Studio watch (mandatory while a plan is open)

1. Right after writing or updating the lane's `plan.html`, start
   `node ~/proplane-mock-kit/tools/studio-inbox.mjs --lane <lane> --wait` as a
   tracked background task.
2. Every later turn while the lane's `active.json` names this plan: check the
   watch is still live before doing anything else.
3. After approval, the plan's status moves to `approved`/`built` and the watch
   for that plan id is done.

Iterating is the normal case, not an exception:

- Apply his feedback by editing the **same** `plan.html`, never a new one, so
  the studio URL he has open keeps working.
- Reply inside the studio where he is looking, then keep the watch open. Keep
  the loop going for as many rounds as he wants.
- Never end the session on your own initiative - he closes it, or it closes
  when the built work has shipped (`studio-plan.mjs promoted`). If the watch is
  killed or times out, just re-run it; queued feedback is never lost.

Never tell Prakrit to annotate in the studio unless you have a watcher running.
Never start a second plan for the same lane while one is still active.

## The agent system: astra → sol → terra + luna

Captain's standing structure for anything bigger than a one-file edit. The model
ladder is deliberate: **thinking is expensive, typing is not.** Spend the big
model where a wrong call compounds (the plan, the judgement) and the cheap model
where the work is mechanical and its output is checkable.

```
                    ┌──────────────────────┐
   the captain ───► │  astra    · fable    │   plan · owns the studio plan
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
| **astra** | Fable | The captain's request end to end. Writes and iterates the lane's studio plan, holds the build contract, is the **only** tier that speaks to the captain. | Write product code. Relay raw sub-agent output. |
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

- Lane and port: see the table below. After building, run `npm run gate:prompt`
  and leave the lane's port serving the review.
- Status moves apply **only** when he pointed the work at an existing PRP ticket;
  otherwise there is no ticket and nothing to move (see *Linear tickets are OFF*).
- While coding that issue: Linear **In Progress**.
- Whole ticket + green `tsc` / unit on this tip: **Done**, plus

```bash
npm run linear:comment -- --ticket PRP-### --sha <commit> --lane <keeper>
```

- Partial / parked: **Backlog**. Do not mark Done for a partial fix.
- Do not move a peer/captain-verified Done issue back to Backlog.

## Standing branches, lanes, and the promote ladder

Prakrit's standing instruction (2026-09-20): keep exactly these six agent lanes
active. Each syncs with `prakrit` at the start of every prompt and serves its
own port; `~/proplane-mock-kit/studio/branches.json` is the source of truth for
worktree paths.

| Lane | Worktree | Port |
| --- | --- | --- |
| `prakrit` | `proplane-prakrit` | 3000 |
| `claude-1` | `proplane-claude` | 3001 |
| `claude-2` | `proplane-claude-2` | 3002 |
| `claude-3` | `proplane-claude-3` | 3003 |
| `cursor-1` | `proplane-cursor-branch-1` | 3004 |
| `cursor-2` | `proplane-cursor-2` | 3005 |
| `codex-1` | `proplane-codex-1` | 3006 |

There is no `codex-2` lane. Do not make a new branch for each prompt.

`prakrit` is the integration rung, and it is **locked** unless the captain has
typed `/prakrit` in that pane (a session-start hook re-locks it when the pane
restarts). Nobody hand-pushes to it, and there is no separate captain
integration script to run.

The only door onto `prakrit` is the captain typing **`/promote prakrit`** in a
lane's own pane. That command:

1. syncs the lane (merges `origin/prakrit`, and `origin/main` if `prakrit`
   lacks commits `main` has) - the lane must already be clean and pushed;
2. runs the full no-mistakes pipeline on the merged tip;
3. fast-forwards `prakrit` to the validated tip and pushes;
4. fans `prakrit` back out to every other lane (merge commit allowed on lanes,
   never rebase or force; a dirty or conflicting lane is skipped and reported);
5. refreshes the `prakrit` worktree and restarts `:3000`;
6. marks the lane's plan `merged` and refreshes the studio.

Climbing further up the ladder is the same grammar, always fast-forward, always
the captain's own typed word:

```
/promote main                    # prakrit → main
/promote staging                 # prakrit → main → staging
/promote staging to production   # staging → production, after npm run ship:preflight
```

**`/promote production` is refused** - the message points back to `/promote
staging to production`. If any push is not a fast-forward, stop; never rebase,
never force.

Before retiring a lane, preserve its commits and uncommitted work, reconcile
any unique changes, and verify its integration. Do not turn an unfinished
working copy into a completed feature merely to clean up branches.

After a production promote, watch the **iOS TestFlight** GitHub Action. Confirm
`ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_KEY_P8` exist.

## Reviews on Prakrit work

Before `/promote prakrit`: security-review + bugbot on the lane diff, plus
cache/rendering/perf when UI/routes changed, plus web-native parity when
portal/nav/push/routes changed. Fix high/critical findings before asking him to
promote.

**no-mistakes runs as part of `/promote prakrit`** - it is not something a lane
triggers on itself mid-work.

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
- End a turn with a plan open and no studio watcher running
- Use Linear MCP or `cursor agent` for tickets
- Create tickets without project + milestone
- Put secrets in descriptions
- Skip TestFlight verification after a production push
- Use `/demo` as proof that production-like flows work
- Write production data, even when asked in chat
