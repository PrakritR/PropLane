# One-number SMS: implementation map

Spec: [`one-number-spec.md`](one-number-spec.md). Shared types: `src/lib/one-number/contracts.ts`.
Each workstream owns one heading below.

## W1 - Shared-line router, keywords, HUMAN pause, shadow mode

Flag: `sms_runtime_config.line_mode` (`per_workspace` default | `shadow` | `shared`). In `per_workspace` the
product behaves exactly as before; the only addition on the inbound path is one `sms_runtime_config` read that
fails closed to `per_workspace` (read error, missing column, unknown mode, `shared` without a number). No migration
in W1: it uses the foundation tables (`sms_line_sessions`, `sms_line_thread_state`, `sms_line_shadow_decisions`,
`sms_entry_codes`). Every read of them treats Postgres 42P01 / 42703 and PostgREST PGRST205 as "nothing there".

Files (`src/lib/one-number/`):

- `config.server.ts` - `loadSharedLineConfig`, `isSharedLineNumber`, `workspaceOnSharedLine` (mode shared + empty or matching pilot list).
- `keywords.ts` (pure) - `classifySharedLineKeyword`: `HUMAN` = the whole body is a human keyword (an optional trailing "please/pls/thanks" and edge punctuation are ignored); `EMERGENCY` = any emergency term as a whole word ("fire" never matches firewood/fired; "smoke" alone counts). STOP/START/HELP stay in the route.
- `router-lookups.server.ts` - one exported lookup per routing step, each over an injected client, each reads only: `findTeamMemberCandidates`, `findResidentCandidates`, `findVendorJobCandidates`, `findApplicantCandidates`, `findReturningProspectCandidates`, `findEntryCodeCandidate`. A phone claimed by two verified accounts matches nobody.
- `router.server.ts` - pure decision helpers (`decideFromCandidates`, `pickCandidateFromText`, `resolvePendingAnswer`, `buildDisambiguationQuestion`) and the db-backed `routeSharedLineInbound` (returns `RoutingDecision`) / `routeSharedLineInboundWithReply` (also returns the Unassigned-leads reply). `dryRun` = no session write, no lead.
- `session.server.ts` - `sms_line_sessions` (current team + role, pending question, 6h TTL) and `sms_line_thread_state` (`pauseThreadAi`, `resumeThreadAi`, `loadThreadPause`, keyed `(phone_key, workspace_id)`).
- `inbound-seam.server.ts` - what `/api/twilio/inbound` calls for a text to the shared number (`handleSharedLineInbound`).
- `team-alerts.server.ts` - `alertWorkspaceTeam`.
- `shadow.server.ts` - `recordShadowDecision`, `shadowAgreement`.

Invariants:

1. Routing order is `SHARED_LINE_ROUTING_ORDER`. Candidates are gathered from every step, collapsed to one per (workspace, group) where group is manager / vendor / tenant-journey (resident > applicant > returning prospect). One candidate = routed. Several: a reply to the pending question ("1", "2", a house name) wins; else a text that names a house (all its distinctive words, or its street number) or whose wording fits one role (job/invoice/arrived vs rent/lease/roommate) wins; else the thread's current workspace + role; else ask "Is this about A or B?" (labels are houses or workspaces, never people).
2. A stored pending question is a hint, never authority: the answer is re-checked against who the phone is NOW, so a candidate the phone no longer has is never honored.
3. An entry code only routes a stranger (step 6), or moves a returning PROSPECT to the code's team. Anyone with a team / resident / vendor / applicant tie keeps the order.
4. A routed text continues into the existing pipeline as `managerId = ownerUserId`, `payload.workspaceId = workspaceId`, exactly what `resolveOwnedWorkNumber` supplies for a work number. `InboundPayload.sharedLine` is stored with the receipt so a recovery rerun honors a pause.
5. HUMAN (a non-manager role): pause AI for (phone, that workspace) only, alert that team, ack "Got it. A person from your property team will text you shortly.", then continue so the pipeline records and projects the text. While paused the pipeline (`processClaimedInbound`) skips every agent for that (phone, workspace) and finishes the claim. Ambiguous HUMAN pauses and alerts every candidate team. A manager saying HUMAN or fire is just talking to the manager agent. A stranger saying HUMAN stays in the lead queue (no team to page).
6. EMERGENCY (non-manager): `EMERGENCY_SAFETY_REPLY` immediately, urgent team alert, then the normal agent still files the maintenance request. A stranger gets the safety text in the webhook TwiML (no workspace to bill).
7. Replies go through `sendSharedLineMessage` (W2), idempotency key `shared-line:<kind>:<MessageSid>`. The Unassigned-leads reply (no workspace) rides the webhook TwiML.
8. Pilot (`shared_pilot_workspace_ids`): a workspace not on the list is not served on the shared line (left to the no-owner path); an ambiguity between a pilot and a non-pilot team resolves to the pilot team.
9. Team alerts reuse the notice spine (`notifyPropertyScopedManagersFromAgent`: owner Assistant notice + extra `workspace_work_number_recipients` + one Team chat line + each teammate who holds the house when urgent), now pinned to a workspace with an optional `workspaceId` input (outranks the owner's default workspace). `alertWorkspaceTeam` re-checks that `ownerUserId` really owns `workspaceId` and sends nothing otherwise.
10. Shadow mode (`line_mode = 'shadow'`): on a normal work-number text, after the response (`after()`), the router runs read-only and `sms_line_shadow_decisions` stores the would-be decision beside the real owner (`agrees` true / false / null). It never throws and never touches the real path.
11. Manager hand-back: `GET|POST /api/portal/one-number/thread-state` (`conversationId`, `action: pause | resume`). The workspace comes from the signed-in manager's active workspace; the conversation must belong to that workspace's owner and carry no other workspace's stamped turns. UI: `AssistantPauseControl` (icon action "Pause assistant" / "Resume assistant") in the SMS thread header.

Tests: `tests/unit/one-number-{keywords,config,router,inbound-seam,session,shadow,team-alerts,paused-thread}.test.ts`, `tests/unit/assistant-pause-control.test.tsx`, helper `tests/helpers/shared-line-fake-db.ts`.
