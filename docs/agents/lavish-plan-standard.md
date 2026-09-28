# The studio lane plan standard (captain work)

**Every prompt to a lane starts as a plan in the PropLane studio. No product
code until its status is `approved` — set from the studio's Approve button, or
by the captain typing `build` in the lane's own pane.** The plan is the spec:
whatever it shows is exactly what gets built. He iterates on the plan, not on
your code.

No Linear ticket is filed for this. File one only when he says "file a ticket".

## The loop

```
his message  →  sync the lane with prakrit  →  studio plan  →  he annotates / edits / picks  →  you watch + apply
                                                     ↑                                                    │
                                                     └───────────── edit the same plan.html ◄──────────────┘
                                                                     …until status is `approved`
```

```bash
node ~/proplane-mock-kit/tools/studio-plan.mjs new --lane <lane> --id <id> --title "<title>"  # scaffold
# fill plan.html at ~/proplane-mock-kit/studio/plans/<lane>/<id>/plan.html, then:
node ~/proplane-mock-kit/tools/studio-inbox.mjs --lane <lane> --wait     # FIRST thing you start every turn
node ~/proplane-mock-kit/tools/studio-plan.mjs status --lane <lane>     # exits 0 once buildable
```

Rules that are not negotiable:

- **Never end a turn with a plan open and no watcher.** A lane with no live
  `studio-inbox.mjs --wait` is a dead page and his annotations sit unread.
- **One watcher per lane at a time.** Run it as a tracked background task so
  the harness wakes you when he sends something; do not run a second one for
  the same lane, they race for the same delivery.
- While the lane's `active.json` names this plan, checking the watch is
  live is the **first** thing every turn — before reading files, before
  anything.
- Answer in the plan's own chat, not only in the terminal.
- The plan stays open across iterations. Its status moves to `approved` only
  on his word.
- Re-open the same `plan.html` after edits; never start a second plan for the
  same lane while one is still active.

## What a plan must contain

The scaffold `studio-plan.mjs new` writes is a **shell**. Every `slot` span is
a hole you fill before he ever sees it. Five tabs:

| Tab | Holds | Bar |
| --- | --- | --- |
| **Overview** | today → after, in/out of scope | current behaviour **verified in the running app**, never assumed |
| **UI** | the screen itself | mock, don't describe — see below |
| **Build** | file-by-file table, data/contract changes, order of work | another developer could build it from this alone |
| **Decide** | open questions as pickable options | each option says what it costs and what it buys |
| **Risks & tests** | failure modes, how it gets proved | real seeded data + the edges, never `/demo` as proof |

## Show the UI, do not describe it

Start from the whole-product mock kit ([`ui-mock-kit.md`](ui-mock-kit.md)): load it into the
plan and change only the pages the plan touches, with Before matching today exactly.

If the change touches anything visual, the UI tab must render the screen in
PropLane's own look — the template ships `.pl-card`, `.pl-row`, `.pl-btn`,
`.pl-pill` primitives on the real brand tokens (`--pl-blue #2863f0`, ink
`#17181a`, cards on `--pl-line` borders).

- **Before** pane: a screenshot of the real current screen when it exists
  (`npm run sandbox:open`, capture, drop into the plan's `assets/`). A mock of
  the current screen only when there is nothing to screenshot.
- **After** pane: the proposed screen with real copy, real rows, real numbers —
  not lorem, not `[button]`.
- Drive the desktop/mobile toggle yourself before showing him: PropLane ships
  web and native from one codebase, so a mock that only works at 940px is a
  half-plan.
- Show the states that bite: empty, loading, error, locked, over-quota.

## Semi-interactive means the plan responds

The captain reviews faster by clicking than by typing. The template already
wires:

- **Tabs** — Overview / UI / Build / Decide / Risks.
- **Before ↔ After** and **Desktop ↔ Mobile** toggles on the mock.
- **Editable text** — every section is `contenteditable`; the *Queue my edits*
  button sends his rewritten text back to you verbatim.
- **Decision forms** — radios plus one *Queue this answer* submit. Never queue
  on a radio change; he must be able to change his mind.
- **approved — build** / **Rework the plan** buttons in the footer.

Everything routes through the studio's queued-prompt mechanism, which
`studio-inbox.mjs --lane <lane> --wait` drains. Add more interactivity when it
helps him decide — a working prototype of the interaction beats three
paragraphs about it.

## Filling the scaffold

Edit `~/proplane-mock-kit/studio/plans/<lane>/<id>/plan.html` directly. It is
plain HTML with no build step and no CDN, so it renders identically in the
studio and in a plain browser.

- Keep the `data-plan-field` attributes — they are what his edits come back
  labelled with.
- Delete the Decide tab's placeholder question rather than shipping an empty
  one; a fake open question wastes his review.
- Remove an open question from the plan once he answers it. Fold the answer
  into the plan instead of leaving a resolved thread lying around.
- Images go in the plan's `assets/` and are referenced relatively.

## After approval

```bash
node ~/proplane-mock-kit/tools/studio-plan.mjs status --lane <lane>   # confirms buildable
```

Then build **what the plan shows**. If implementation forces a departure from
the plan, that is a plan change: update `plan.html`, re-open it, and tell him
what moved — do not silently build something the plan does not show. After
building, run `npm run gate:prompt` and record what was proved per
[`plan-evidence.md`](plan-evidence.md).

Once the lane lands via `/promote prakrit`, `studio-plan.mjs promoted --lane
<lane> --sha <sha>` marks the plan `merged` and clears the lane's active plan.

Ship gate afterwards is unchanged: `docs/ship-gate.md`.
