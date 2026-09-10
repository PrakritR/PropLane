# The Lavish plan standard (captain work)

**Every prompt from Prakrit starts as a Lavish plan. No product code until he
says `approved — build`.** The plan is the spec: whatever it shows is exactly
what gets built. He iterates on the plan, not on your code.

No Linear ticket is filed for this. File one only when he says "file a ticket".

## The loop

```
his message  →  plan (Lavish)  →  he annotates / edits / picks  →  you poll + apply
                     ↑                                                      │
                     └──────────────── re-open, reply in chat ◄─────────────┘
                                        …until "approved — build"
```

```bash
npm run workflow:plan -- --chat "<his exact message>"   # scaffold + open + listen
# fill the scaffold, then:
npm run lavish:listen                                    # UI shows "listening"
npm run lavish:poll                                      # FIRST command every turn
npm run lavish:poll -- --reply "Applied — reload the plan"
npm run lavish:poll -- --clear                           # only after approval
```

Rules that are not negotiable:

- **Never end a turn with a plan open and no poll.** Lavish then shows *"your
  agent is not listening"* and his annotations sit unread.
- **One poller at a time.** In Claude Code, run the long poll as a tracked
  background Bash task (`npm run lavish:poll -- --wait`) — the harness wakes you
  when he sends something. `npm run lavish:listen` is the fallback for hosts
  without tracked background jobs; do not run both, they race for the same
  delivery.
- While `.lavish/active-session.json` exists, `npm run lavish:poll` is the
  **first** command of every turn — before reading files, before anything.
- Answer in the plan's own chat with `--reply`, not only in the terminal.
- The session stays open across iterations. Clear it only on approval.
- Re-open the same `plan.html` after edits; never start a second plan for the
  same request.

## What a plan must contain

The scaffold (`scripts/lavish/plan-template.mjs`) is a **shell**. Every
`slot` span is a hole you fill before he ever sees it. Five tabs:

| Tab | Holds | Bar |
| --- | --- | --- |
| **Overview** | today → after, in/out of scope | current behaviour **verified in the running app**, never assumed |
| **UI** | the screen itself | mock, don't describe — see below |
| **Build** | file-by-file table, data/contract changes, order of work | another developer could build it from this alone |
| **Decide** | open questions as pickable options | each option says what it costs and what it buys |
| **Risks & tests** | failure modes, how it gets proved | real seeded data + the edges, never `/demo` as proof |

## Show the UI, do not describe it

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

Everything routes through `window.lavish.queuePrompt(...)`, which is what
`npm run lavish:poll` drains. Add more interactivity when it helps him decide —
a working prototype of the interaction beats three paragraphs about it.

## Filling the scaffold

Edit `.lavish/plans/<ID>-<slug>/plan.html` directly. It is plain HTML with no
build step and no CDN, so it renders identically inside Lavish, in a browser,
and after `npx -y lavish-axi export`.

- Keep the `data-plan-field` attributes — they are what his edits come back
  labelled with.
- Delete the Decide tab's placeholder question rather than shipping an empty
  one; a fake open question wastes his review.
- Remove an open question from the artifact once he answers it. Fold the answer
  into the plan instead of leaving a resolved thread lying around.
- Images go in the plan's `assets/` and are referenced relatively.

## After approval

```bash
npm run lavish:poll -- --clear
```

Then build **what the plan shows**. If implementation forces a departure from
the plan, that is a plan change: update `plan.html`, re-open it, and tell him
what moved — do not silently build something the plan does not show.

Ship gate afterwards is unchanged: `docs/ship-gate.md`.
