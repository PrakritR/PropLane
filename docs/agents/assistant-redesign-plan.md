# Shared assistant redesign — implementation plan

Status: approved mock implemented in the shared Modal and assistant transport; focused unit and isolated real-component browser checks passed.

Tracking: [PRP-310](https://linear.app/axishousing/issue/PRP-310/assistant-dialog-cta-and-right-side-chat-redesign).

## Requested outcome

Start with Communication's message editor and apply the interaction to the shared
PropLane assistant across portal dialogs. Preserve the existing Blue Steel visual
system, role permissions, and one assistant framework.

1. A compact **Ask PropLane** CTA in the dialog header replaces the full-width
   assistant strip. Clicking it opens chat at the usual right viewport rail,
   outside the editor. Both editor and assistant remain interactive.
2. Each panel has a labeled X. The assistant X closes only the assistant. Resolve
   how an editor X preserves a still-open task assistant before implementing it;
   it must never leave the assistant acting on a stale or discarded draft.
3. Clicking the backdrop outside both panels dismisses the pair. Clicking either
   panel, its dropdowns, or its attachments does not count as outside.
4. On phones, provide a readable responsive presentation with reachable close
   controls, keyboard-safe composers, and no horizontal overflow. Do not squeeze
   two desktop columns into a phone.
5. Keep internal screen/thread context separate from user-authored messages and
   recipient-facing message bodies. Working assumption pending clarification:
   the assistant still receives the context internally, but it is not echoed in
   visible chat, message previews, or delivered messages.
6. An authenticated owner's explicit **send** in chat can approve the current
   pending message instead of requiring a click on its confirmation card. This
   uses the existing server-owned pending action and confirmation transport.
   It does not run writes from model output or quoted/context text.

## Interaction sketch

First visual concept: `output/assistant-redesign/desktop-concept.png`, generated
with the built-in image tool. Interactive mock: `output/assistant-redesign/mock.html`.
These are proposed visual/interaction artifacts with fictional data, not shipped UI.

Before: editor containing an expandable assistant strip; narrow dialogs often
stack chat underneath the form.

After, desktop:

```text
                 shared dismissible backdrop
  +--------------------------------+  +---------------------------+
  | Message editor              X  |  | PropLane Assistant      X |
  | Recipients / subject           |  | Conversation              |
  | Editable message               |  | Safe pending preview      |
  |                                |  |                           |
  | Send                           |  | Ask / explicit send       |
  +--------------------------------+  +---------------------------+
```

Editor and assistant are one coordinated overlay interaction, with one focus
boundary that includes both panels. Existing portaled selects must stay usable.
This is an editor/dialog change; no top-level record-list row variant is needed.

## Implementation lanes

- Layout audit: GPT-5.6 Luna inventories `Modal`, `ModalAssistantStrip`, custom
  modal embeddings, focus handling, close ownership, and current tests.
- Conversation audit: GPT-5.6 Sol traces contextual prompts, visible history,
  pending message actions, and explicit confirmation behavior.
- Orchestrator: resolve shared contracts, document scope, coordinate isolated
  file ownership, implement integration, and review resulting changes.
- Browser verification: Playwright against local dev/test data, including the
  real manager Communication flow and representative shared dialogs.

## Revised integration contract after mock brief

The right rail is a viewport-positioned presentation of the shared assistant
panel. Simply focusing the existing portal-layout rail while a dialog is open
would leave it outside Radix/Vaul's focus boundary. The implementation must keep
the editor and rail inside one coordinated overlay scope and arbitrate the
ordinary popup/dock so users never see competing assistant presentations.

Own `editorOpen` and `assistantOpen` independently; the overlay stays open while
either is true. Assistant X returns focus to the compact CTA when the editor is
open. Editor X detaches discarded draft context and must not leave an actionable
preview for a discarded draft; define the pending-action lifecycle explicitly in
implementation tests. Outside click and Escape dismiss both. Preserve the
role-scoped endpoint and task-scoped conversation identity.

The interactive mock is available at `http://127.0.0.1:3012/mock.html` while the
local artifact server is running. Its sends are simulated, with no network calls.

## Initial implementation targets

- `src/components/ui/modal.tsx`
- `src/components/portal/modal-assistant-strip.tsx`
- `src/components/portal/assistant-dock-panel.tsx`
- `src/lib/axis-assistant/use-assistant-conversation.ts`
- `src/components/portal/assistant-shared.tsx`
- Custom editor embeddings identified by the audit, including listing and lease
  editors. Reuse the shared layout contract rather than creating portal forks.

## Audit findings

- `AssistantDockPanel.sendWithContext` currently prepends `[Context: ...]` to
  the user text and passes the combined string to `send`. This is a concrete
  source of internal context entering ordinary chat history. Replace this with
  separate internal request context and display text, with archive compatibility
  tests; do not rely on a broad regex to erase user-authored content.
- Shared `Modal` already owns outside dismissal for both its content and
  embedded assistant. Preserve that ownership and its `dismissBlocked` behavior.
- Footer dialogs force a stacked assistant layout. Desktop sibling layout must
  handle their footer and scrolling chain explicitly.
- Custom placements include `pro-add-listing-form.tsx` (left-side assistant),
  `resident-applications-panel.tsx`, `lease-amend-move-out-modal.tsx`, and
  `vaul-bottom-sheet.tsx`. Include them in adoption and responsive checks.
- Current assistant collapse says Hide; the requested independent X needs an
  accessible label and focus return to its opening control.
- Playwright's bundled Chromium is installed. The earlier browser-tool failure
  targeted a missing system Chrome and does not prevent using bundled Chromium.
- The manager route parses the same context prefix for listing/promotion routing
  and attachment enrichment. A separate bounded `contextHint` request field must
  preserve that behavior and be included in the traced final system prompt,
  while visible and archived messages retain the original user text.
- Typed confirmation belongs in the shared conversation transport before context
  augmentation: only a narrow set of explicit send phrases, with a current
  immediate-message preview and no attachments, calls the existing
  `resolvePendingAction('confirm')`. A preview-kind allowlist prevents a bare
  send command from approving unrelated financial or destructive actions.
- The layout audit ran existing `modal-scroll-container.test.tsx`: 6/6 passed.
  This is baseline evidence, not verification of the proposed redesign.

## Confirmation and context requirements

- Explicit send approves one current message proposal whose recipient/body was
  previewed. Ambiguous commands, edits, questions, and negations do not approve.
- Expired, denied, already-executed, foreign-user, and foreign-portal proposals
  cannot execute. Repeated sends remain exactly-once at the existing claim gate.
- A dismissed UI must not be interpreted as approval. A denied proposal stays
  denied; a later send request needs a fresh proposal.
- Do not introduce a parallel confirm route or direct database access by the
  model. Retain authenticated ownership checks, stored-input revalidation,
  permission-scoped tools, audit logging, and trace linkage.
- Preserve PostHog event names and Langfuse proposal/action scoring. New close
  and open controls receive `data-attr`; analytics do not include message text.
- Keep contextual data out of ordinary user history by separating request
  context from display text, rather than stripping arbitrary user text.

## Verification matrix

Mock-only validation: `node output/assistant-redesign/verify-mock.cjs` passed
using bundled Chromium outside the restricted browser-launch sandbox. Checks:
editing both panes, independent X controls, backdrop dismissal, Escape, simulated
send, clearing the assistant subtitle when the editor closes, 390px preview
reflow, phone editor/chat switching with retained draft, no page errors, and no
horizontal overflow. Screenshots are in `output/assistant-redesign/`.
This does not validate the real application or actual message delivery.

| Area | Required evidence |
| --- | --- |
| Communication | Open compose, open assistant, edit both, close either, dismiss backdrop |
| Shared dialogs | Narrow and wide dialogs plus custom listing/lease embeddings |
| Keyboard | Focus across both panels, Escape policy, focus restoration, dropdown selection |
| Responsive | Desktop and 390px phone screenshots, no clipping, reachable X and composer |
| Context | Sentinel internal context absent from visible transcript and outgoing message |
| Sending | Explicit send succeeds via confirm transport; question/negation/edit does not send |
| Server gate | Foreign, expired, denied and duplicate action requests rejected safely |
| Failure | API/send failure keeps an understandable recoverable state; no success claim |
| Observability | Existing confirmation analytics, audit entry and proposal trace linkage preserved |

Run relevant unit/integration tests, typecheck and lint, then Playwright on the
actual local portal using dev/test data. Capture desktop/mobile evidence and have
a separate reviewer assess it. No live outbound test messages or production data
writes. This redesign does not inherit the previous hotfix's production exception.

## Current constraints

Unrelated co-manager changes already exist in the shared workspace and must be
preserved. The user approved ticket creation in the follow-up; PRP-310 now records
the work through the connected Linear account. The local script lacks its API key.
The user approved the mock in saved chat `01a07021-29b9-75b0-8897-a7d12d1ace8d`
(“This is perfect, utilize subagents to implement and test their work and then report back.”). This is an interaction redesign, not a product-wide rebrand.


## Implementation handoff — 2026-09-05

- Shared `Modal` renders the compact header CTA and a viewport-right assistant
  inside one Radix focus boundary. Both panels accept input on desktop; at phone
  and tablet widths the assistant covers the editor, with its X returning to the
  retained editor. Empty-canvas clicks and Escape dismiss the pair.
- The shared editor X unmounts its body and rotates to a fresh, context-free
  assistant scope. Final dismissal invokes the parent close callback. Pending
  modal proposals are denied through the existing role-scoped endpoint on scope
  disposal; late-arriving proposals are also denied. Cleanup is best-effort when
  offline; server ownership, expiry and confirmation gates remain authoritative.
- `ModalAssistantStrip` now supplies a compact CTA and shared viewport rail for
  custom embeddings too. Custom listing/Vaul editors retain their own editor
  dismissal lifecycle; the independent editor-X behavior above belongs to the
  shared `Modal` workspace. Those custom flows have not had authenticated browser QA.
- Request context is separate from authored/archived user messages and enters
  the bounded, untrusted section of the hashed/traced system prompt for all roles.
  Exact standalone send commands approve only a current immediate-message
  preview through the existing confirm transport; attachments and other action
  kinds are excluded.
- Real shared Modal, assistant panel, composer and transport were exercised in
  a lightweight Vite fixture with simulated API responses at 1440, 768 and 390px.
  Verified simultaneous editing, context separation, typed-send transport,
  independent closes, draft retention/disposal, backdrop/Escape, no horizontal
  overflow and no browser errors. Screenshots and reproducible fixture:
  `output/assistant-redesign/implementation/`.
- Resource constraint: single-worker unit checks with a 768 MB heap; no Next
  build, dependency installation, authenticated live-provider test or deployment.
  The temporary preview server was stopped after verification.


## Staging validation follow-up

The user requested direct unit/browser validation and explicitly stopped the
no-mistakes run. Review findings were fixed directly before promotion:

- Pure authenticated denials have a separate per-role/user rate-limit bucket;
  chat and confirms retain their previous limits and all ownership gates.
- Each detached assistant gets a fresh random scope, preventing restoration of
  another dialog's detached transcript.
- Full-page and full-screen mobile editor sizing/safe areas are preserved.
- An active assistant expands Vaul's focus boundary to the viewport and removes
  its transform containing block; closing it restores the raised/partial sheet.

Validation: 110 tests across 12 focused unit suites passed; changed-file ESLint
and diff checks passed. Real-component browser checks passed at desktop/tablet/
phone widths, including a raised Vaul sheet and typed confirmation with simulated
API responses. Full compilation is delegated to the staging Vercel deployment.
