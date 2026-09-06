# Inspection bug review — 2026-09-06

Scope: uncommitted inspection changes over `98eff6d3`, including room requirements,
reminder materialization, review lifecycle, private assistant/SMS intake and the
confirmation-gated photo tool. Graphify was queried before source exploration;
current source was authoritative because implementation was changing during review.
This is a source and unit-regression review, not production or native-device QA.

## Findings sent to the implementation owner

1. **Medium / P2 — move-date changes suppress replacement resident reminders.**
   `src/lib/reminders/subjects/inspections.server.ts` initially uses
   `subjectId: ${applicationId}:${kind}`. The shared queue deduplicates by subject,
   timing and recipient with `ignoreDuplicates: true`. Its send-time check rejects
   the old anchor, but a new reminder for the changed date cannot replace the old
   dedupe key. Include canonical room assignment and the normalized date anchor in
   the subject version. Status at review handoff: implementation owner notified;
   regression should cover moving a lease date after a reminder is materialized.

2. **Medium / P2 — named/manual room placements do not match their own reports.**
   The initial `sameRoom` compares the report's canonical `property::room-id`
   assignment against the application's raw room name/manual number.
   `resolveInspectionRoom` legitimately converts the latter into the former when
   creating a report. This suppresses manager review reminders and keeps resident
   requirements outstanding after completion. Normalize placement through the
   same listing resolver before comparing. Status at review handoff: owner
   notified; cover a manual room name whose completed report has a canonical id.

3. **Medium / P2 — private intake regresses valid GIF assistant attachments.**
   `src/lib/inspections/attachment-intake.server.ts` initially accepts JPEG, PNG
   and WebP only, while both affected assistant endpoints previously accept GIF.
   Since all resident images and ordinary manager-chat images now use this intake,
   an unrelated GIF question fails before the model runs. Re-encode the first GIF
   frame to a private JPEG, or retain unsupported inspection formats for vision
   without filing. Status at review handoff: owner notified.

## Corrections verified in source

- Only managers can request confirmation; either party's actual evidence meets
  the meaningful-observation check. Residents retain a separate explicit review
  acknowledgment and cannot permanently complete a report.
- The resident Submit button and automatic submit-then-acknowledge sequence were
  removed. Completed reports remain immutable and reopening clears acknowledgment.
- Frozen unsent recovery now installs the browser-unload guard while ordinary
  in-app navigation continues to use the actor-scoped memory cache.
- Ordinary manager assistant images now enter the private uploader-scoped bucket
  instead of the public listing-photo enrichment branch. Listing/promotion
  contexts retain their separate existing workflow.
- Photo filing uses `defineWriteTool`; it resolves authenticated ownership and
  revalidates the draft, item and revision. Final ingestion delegates to the
  existing image validation, evidence storage, audit and compare-and-swap service.
- Verified resident SMS intake is placed after resident identity resolution and
  binds its private namespace to the work-number owner. Portal actors cannot
  select another uploader's source; SMS sources additionally require the active
  manager namespace. No new inline writes or confirmation routes were introduced.

## Concurrent implementation follow-up

The owner was already correcting archive preservation of source references, inbox
attachment discovery, authenticated Twilio-to-CDN redirect handling and idempotent
photo filing. These evolving paths require their own final tests; this review does
not certify an earlier intermediate version as complete. In particular, the
initial Twilio fetch used `redirect: error`, and portal archive content was captured
before private references were added. Those versions cannot support reliable MMS
delivery or a later photo-filing clarification turn.

## Verification executed

`npx vitest run tests/unit/inspections-model.test.ts tests/unit/inspections-server.test.ts tests/unit/inspection-editor-autosave.test.tsx tests/unit/evidence-inspection-room-flow.test.tsx tests/unit/inspection-evidence-privacy.test.tsx tests/unit/reminder-rules.test.ts tests/unit/reminder-current.test.ts`

Result: **7 files passed, 66 tests passed**. These suites cover existing lifecycle,
scope, recovery and reminder framework behavior. They do not yet establish the
new intake/network and inspection-specific sweep regressions above. No real
messages, external writes or deployment actions were performed by this reviewer.

## Follow-up review and regression evidence

The three P2 findings above are now **resolved and regression-tested**: reminder
subject versions include normalized anchor and canonical room identity; both
sweep and delivery checks match manual room placements through the shared room
resolver; private chat intake re-encodes GIF images to JPEG.

Added `tests/unit/inspection-reminders.test.ts` and
`tests/unit/inspection-attachment-intake.test.ts`, plus the source-filing retry
case in `tests/unit/inspections-server.test.ts`. The reminder test exercises the
actual queue materializer with insert-ignore dedupe, changes the move date, and
checks that a replacement queues while the previous anchor is refused. Other
cases cover completed manual rooms, manager review and withdrawal, actual GIF
decoding/JPEG encoding, retained archive-text refs, foreign uploader/source
rejection before storage reads, SMS manager scoping, message-bound Twilio URLs,
CDN credential stripping, unsafe redirect refusal, and repeated source filing
without duplicate writes or weakened revision checks.

Command: `npx vitest run tests/unit/inspection-attachment-intake.test.ts tests/unit/inspection-reminders.test.ts tests/unit/inspections-server.test.ts`

Result: **3 files passed, 27 tests passed**. ESLint passed for the two new suites.
Network tests stub fetch and storage; no provider request or real object upload
was made. Archive helpers now preserve source references, and the Twilio fetch
allows only the exact HTTPS MMS CDN origin without forwarding credentials.

**Remaining P2 at follow-up handoff — active chat clarification loses source
references.** The routes archive enriched text, but the shared client conversation
hook stores its original `next` messages after a successful response and sends
those on the following turn. The routes use the supplied messages without loading
the saved transcript. Therefore photo → “which section?” → “door” loses the private
reference during the normal open conversation, despite it surviving an explicit
archive reload. Return and retain attachment context in the shared transport, or
rehydrate owned source references server-side; include modal `archive: false`
conversations. Owner notified. The archive-text unit test establishes durable
extraction, not this two-turn transport behavior.

## Final source follow-up

The active-chat clarification P2 is now **resolved and regression-tested**.
Both role routes return a separate `attachmentContext`; the SSE `done` event
preserves it; the shared hook retains it on the originating user message and
includes it in subsequent model requests without changing visible authored text.
Repeated clarification turns do not accumulate duplicate prefixes. File ownership
still comes from the server's authenticated source resolver, not from the echoed
context string.

Added `tests/unit/assistant-inspection-photo-clarification.test.tsx`, which executes
the actual server SSE encoder and actual React conversation hook for both manager
and resident endpoints with `archive: false`. It sends an image, receives a
clarification question, responds with the section, and makes another turn; the
private source survives all requests without re-uploading the image or implicitly
confirming the write. Extended `tests/unit/resident-inbox-agent.test.ts` to verify
that only the resident's own structured image attachments become source context;
foreign files, arbitrary external URLs, PDFs, assistant attachments and quoted
body URLs do not gain source authority.

Command: `npx vitest run tests/unit/assistant-inspection-photo-clarification.test.tsx tests/unit/resident-inbox-agent.test.ts`

Result: **2 files passed, 12 tests passed**. No remaining concrete bug-review
finding from this inspection review is open. Browser/device QA, provider-backed
MMS delivery, database migration application and the overall release gate remain
the implementation owner's separate validation responsibilities.
