# One-number SMS: implementation map

Spec: [`one-number-spec.md`](one-number-spec.md). Shared types: `src/lib/one-number/contracts.ts`.
Each workstream owns one heading below.

## Number model (Oct 18 decision)

Captain, verbatim: "have a set work number for anyone who signs up; for pro and business can get personalized
work number for their workspace; keep overall service PropLane separate." (W16)

- **Everyone texts on the set PropLane line** (`sms_runtime_config.shared_number_e164`, `line_mode = shared`).
- **A Pro or Business workspace MAY take a personalized number** (the existing per-workspace provisioning).
  Both run side by side. PropLane's own managed service (W15) has no exemption: it uses the same default line and only gets a personalized number on a paying plan (lead correction, Oct 18).
- **Dedicated = a working number AND a paid entitlement** (captain addendum, Oct 18: current accounts move to this model too; free
  has only the default PropLane line). A workspace is dedicated only when it holds a `manager_sms_numbers` home row that is live
  (`active`, has a phone, registration approved: `managerCanSendFromOwnNumber`) and not released (or a `workspace_work_numbers`
  link to one) AND the number's owner pays for a personalized number: a Pro / Business plan (`getEffectiveManagerSkuTier`, a live
  signup trial does not count) or an active standalone **PropLane Number** subscription (`numberServiceEntitled`: active | past_due).
  `managerPersonalNumberEntitlement` is the one answer. A number with no entitlement, a lapsed add-on, a number still provisioning
  or awaiting registration, a failed or released one: the workspace stays on the PropLane line. Nobody pays today, so in shared
  mode every existing workspace lands on the shared line. `loadSharedLineConfig` puts dedicated workspaces in
  `dedicatedWorkspaceIds` (read only while the mode is `shared`; an unreadable number table or entitlement = fail closed to
  `per_workspace`). `workspaceOnSharedLine` is false for them, `workspaceHasDedicatedNumber` true. That one decision drives
  everything below. `per_workspace` mode is untouched.
- **Free can buy the number alone.** The PropLane Number subscription ($5/month, `number_subscriptions`, `docs/agents/comms-billing.md`
  § PropLane Number) now also takes `owner_role = 'manager'` (migration `20261018250000_number_subscription_manager_role.sql`, applied
  to dev). `POST /api/number-subscription/checkout {role:"manager"}` (refused 409 `not_available` unless a manager number can be
  provisioned: runtime not paused and `SMS_PROVISIONING_ENABLED`). The subscription is per user and carries exactly ONE number
  account-wide (`provisionNumberForWorkspace` budget); Pro / Business include one per owned workspace. Every other Pro feature stays
  locked. The status route reports `sharedLine.addOn = { available, active }`; Settings "Get your own number" runs the request flow
  when the plan or an active add-on covers it, else sends a Free manager to the add-on checkout and returns to Settings.
- **Vendors and residents keep their own subscription** (own number, own channel). Their number is never the shared one, so the
  shared-line seam (`isSharedLineNumber(toPhone)`) never engages on it; `ingestVendorWorkIdentitySms` / `ingestResidentAgentNumberSms`
  keep their inbound path, and the shared line still reaches them as an ordinary vendor / resident of a workspace.
- **Existing numbers.** Nothing is released in code. Once shared mode is on, an existing workspace number that nobody pays for is no
  longer used to send or to answer (the workspace is not dedicated). The production cutover runbook (later, human-run) forwards and
  auto-replies those numbers for 60 days and then releases them.

Files and invariants:

1. **Router** (`router.server.ts`, `inbound-seam.server.ts`, `dedicated-redirect.server.ts`): candidates in a dedicated
   workspace are not routed on the shared line. All matches dedicated: the text is answered once on the webhook TwiML
   ("<house or workspace> texts from (XXX) XXX-XXXX. Please text that number.", the candidate's OWN number, one GSM-7
   segment), no agent runs, no lead is made, and the text plus the reply are logged to that workspace's thread
   (`messageSid`, `redirect:<sid>`). Mixed: the dedicated ones drop out and the rest route as usual. An
   EMERGENCY word still gets the safety text and an urgent team alert. If the workspace's number cannot be named the
   text falls to the existing no-owner log. A lead whose picked room belongs to a dedicated workspace is redirected the same way.
2. **Outbound.** A dedicated workspace never sends from the shared number: `sendSharedLineMessage` refuses it
   (`not_shared_mode`); `evaluateWorkspaceSendReadiness` resolves its own line even when it is not the owner's
   default workspace (`dedicatedWorkspaceId`, shared mode only); `resolveConversationSendLine` ignores the shared-line
   hint for a house in a dedicated workspace; `sendWorkspacePhoneText` (link and code texts) pins the workspace. Vendor dispatch, alerts and
   lead assignment already branch on `workspaceOnSharedLine`.
3. **Entitlement** (`personal-number.ts`, `personal-number-entitlement.server.ts`): `POST /api/manager/messaging-number` `request_number` and
   `provisionNumberForWorkspace` allow Pro / Business (plan read through `resolveEffectiveManagerSkuTier`) or an active PropLane Number
   subscription; PropLane's managed service has no exemption. A Free workspace gets 403 `personal_number_needs_paid_plan` ("This workspace texts from the
   PropLane line."), provisioning code `not_entitled`. Plan words never appear in the refusal.
4. **Settings > Communication > Channels** (`pro-messaging-settings-panel.tsx`): `status.sharedLine = { number, onSharedLine }`
   (null in `per_workspace`, so nothing changes there). A workspace on the line shows a "PropLane line" row (number, Copy,
   no remove); with `canRequest` it also shows "Get your own number" (existing request modal). A workspace with its own
   number shows it as today. `workNumberStatusWord({ sharedLine: true })` = "PropLane line". `lineReady` / `canSend` for a
   workspace on the line come from the send path's own shared-line decision.
5. **Where a number is shown.** Server: `resolveWorkspaceDisplayNumber` (own sendable number, else the line while the workspace
   is on it) feeds the public catalog CTA phone, the single-listing lead route (`resolveSharedLineNumberFor`), listing-channel posts, the resident
   welcome reachability line, resident manager contact, work contact, and house printables (`loadHouseOwnerSmsPhone` takes the
   house's workspace). Client: `workspaceWorkNumber(status)` falls back to `sharedLine.number`, which every compose hint,
   setup banner and reachability caller already reads. Entry codes (door card code, Text code row, their routes) do not exist for
   a dedicated workspace (404 / null): its flyers carry its own number.

Tests: `tests/unit/one-number-{config,shared-config,dedicated-routing,dedicated-outbound,personal-number,personal-number-entitlement,personal-number-route,personal-number-coexist,display-number,channels-shared-line}.test.ts(x)`.

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

## W3 - Entry codes, Unassigned leads, platform lead agent

Spec: "Team routing" steps 6-7 and "Prospect flow" in [`one-number-spec.md`](one-number-spec.md). Tables (foundation migration, no new migration here): `sms_entry_codes`, `sms_unassigned_leads`, `sms_unassigned_lead_turns`. Flag: nothing new. Everything below is behind `line_mode`: the entry-code routes answer 404 and the Text code row draws nothing while the line is `per_workspace`; the lead agent and the nudge sweep only run on the shared line (`shared`; the sweep also refuses `shadow`). Every read of these tables treats 42P01 / 42703 / PGRST205 as "nothing there".

Files (`src/lib/one-number/` unless noted):

- `entry-codes.ts` (pure) - `validateEntryCode` (upper A-Z0-9, 3-16, must hold a letter, never a reserved word: STOP START HELP HUMAN YES NO INFO CANCEL END QUIT UNSUBSCRIBE UNSTOP STOPALL AGENT, plus everyday words such as HELLO / ROOM / TOUR), `entryCodeCandidates` (street word + first digit(s): BROOKLYN5, 8THAVE47), `entryCodeCallToAction` ("Text BROOKLYN5 to (206) 555-0100"), `entryCodeSmsLink` (`sms:+1…?&body=CODE`).
- `entry-codes.server.ts` - `createEntryCode`, `listEntryCodes`, `setEntryCodeActive`, `suggestEntryCode`, `loadDoorCardTextCode`. The house is re-read from `manager_property_records` and must be the caller's workspace's own (a legacy unstamped row belongs to its owner's workspace only). A code is globally unique (primary key, 23505 = "taken", with no hint whose it is). Max 5 live codes per house. Another workspace's code reads as "not found" on toggle and never appears in a list.
- `entry-codes-api.server.ts` + routes `GET|POST /api/portal/one-number/entry-codes`, `PATCH /api/portal/one-number/entry-codes/[code]` - workspace from `resolveListingChannelContext` (never the body), property checked with `propertyInWorkspace`, a code toggled only inside `workspace.propertyIds`.
- UI: `src/components/portal/property-text-code-row.tsx` (the "Text code" row on a property's Promotion tab: full call to action, copy icon, copy-link icon, ⋯ Turn off; a + icon creates the suggestion) and the door card (`/print/door-card/<id>`): a second QR of the `sms:` link and the call to action, from `loadDoorCardTextCode`. The code and the shared number are already public on every flyer, so the printable allowlist (`HOUSE_PUBLIC_SECTIONS`) is untouched.
- `lead-qualifying.ts` (pure) - the five questions in fixed order (budget; move-in date + lease length; area or commute; bath + furnished; household size), deterministic extractors, `touchesProtectedTopic` / `withoutProtectedClauses`, `sanitizeModelFields` / `mergeModelFields`, `toGsm7`.
- `lead-match.ts` (pure) - `matchRooms` over `getCrawlPublicListings()` (the hourly `publicListingProjection` catalog, all workspaces) through `filterRoomListings`; `buildOfferText`; `parseOfferPick`.
- `lead-extract.server.ts` - Claude Haiku (`TIER_MODELS.simple`) through `completeAgentModel`, extraction only, off under `NODE_ENV=test` and without `ANTHROPIC_API_KEY`.
- (deleted by the lane) `lead-redact.ts` - local redaction call site (card / bank / SSN numbers never stored). Swap its body for `redactSensitiveNumbers` (`redact.ts`, transport workstream) when the branches meet.
- `unassigned-leads.server.ts` - `handleUnassignedLeadInbound` (signature unchanged; optional third `LeadDeps` argument for tests), `assignLeadToHouse`, `closeLead`, `listOpenLeads`.
- `lead-followups.server.ts` + `lead-send.server.ts` + cron `/api/cron/unassigned-lead-followups` (hourly at :15, `vercel.json`).
- Admin queue: `src/components/portal/admin-unassigned-leads-panel.tsx`, section `unassigned-leads` in the Accounts tab group (`/admin/unassigned-leads`), routes `GET /api/admin/unassigned-leads`, `PATCH /api/admin/unassigned-leads/[id]` (`{action: "assign", propertyId}` | `{action: "close"}`), guard `admin-leads-guard.server.ts` (`isAdminUser`).

Invariants:

1. The replies are templates. The model only extracts an answer the deterministic extractors could not read, and its output goes through `sanitizeModelFields` (range checks, protected-topic scrub) before it can touch a profile. First reply: "Hi, this is PropLane. Reply STOP to opt out." + the first question. All copy is GSM-7 (`toGsm7`), one question per text.
2. Fair housing is code, not a prompt. Match inputs are price, dates, location and room features only. Household size is stored as a headcount and never filters. A text that asks about, or volunteers, a protected class or the character of a neighborhood or its people (race, religion, national origin, sex, family or children, disability, age, source of income / vouchers, orientation, gender identity, marital or military status, criminal record, "safe area" and so on) gets `NEUTRAL_REPLY` plus the same question again; the flagged clause is dropped before extraction and never reaches the profile, the model, or a filter. The pattern list is deliberately wide.
3. Matching reads only the public projection (never a private row). An offer carries a street line, a price, an availability label and the public listing link, nothing else. An area nobody serves is "no match" (`NO_MATCH_TEXT`), never a far-away room. At most one real https listing photo (`firstOfferPhoto`), never a placeholder. The photo is returned as `UnassignedLeadTurn.mediaUrls`; the seam does not put it on the TwiML yet (see the report).
4. Assignment (`assignLeadToHouse`) happens exactly once per lead: the house is re-read from the database (must be `status = 'live'`, never trusted from the stored offer), it decides the workspace and its owner, and the claim is `update … where status = 'open'`. Then the history is copied through `logManagerSmsMessage` (counterparty role `prospect`, stable `lead:<turnId>` ids, `workspaceId` passed for the transport workstream's stamp) into that owner's conversation, the contact row and `sms_line_sessions` point at the workspace, and only that team gets a `new_lead` alert (`alertWorkspaceTeam`). A prospect's own pick leaves out the triggering text: the pipeline records it when the leasing agent takes over. An admin assignment copies everything.
5. The Unassigned queue is platform-only. The admin routes answer 401 / 403 before any read; phones leave the server masked to the last four digits.
6. Webhook retries are safe: the inbound turn's `message_sid` is unique, and a retry returns the reply stored under `reply:<sid>`. One open lead per phone (partial unique index); a closed or assigned lead's phone starts a fresh lead.
7. Follow-ups: one nudge at 24h quiet, one at 72h, then nothing (flags `nudged24` / `nudged72` in the profile, claimed with an `updated_at` compare-and-swap BEFORE sending and given back when the send fails). Shared mode only, never in quiet hours (21:00-08:00 Pacific), never to an opted-out number, never for leads quiet over 30 days. A `no_match` lead gets one "a room that fits just opened" text when the catalog fits it, which counts as its 24h nudge. `sendPlatformLeadText` sends from the shared number with no workspace (nothing to bill or sign off for) behind the opt-out ledger, quiet hours and the real-customer shield.

Tests: `tests/unit/one-number-{entry-codes,lead-qualifying,lead-match,unassigned-leads,lead-followups,lead-routes}.test.ts`, `tests/unit/{property-text-code-row,admin-unassigned-leads-panel}.test.tsx`, helpers `tests/helpers/lead-fake-db.ts`, `tests/helpers/lead-listing-fixtures.ts`.

## W6 - Knowledge base, learning loop, reply modes, eval suite

Migration `20261018160000_one_number_knowledge.sql` (dev applied, ledger row recorded): `property_knowledge_entries.audience`
(`all` | `residents` | `team`, default `residents`), `sms_escalated_questions`, `sms_ai_reply_drafts`, `sms_knowledge_digests`. All RLS on,
service role only, classified in `account-purge-manifest.ts`. Every read of a new table treats 42P01 / 42703 / PGRST205 as "nothing there".
No flag: nothing here changes behaviour until a manager picks a reply mode, an escalation is answered, or an entry is approved.

Files (`src/lib/one-number/knowledge/`): `topics.ts` (11 reply topics, keyword classifier, `detectAlwaysEscalate`), `ranking.ts`
(keyword overlap, no embeddings), `reply-modes.ts` (pure promote / demote math), `store.server.ts`, `scope.server.ts` (per-role scope
resolvers), `lookup.server.ts`, `approval.server.ts`, `capture.server.ts`, `outcomes.server.ts`, `reply-modes.server.ts`,
`sms-offer.server.ts`, `send-hook.server.ts`, `weekly-digest.server.ts`, `thread.server.ts`, `route-auth.server.ts`, `client.ts`, `prompt.ts`.
Tools: `src/lib/tools/domains/knowledge.ts`.

Invariants:

1. **Read tool `lookup_property_knowledge`** is on the manager (portal + SMS), prospect (leasing), vendor-job and resident registries. Scope is
   re-derived from the context, never the input: manager = active workspace narrowed by co-manager assignment; resident = their lease's house
   (`resolveResidentForwardHouseId`), audiences `all` + `residents` once approved (only `all` as an applicant); prospect and vendor = audience `all`
   only. A `propertyId` from the model is checked against `manager_property_records` for that owner and dropped if it is not theirs. An owner
   with several workspaces and no house resolves to nothing (`needs_house`), never a guess. The shared catalog line (`crossCatalog`) reads nothing.
2. **House details** (`houseInfo`) join the result only for a manager, or a resident past the move-in lock (`phase approved` and
   `moveInDetailsLocked === false`, the same rule as `get_move_in_info`). Never for prospects or vendors.
3. **Answer from facts only.** Prompt rules (`prompt.ts`, appended in `agent/system-prompts.ts`): no result = "Let me check with the team" + escalate;
   money, legal, safety and fair housing always escalate (`mustEscalate` in the result, `ALWAYS_ESCALATE_TOPICS`).
4. **Capture.** Escalation tools (leasing, vendor job, resident `send_message_to_manager` over SMS) record `sms_escalated_questions`
   (best effort). `sendManagerConversationSms` calls `learnFromManagerSend` after an accepted send: a text that answers an open escalation (7 days,
   same owner and phone), or edits a held `draft`, files a **suggested** entry (`manager_answer` / `draft_edit`). Capture never approves.
5. **Approve.** Communication SMS thread: `ThreadKnowledgeCard` (Save / Edit / Dismiss, scope "This house" / "All houses"; only the workspace owner
   may save team-wide). House details > The house: `PropertyKnowledgeList` rows. Settings > Messaging: "Answers for all houses". By text: after an
   escalation answer the manager gets "Save this answer for 5259 Brooklyn? Reply YES." as a `save_knowledge_answer` pending action in their Assistant
   session (the existing YES gate, 24h expiry, skipped when another proposal is open). The text offer is sent only when `line_mode` is not
   `per_workspace` or `ONE_NUMBER_KNOWLEDGE_SMS_OFFER=1`. A co-manager may save only for their assigned houses.
6. **Reply modes.** `sms_topic_reply_modes` per workspace and topic: `draft` (reply stored in `sms_ai_reply_drafts`, not sent, shown in the composer
   as "Assistant draft" with Use draft), `auto_review` (sent and flagged for review), `full_auto`. **A workspace with no rows keeps today's
   behaviour (everything is sent) and records nothing.** The first pick in Settings > Messaging > Assistant replies opts the workspace in and seeds the
   other topics at full auto so nothing else flips; a topic added to the vocabulary later starts in draft for 14 days. A manager's pick is the
   `ceiling`. Nightly cron `/api/cron/one-number-reply-modes` (08:30 UTC): promote one step at >= 100 outcomes, < 2% corrections (edited / rejected /
   corrected_after over the last 100, escalations excluded) and >= 14 days in the mode; demote one step above 5% (needs >= 20 outcomes); never above
   the ceiling. Unreviewed `auto_review` flags older than 3 days count as accepted. A text that touches money, legal, safety or fair housing is held as
   a draft in an opted-in workspace whatever the topic says. The gate (`gateAiReply`) fails open: a settings read error sends the reply.
   Wired in: resident SMS reply (`inbound-pipeline.server.ts`) and the prospect reply (`claw-leasing-bot.server.ts`, `completedWithoutReply:
   "held_as_draft"`). Vendor job replies and manager self-SMS are not gated.
7. **Eval suite** `scripts/one-number-eval/`: `grader.mjs` (facts present, <= 1 segment, escalation both ways, no forbidden / cross-team text, no
   protected-class language, no emoji / curly quotes / long dashes), `fixtures/*.json` (32 hand-written synthetic cases: prospect 10, resident 10,
   manager 6, vendor 6, each with a `gold` reply), `run.mjs`, `export-fixtures.mjs` (dev project only, refuses staging / production refs, redacts via
   `redact.mjs`, writes git-ignored `fixtures/exported/`; `--knowledge-only` writes `fixtures/knowledge.json`, one case per approved entry, for review
   then commit). `npm run eval:one-number` grades the gold replies offline; `-- --replies file.json` grades recorded replies; `-- --live` replays through
   `/api/agent/sms-test` (needs `EVAL_BASE_URL`, `EVAL_COOKIE`, `EVAL_LISTING_ID`; vendor cases are skipped, that surface has no test transport).
8. **Weekly digest** `/api/cron/one-number-knowledge-digest` (Mondays 16:00 UTC): each workspace's top unanswered questions (escalations with no
   approved entry, last 7 days) as one Assistant notice to the workspace owner via `notifyManagerFromAgent`; idempotent per workspace per ISO week.

Tests: `tests/unit/one-number-knowledge-{ranking,lookup,capture,digest}.test.ts`, `one-number-reply-modes.test.ts`, `one-number-eval-suite.test.ts`,
helper `tests/helpers/knowledge-fake-db.ts`.

## W7a - Vendor dispatch engine (manager in the loop)

Source: `src/lib/vendor-dispatch/`. Tables: `vendor_dispatch_*` (`20261018120000`), engine
columns + `vendor_dispatch` audit domain (`20261018120100`). Product notes for the rule
editor and the portal UI belong to W7b; research behind the numbers is
[`vendor-dispatch-research.md`](vendor-dispatch-research.md).

**The loop.** A trigger calls `createDispatchRun` -> the run is `awaiting_approval` and the
owner is texted one segment (`Lockout 5259 Brooklyn Ave NE R3 #7. Send Sam Locksmith $120,
then Lee, Kim if busy? Y/N or 1-3 to pick one`). **Nothing reaches a vendor before an
approval.** Approve -> `offering`: sequential offers position 0, broadcast the first
`broadcast_size`. A vendor's `YES [time] [$price]` accepts, `NO` declines, `BUSY [2h]` parks
the vendor (skipped by `matchDispatchRule` until `busy_until`), a timeout moves on. First YES
wins: the run flips `offering|exhausted -> accepted` in one conditional UPDATE, every other
offered attempt becomes `superseded` and is texted "taken". An exhausted chain texts
`No one took #7. R to retry, B to offer all cleaners at once, or handle it yourself`.
`DONE` -> resident asked "Is it fixed? Reply YES or NO" -> YES completes the service, NO
reopens it and alerts the manager. `INVOICE $amount` -> existing vendor-invoice rails
(`vendor_invoices`, `submitted`), manager `Y` approves and creates the bill; it never pays.

**Files.**

| File | Owns |
| --- | --- |
| `match.server.ts` | Rule precedence + chain (`matchDispatchRule`), roster fallback, reachability |
| `runs.server.ts` | `createDispatchRun`, `approve/decline/retry/cancelDispatchRun` (the portal and SMS both call these) |
| `engine.server.ts` | load helpers, approvers, `advanceRun`, `offerAttempt`, `exhaustRun` |
| `responses.server.ts` | vendor YES / NO / BUSY / timeout, price-over-cap hold, `acceptAttempt`, work-order assignment |
| `completion.server.ts` | DONE, the resident's fixed answer, invoice by text |
| `inbound.server.ts` | deterministic reply handlers called by the inbound pipeline |
| `triggers.server.ts` | service filed, tour booked, checkout -> cleaner |
| `sweep.server.ts` | scheduler tick; `/api/cron/vendor-dispatch-sweep` every 2 minutes |
| `send.server.ts` | the four outbound doors (vendor, teammate, resident, shared-line check) |
| `text.ts` `reply-parse.ts` `time.ts` `triage.ts` | pure: composing, parsing, Pacific time, triage |
| `src/lib/tools/domains/vendor-dispatch.ts` | `list_vendor_dispatches`, `approve_vendor_dispatch`, `dispatch_vendor` |

**Invariants.**

- Rule precedence: a `selected` rule naming the property beats `all`; an issue rule beats
  trade-only; `urgencies` and `hours` (business = Mon-Fri 8-18 Pacific) filter; ties go to
  the newest. No rule: the trade-and-fairness roster ranking. A vendor with no phone, an
  opt-out, `busy_until` in the future or `active: false` is not in the chain.
- Workspace scoping: a run's owner and workspace are read from the run; `handleManagerDispatchReply`
  takes them from the work number the text arrived on (never the body). Handles are per owner
  (`unique (owner_user_id, handle)`). An approver is the owner or a teammate holding Services on the
  house who is not a viewer; a stranger's `Y` is not claimed.
- Replies are parsed before any agent: manager (`Y`, `Y 7`, `N 7`, `2`, `2 7`, `R`, `B`) in
  `inbound-pipeline.server.ts` ahead of the Team chat; vendor (`YES/NO/BUSY/DONE/INVOICE`) ahead of
  `resolveVendorAgentSessionForInbound`; resident YES/NO ahead of the resident agent. Two pending
  items make a bare `Y` refuse with `Which one? Reply Y 8 or Y 7`; an open assistant confirmation
  also blocks a bare `Y`.
- Privacy: an offered vendor reads the general area only (`workOrderGeneralArea`), the job number,
  pay or "quote" and a first name; the street address and entry note go out after they accept;
  a resident's phone or email is stripped from anything a vendor reads (`stripContactDetails`).
- Price: `YES $amount` above `nte_cents ?? pay_cents` (or any price when neither is set) is held
  (`quote_status = pending`), the manager is asked `Mike quotes $240 (cap $180) #7. Y/N`, and the
  vendor's timeout is paused.
- A lockout dispatches only for a texter matched to the house (verified phone + a lease at that
  property); otherwise no dispatch and the manager is alerted. Gas smell, fire and smoke never
  dispatch (`NEVER_AUTO_DISPATCH_ISSUES`, `textIsDangerous`).
- Every decision writes an `action_events` row (domain `vendor_dispatch`, category `maintenance`,
  idempotent on `event_key`) with the verbatim reply. Reported, not hidden: `recordDispatchEvent`
  returns whether the row landed.

**Triggers.** `prepareDispatch` (both service-intake paths) tries `maybeCreateRuleRunForWorkOrder`
first and returns when it made, found or refused a run; with no active rule the legacy proposal path
is untouched. `willDispatchRun` also answers true when a rule would run, so legacy auto-timing and
preferred-vendor offers stand down. Tours: `mutateConfirmedTourSchedule` (append) and
`confirmProspectSmsTourOffer` call `maybeDispatchTourHost`. Checkouts: the sweep reads
`channelStays`/`leaseStays`/`roomDateBlockStays` and opens a `cleaner`/`turnover` run due by the
next check-in at the same house and room. Manager by text: `dispatch_vendor` (the confirm is the approval).

**Flags / config.** No new flag: runs exist only where the manager made a rule. Line mode:
`workspaceOnSharedLine` (`sms_runtime_config.line_mode = shared`) sends through
`sendSharedLineMessage`, falling back to the per-workspace number while that returns
`not_shared_mode`. Prod runs code before migrations: a missing table (42P01, 42703, PGRST205)
reads as "no rules".

**Not done here.** Portal UI (W7b). Vendor accepting an offer from the vendor portal still goes
through bids; a portal decline is mirrored by the sweep. SMS-only vendors (no login) cannot file a
`vendor_invoices` row, so their texted invoice is a manager Y/N on the run only.

## W7b - Vendor dispatch in the portal (roles, rules, runs, vendor offers)

Portal side of vendor dispatch. The engine (matching, run state machine, texting) is
`src/lib/vendor-dispatch/runs.server.ts` and friends (W7a); this workstream never edits
it. Tables: `20261018120000_vendor_dispatch_rules.sql` (no new migration here).

**Vendor roles on the roster row** (`manager_vendor_records.row_data`):
`dispatchTrades` (ids from `VENDOR_TRADES`), `serviceArea`, `dispatchRateCents` +
`dispatchPayModel`, `insuranceExpiresAt` (yyyy-mm-dd), `licenseNumber`, `dispatchAvailable`
(absent = available; only `false` takes the vendor out of dispatch). Normalized on every
read and write by `normalizeVendorDispatchFields` (`vendor-roles.ts`) inside
`normalizeRow` in `/api/portal-vendors`: unknown roles, bad numbers and impossible dates are
stripped. `vendorDispatchRoles(row)` returns the explicit roles, else maps the legacy
trade labels ("Plumbing" -> plumber); use it (not `row.trade`) wherever the engine asks
"does this vendor take this job". Edited on the vendor form's Dispatch step; shown as a
glyph fact on Your vendors rows; Filter > Dispatch role narrows Your vendors.

**Dispatch rules** (`rules.ts` pure validator, `rules.server.ts` CRUD, `access.server.ts`
actor): routes `GET/POST /api/portal/vendor-dispatch/rules`,
`PATCH/DELETE .../rules/[id]` (PATCH `{ active }` pauses). Workspace and owner are
re-derived from the session (`resolveActiveWorkspaceFromRequest`), never the body. Every
vendor id must be a `manager_vendor_records` row of the workspace owner; every house id must
be in `workspace.propertyIds`. A co-manager needs the Services module (`linkedOwnerScopeForModule`):
read to list, edit to create/update, delete to delete; a workspace-wide rule needs every
house of the workspace, a selected rule every listed house; a rule on houses they do not hold
reads as not found. Chain order = `vendor_dispatch_rule_vendors.position` (0 = primary).
UI: Vendors > Dispatch tab (`dispatch-rules-list.tsx`), editor `dispatch-rule-editor.tsx`
(Job, Houses, When, Vendors, Offer, Pay).

**Runs on the service record**: `GET /api/portal/vendor-dispatch/runs?sourceType=&sourceId=&status=`
(read, scoped to workspace + owner, house-scoped for co-managers; through `sharedGet` via
`useDispatchRuns`) and `POST .../runs/[id]` `{ action: approve | pick(position) | decline |
retry | broadcast | cancel }`, which calls `runs.server.ts` with `channel: "portal"` and the
session as approver. Dispatch is a section on the service Overview
(`service-dispatch-section.tsx`) and a Services Filter field ("Waiting for your approval");
it is never a stage bucket (`service-lifecycle.ts` vocabulary unchanged).

**Vendor portal**: `GET /api/vendor/dispatch-offers` (own offered attempts; `offer_text` only,
no house or workspace id) and `POST /api/vendor/dispatch-offers/[attemptId]` `{ answer }`
(`vendor-offers.server.ts`). The answer is a compare-and-set: attempt `offered -> accepted |
declined`, then run `offering -> accepted`; the SMS parser must use the same transitions.
Shown above the Open tab of the vendor's Services (`vendor-dispatch-offers.tsx`).

Tests: `tests/unit/vendor-dispatch-{rules,rules-route,runs-route,vendor-offers}.test.ts`.

## W4 - Phone-bound links, one-time codes, public phone-bind, hashed share links

Flags: nothing here changes `per_workspace`. `send_my_link` is added to a surface's registry only in `shared` mode (`withSendMyLinkTool`, one `sms_runtime_config` read, fails closed to the unchanged registry) and mints only for a workspace on the shared line. The `/l`, `/apply`, `/tour` pages and their APIs are inert without links/entry codes. Migration `20261018150000_share_links_token_hash.sql` (applied to dev) is additive; code runs before it (a missing `token_hash` column falls back to the raw column).

Files:

- `src/lib/one-number/links.server.ts` - `mintPhoneBoundLink` (32-byte base64url token, only SHA-256 stored in `phone_bound_links.token_hash`, expiry/`requires_otp` from `PHONE_BOUND_LINK_POLICY`, a newer link for the same phone+purpose+target revokes the older, 20 mints/phone/hour, refuses a classified test-workspace owner), `resolvePhoneBoundLink` (unknown, malformed, expired, revoked, used all `null`), `revokePhoneBoundLinksForTarget`, `markPhoneBoundLinkUsed`, `createLinkSession` / `verifyLinkSession` (hash-only `phone_bound_link_sessions`; 30 min for rent + payouts, 7 days otherwise, never past the link), `linkSessionCookieName`. URL `/l/<token>` on `resolveEmailLinkBaseUrl()`.
- `phone-otp.server.ts` - `phone_otp_challenges`: 6 digits, keyed HMAC (`PHONE_OTP_HMAC_SECRET`, else the service-role key) bound to challenge id + phone, 10-minute expiry, 5 attempts (counted before comparing, by compare-and-set), at most 3 sends/phone/hour across all purposes, a failed send leaves nothing behind, newest code only.
- `link-text.server.ts` - `sendWorkspacePhoneText`: `sendSharedLineMessage` when the workspace is on the shared line (falls back to the work number only on `not_shared_mode`, i.e. before W2's sender is live), else `sendFromManagerWorkNumber` (transactional, `skipLog`).
- `link-unlock.server.ts` - the code goes ONLY to `link.phoneKey`; a correct code opens a session.
- `link-destinations.server.ts` - target -> destination, re-derived from live rows and re-checked against the link's workspace and phone: gallery/tour/application -> public pages (application prefilled with the phone), rent -> in-page card payment, job -> a fresh hashed `service_share_links` link bound to the phone (one live per phone per job), lease/move-in/payouts -> sign-in then the portal page. A closed job revokes its links.
- `public-bind.server.ts` - `sms_entry_codes` lookup (case-insensitive, active, house still in the workspace), code to the typed phone, then a bound link + session and the thread note "Opened the application link".
- Routes: `src/app/api/l/[token]/code`, `src/app/api/l/[token]/rent-checkout` (`createHouseholdChargeCheckout`, hosted card, resident + charge from the live row, metadata from the core), `src/app/api/public/phone-bind`. Pages: `src/app/(public)/l/[token]`, `apply/[code]`, `tour/[code]`; UI `src/components/public/phone-bound-link-ui.tsx`.
- `src/lib/tools/domains/one-number-links.ts` - `send_my_link` for resident SMS (rent / move_in / lease), leasing SMS (gallery / tour / application + propertyId), vendor SMS (job). A read tool: it mints a link to the texter's own phone (phone read from the verified profile / session, never from the model) and the reply carries it.
- Share links: `src/lib/share-token-hash.ts`; `portal_record_share_links` and `document_share_links` store `token_hash` only, the raw token is returned to the creator once, resolve is hash first then the legacy raw column; the raw column is read-only (trigger) until it is nulled after 2026-12-17.

Invariants: every refusal on a link reads the same ("This link has expired"); a page never reads its target before the code; the code step takes no destination; ids in a body are never authorization (rent checkout re-derives resident, charge and manager from the live charge row).

Tests: `tests/unit/one-number-{links,phone-otp,link-unlock,link-destinations,public-bind,link-routes,link-text,send-my-link-tools}.test.ts`, `share-link-token-hash.test.ts`, `phone-bound-link-ui.test.tsx`; helper `tests/helpers/links-fake-db.ts`.

## W5 - Phone-first app sign-in

Shared mode only: `/auth/sign-in` puts phone first, then the existing Apple/Google and email methods. `/auth/verify-phone` and the shared settings links handle initial verification and old/new-number codes. `getPortalAccessContext` gates every portal server-side; the verification page reads the session directly. Per-workspace and shadow retain the existing sign-in and phone editors.

`src/lib/auth/phone-auth.server.ts` and `/api/auth/phone/{start,verify}` use six-digit challenges, 10-minute expiry, five attempts, and three sends per rolling hour across purposes. Hashes are challenge-bound HMACs, browser proofs are HTTP-only cookies, and every error is neutral. SQL serializes attempts, consume, account/phone leases, attachment, and both-code number changes. `verified_at` is distinct from invalidated/consumed codes. The same transaction updates the profile, global texter contact, Supabase Auth phone and its phone identity. Profile and Auth triggers close legacy/direct phone-edit bypasses only in shared mode.

Development defaults to the local challenge flow. It resolves existing verified profile/Auth/contact owners before account creation, refuses conflicting ownership, and mints a Supabase session by an admin-generated token hash verified on an isolated client. New phone-only accounts use random non-deliverable `@phone.proplane.invalid` Auth addresses; no email is sent. Session identity is checked twice and tokens are installed in SSR cookies, never returned by the route. Existing email/social accounts retain their identity and roles.

The standard-webhooks signed `/api/auth/hooks/send-sms` path uses our `phone_verification` transport, the shared sender/service when enabled, and the platform verification sender otherwise. A shared-mode hook must claim a pending native challenge before sending, so direct Auth calls cannot bypass the application's send budget. `SUPABASE_PHONE_AUTH_HOOK_ENABLED=true` opts existing canonical Auth phone accounts into Supabase OTP; first-time/legacy attachment still uses local challenges. Hosted setup is documented in `supabase/config.toml`; keep public phone signup disabled. No hosted Auth configuration is changed by this work.

`POST /api/auth/phone/reset` lets the verified owner of the active workspace release an established resident/vendor's lost phone. Both the helper and SQL re-derive the relationship and refuse self-reset, manager/admin targets, wrong workspace and conflicts. It clears phone proofs and credentials atomically and audits the release; it never chooses a replacement or mints a session. The person must then verify their replacement phone.

The resident/vendor Communication projection reader accepts shared rows with no legacy work line only after verifying the phone, role and stamped workspace owner; turns remain scoped to that workspace. Prior SMS is read through that projection, never copied to another tenant.

Migrations: `20261018180000_phone_auth.sql`, `20261018180001_phone_auth_reset.sql`. New lease state is service-only/RLS and classified in the purge manifest. Tests: `phone-auth*`, `phone-otp-delivery`, `shared-phone-settings`, `one-number-legacy-phone-writes`, resident/vendor conversation suites, and the rollback-only `tests/integration/phone-auth-transitions.sql`. The Auth identity shape follows [Supabase's identity model](https://github.com/supabase/auth/blob/master/internal/models/identity.go); session minting follows [generateLink](https://supabase.com/docs/reference/javascript/auth-admin-generatelink) and [verifyOtp](https://supabase.com/docs/reference/javascript/auth-verifyotp).

W5 validation (2026-10-18): both migrations applied to **dev/test only** with migration ledger rows. `npx tsc --noEmit` exit 0; 18 targeted Vitest files / 280 tests passed (17-file run: 277, transport override: 3), and the changed profile guard's 12 tests passed again after its TypeScript fix. Both transaction-only SQL proof scripts passed, including manager reset via accepted invite and submitted vendor bid. A temporary dev account completed challenge → bind → server-generated token hash → valid Supabase session; the account, contact and proofs were cleaned up, no SMS sent. Mobile browser verified the flag-off Apple/Google/email form, disabled phone status, invalid-proof refusal and signed-out verification redirect. The new form's active states are covered by interaction tests; live SMS/OAuth-provider end-to-end testing remains for rollout, since the shared flag and hosted hook were deliberately not enabled. Manager reset currently has an authenticated API, not a new settings button.

Spec: [`one-number-spec.md`](one-number-spec.md). Shared contracts: `src/lib/one-number/contracts.ts`.
Each workstream owns one section below.

## W2 - Shared-line transport, MMS, redaction, workspace stamps

**Line mode** lives on `sms_runtime_config` (`line_mode`, `shared_number_e164`,
`shared_messaging_service_sid`, `shared_pilot_workspace_ids`). Transport reads it with
`readSharedLineConfig` (`src/lib/one-number/shared-line-number.server.ts`), which is tolerant:
any error or a missing column/table (42P01, 42703, PGRST204/205) reads as `per_workspace`, so
nothing changes until the switch is flipped. Only `shared` sends from the shared number;
`shadow` never does. `shared_pilot_workspace_ids` empty = every workspace.

**Send path (one door, same outbox).**
- `sendSharedLineMessage` (`send.server.ts`) -> `sendFromManagerWorkNumber` -> `enqueueOwnerSms`
  -> `dispatchOwnerSmsOutbox`. Consent, quiet hours, protected-account shield, test capture,
  workspace wallet reservation and delivery status are the work-number path's own.
- `evaluateWorkspaceSendReadiness` has a shared-line branch (`viaSharedLine`): runtime kill
  switch + owner allowlist still apply, consent stays scoped to the deployment's
  `TWILIO_MESSAGING_SERVICE_SID`, billing is the stamped workspace's wallet. The provider call
  uses the shared Messaging Service (`providerMessagingServiceSid`).
- `sendSms` (`src/lib/twilio.ts`) accepts the configured shared number as a `from` (no fake
  `manager_sms_numbers` row) but still demands a reserved, matching credit hold.
- The pre-submission recheck also runs for shared sends and compares From + workspaceId.
- Human replies from the inbox (`manager-sms-send.server.ts`, `/api/portal/send-inbox-message`)
  on the shared line carry "<house or workspace name> team" (`resolveSharedLineHumanSend`,
  `appendSignOff`). The sign-off uses a plain hyphen: a long dash would make the text UCS-2.

**Workspace stamps.** `workspace_id` is written on `sms_outbox` (enqueue), `manager_sms_messages`,
`inbound_sms_log`, `manager_sms_contacts` through `withWorkspaceStamp`
(`workspace-stamp.ts`), which retries without the column when it is not migrated. DB triggers
stamp `sms_inbound_receipts` (from the claim payload's `workspaceId`) and `sms_projection_turns`
(from the conversation). No read changed.

**Conversation identity on the shared line.** There is no `manager_sms_numbers` row for the
shared number, so a shared-line conversation lives on a synthetic work line whose id IS the
workspace id (`resolveSmsProjectionWorkLine({ workspaceId })`). It is projected by
`project_shared_line_event` (migration `20261018110000_one_number_transport.sql`; the
work-number RPC is untouched), keyed (owner, role, workspace, identity) with
`line_kind = 'shared'` and a partial unique index on the stamped workspace. The same phone in
two workspaces of one owner is two conversations. Readers that join `work_line_id` to
`manager_sms_numbers` will not find a row for these; resolve a shared line by `line_kind`.

**MMS (every role).** `ingestInboundMedia` (`inbound-media.server.ts`), called from
`processClaimedInbound` right after the receipt is logged, downloads each item with the
validated Twilio fetch (`fetchTwilioMessageMedia`), stores it in the private `sms-media` bucket
(`manager/<owner>/<sid>/<n>.<ext>`) and indexes it in `sms_media_files`. Idempotent per
(message_sid, media_index). Links: resident maintenance -> `work_order` (photos in the last 30
min are put on `row_data.photoDataUrls` and linked in `createWorkOrderFromResidentSms`); vendor
on an open job -> `vendor_job` (+ `completionPhotoDataUrls`); prospect/manager unlinked. The
inspection photo intake is unchanged. Bubbles show images inline (`SmsMediaImages`); the read
URL is `/api/sms-media` -> a signed URL with `download: true` (never inline); the route lets the
owner and accepted team members of the file's workspace in, and fails closed otherwise.

**Redaction.** `/api/twilio/inbound` replaces Luhn-valid card numbers and bank/routing numbers
with `[redacted]` (`redact.ts`) before the receipt, projection, inbound log or any agent sees the
body, and flags the receipt payload `redacted: true`. The reply for such an inbound is replaced
with the secure-link notice in every agent deliverer (`redactedInboundReplyOverride`).

**Segment guard.** `toGsm7` / `smsSegmentCount` (`segments.ts`) run in the manager, resident,
leasing and vendor agent reply deliverers and in `sendSharedLineMessage`. Text that is already
GSM-7 is returned unchanged.

## W11 - Preset auto-sends (Automations), house facts, escalations inbox

Spec: `texting-plan-1018` "Preset auto-sends", "Resident fast path" (house facts) and "New data". Migration
`20261018200000_automations.sql` (dev applied, ledger row recorded): `workspace_automation_settings` (workspace, preset,
mode `auto|draft|off`, optional wording), `workspace_automation_runs` (the ledger; `unique (workspace_id, idempotency_key)` is the
idempotency, `held` = a draft waiting), and `sms_escalated_questions` gains `source` (`agent|ra|unanswered`), `excerpt`,
`resolved_by`. Both new tables are RLS-on, service role only, classified in `account-purge-manifest.ts`. Every read treats 42P01 /
42703 / PGRST205 as "nothing there".

**Presets** (`src/lib/automations/presets.ts`, pure). Ten from the spec table plus `arrival_guide` and `checkout_reminder`, which
claude-2's check-in/out times work fires through `fireAutomation` (below); they draw in Settings only once their id is added to
`EXTERNAL_PRESETS_LIVE`. Two engines: `existing` presets (`rent_due_3d`, `rent_late_3d`, `maintenance_booked`, `move_out`) gate a
message the product already sends, `off` stops it (payment-reminder cron via `presetForScheduledPaymentKind`, `workOrderEvent` for the
resident's visit notice, `sweepTenancyReminders` for the move-out checklist; all through `loadOffPresetResolver`, which fails OPEN) and
nothing else about today's behaviour moves; `automation` presets are the new texts. New presets default `draft`; `announcement` defaults
`auto` (the manager already said send). Rent late stays 1:1; a group preset never offers a name, room, amount, pay link or secret
(`GROUP_FORBIDDEN_VARIABLES`, enforced by `validateTemplate`).

**Flag safety.** The sweep serves a workspace only when it has picked a mode for at least one preset (`loadOptedInWorkspaces`) or is on
the shared line; a workspace that never opens Automations keeps today's behaviour. The first pick opts it in and every other new preset
then runs at its default (draft).

**The spine.** `sweep.server.ts` (`sweepAutomations`) rides the existing 5-minute `/api/cron/dispatch-reminders` tick: no new cron.
`moments.ts` is the pure date logic (3 days before move-in, lease signed in the last 7 days, move-in / rent due / move-out today,
pickup the evening before, monthly cleaning on the 1st, nothing before 9 am or after 9 pm Pacific or inside the house's own quiet
window); `sources.server.ts` loads signed leases (`portal_lease_pipeline_records`), their houses, rent charges due today and services
scheduled in the last day (`action_events`). `fire.server.ts` `fireAutomation(db, { workspaceId, ownerUserId, preset, idempotencyKey,
vars, target })` is the one door: off -> nothing recorded; draft -> held (a pending `sms_ai_reply_drafts` row in the resident's
thread, `topic = automation:<preset>`, plus the run row; a group draft is the run row alone, listed under Settings > Automations);
auto -> sent. A quiet-hours / budget / rate-limit refusal releases the claim so a later tick retries; opt-out, no consent and no group
are recorded as `skipped`. 1:1 goes through `sendResidentAutomationText` (`sendSharedLineMessage` on the shared line, else the work
number with scoped automated consent). Group posts go through `postToHouseGroup` (`src/lib/house-groups/post.server.ts`; W10 owns the
body, the stub answers `not_enabled`) after `houseGroupReady` (`ready.server.ts`, reads `house_group_conversations`, false until W10's
table exists). A group-only preset with no group is silent (no draft); `announcement` and house-wide `maintenance_booked` fall back to
one text per resident (never a name, amount or secret either way). `approveHeldRun` re-checks a held group text against who lives
there NOW; `reconcileHeldRuns` follows a draft the manager handled from the thread.

**Templates** (`templates.ts`). `{variable}` from a fixed list, filled from data only (never an AI-written amount); a sentence whose
variable is empty is dropped whole; GSM-7. `groupTextViolations` refuses money, any resident's first name and any house secret in
the RENDERED group text (templates, announcements alike).

**House facts** (`src/lib/house-info.ts`, additive). New fields: recycling day, manager contact, `rules.escalateAfter` (complaint
threshold, a `count` stepper). `HouseInfoField.secret` marks door code, gate code, lockbox, Wi-Fi password and alarm
(`houseInfoSecretValues`, `containsHouseSecret`); `.internal` marks the threshold (never drawn to a resident or printed). Recycling day
is resident-only: `TRASH_PUBLIC_KEYS` no longer lists it, so the public page and printables are unchanged (C2-RE12). Secrets reach only a
verified current resident past the move-in lock (W6 lookup scope, `loadMoveInDetailsLock` in the move-in text), never a prospect, a
vendor, the public listing or a group post.

**Announce.** `announce.server.ts` `announceToHouses` (houses re-derived from the actor's workspace; a co-manager only their own);
route `POST /api/portal/automations/announce`; manager chat/SMS tool `announce_to_house` (confirm gate; with several houses and none
named the preview refuses with "Which house: A, B, or all?"; registered in `COMMUNICATION_SENDING_TOOLS` and the MCP exclusion list).
UI: megaphone icon in Settings > Communication > Automations opens the pop-up.

**Settings UI.** `automations-settings.tsx` (`AutomationsSection`, mounted after "Answers for all houses"): held drafts first (Send /
Dismiss icon actions), then one row per preset (glyph for 1:1 or group, mode dropdown, "Edit text" in the row menu for presets that own
their wording). `AutomationTextModal`: plain "Insert" dropdown (no chips), live preview from one real resident. Routes under
`/api/portal/automations` (`GET`, `PUT` owner only, `preview`, `runs/[id]`, `announce`).

**Escalations inbox.** `escalations.server.ts` (`listEscalations`, `resolveEscalation`, `recordEscalationItem`, `recordHouseComplaint`),
route `GET|PATCH /api/portal/one-number/escalations`, page `/portal/communication/escalations`
(`manager-escalations-inbox.tsx`, `PortalRecordListSurface`, Open | Resolved, reached by the triangle icon in the Communication header,
`manager-escalations-action.tsx`). Phones leave the server as the last four digits. W10's RA calls `recordEscalationItem` (source `ra`)
and `recordHouseComplaint` (logged quietly; the complaint that reaches the house's threshold files ONE open "repeated complaints"
item with the excerpt; no punishment by AI).

Tests: `tests/unit/automations-{presets,templates,moments,house-facts,fire,sweep,store,escalations,routes,announce-tool,door-code-reach,service-visit-gate}.test.ts`,
`tests/unit/automations-settings.test.tsx`, helper `tests/helpers/automations-fake-db.ts`.

## W10 - House group chats with an AI RA (Twilio Conversations group MMS)

Spec: [`texting-plan-1018`](../../../.cockpit/briefs/texting-plan-1018.md) § House group chats, § Preset auto-sends, § Risks. Migration `20261018190000_house_groups.sql` (dev applied, ledger row
recorded): `house_group_settings`, `house_group_conversations`, `house_group_members`, `house_group_preferences`, `house_group_messages`; all RLS on,
service role only, classified in `account-purge-manifest.ts` (`house_group_members` is purged with the resident). Every read treats 42P01 / 42703 / PGRST205 as "nothing there".

**Flags.** Groups exist only when ALL hold: `sms_runtime_config.line_mode = 'shared'` with a shared number, the workspace is on the pilot list (or the list is empty), and
`house_group_settings.enabled` is on for the workspace (default off, the owner flips it in House details > House chat). Per-workspace mode behaves exactly as before: the
new route answers 404, the seam hook finds no chat-enabled house, every post answers `not_enabled`.

**Architecture.** 1:1 texts stay on Programmable Messaging (`/api/twilio/inbound`). Conversations is used ONLY for house groups; address autocreate must stay OFF for the shared
number or it would take 1:1 traffic. Residents join as SMS participants (`messagingBinding.address`), PropLane joins as chat identity `proplane` with `projectedAddress` = the shared
number. Each conversation gets its own `onMessageAdded` webhook (`conversations-gateway.server.ts`); the URL is `TWILIO_CONVERSATIONS_WEBHOOK_URL` or `<canonical origin>/api/twilio/conversations`.
Twilio limits: group MMS is US/Canada long codes only, 20 addresses max by the API but the product caps at ten including PropLane (`GROUP_MEMBER_CAP = 9`).

Files (`src/lib/house-groups/`):

- `members.ts` (pure) - `selectGroupMembers`, `memberHash`, `diffMembers`. `residents.server.ts` - `candidatesFromStays` (pure) over the Bookings occupancy snapshot (`occupancySnapshotForManager`): a stay with a `resident` payload (executed lease or approved hold) lasting 30+ days or open-ended is long-term; a guest-portal short stay has no resident payload and is never a member.
- `ra-policy.ts` (pure) - `classifyGroupText`, `planGroupReply`, `planDueCheck`, `groupPreferenceCommand`. `facts.ts` (pure) - `composeFactReply`. `copy.ts` - every line the RA says. `time.ts` - Pacific quiet hours.
- `store.server.ts` (all table access), `conversations-gateway.server.ts` (the only Twilio Conversations calls), `post.server.ts`, `manager.server.ts`, `ra.server.ts`, `announce.server.ts`, `consent.server.ts`, `webhook.server.ts`.
- Manager tool `announce_to_house` (`src/lib/tools/domains/announce.ts`, the ONE announce tool: posts to each house group, one on one when a house has no group), routes `GET|POST /api/portal/house-groups`, `GET|POST /api/resident/house-chat`, `POST /api/twilio/conversations`, crons `/api/cron/house-group-sync` (daily 17:10 UTC) and `/api/cron/house-group-sweep` (every 5 minutes).
- UI: `PropertyHouseChatList` rows in House details (status, one row per member by first name + room, Announce and Update members icon actions, Turn on/off in the row menu, over-nine and not-joined warning rows); an optional checkbox on the resident's lease signing window.

Invariants:

1. **One door for posts.** `postToHouseGroup(db, { workspaceId, propertyId, text, kind, idempotencyKey })` -> `{ ok: true, messageSid } | { ok: false, reason: 'no_group' | 'not_enabled' | 'quiet_hours' | 'rate_limited' | 'provider_error', detail? }`. The RA, manager announcements and W11's presets all go through it. It re-checks the group belongs to the workspace, refuses 10 pm - 8 am Pacific (only `kind: "emergency"` posts), caps non-exempt kinds at `max_posts_per_day` (default 4; `announcement`, `emergency`, `intro` are exempt), reserves `members x segments` of `sms_outbound_segment` from the workspace wallet BEFORE Twilio and releases it on failure (`detail: "budget"` when refused), refuses a group holding a protected account's phone outside production, and claims the idempotency key on `house_group_messages` first so a retry returns the first send.
2. **A group is defined by its member list.** `member_hash` = digest of the sorted phone keys. Desired members = long-term residents with a verified phone, `consent_at` set, not "left", not STOP (global ledger), earliest move-in first, at most 9; fewer than two = no group; extras get 1:1 and the team gets one alert a day. Any difference makes a NEW Conversation (intro posted, "This is the new house thread, the old one is retired." when replacing, "Welcome <newcomers>"), the old one is `retired` (kept open; its first stray text gets ONE reply pointing to the new thread), leavers get a 1:1 goodbye. A retired group whose exact list returns is reactivated, so two open Conversations never share a member set. Retired groups close after 30 days. Nothing is created or replaced 10 pm - 8 am (the next run does it). A failed rebuild puts the old group back. Runs daily (cron), on early move-out (`amend-lease` POST, direction decrease), on "Update members", and on every consent change. Idempotent.
3. **The RA is quiet.** Speaks only when addressed ("PropLane"), when a house-fact question has sat ~10 minutes with no housemate reply (sweep), for a complaint, a neutral rules reminder, or an emergency. No small talk. A complaint in the group gets exactly "Got it, I'll follow up with you directly." plus a 1:1 to that resident; at night the group post is skipped and the 1:1 is held to 8 am. A second rule issue in 7 days posts a neutral reminder; the third, safety, harassment and discrimination notes go to the team with the excerpt (no group post, nobody named or punished); an emergency word posts the safety reply and an urgent team alert at any hour. At the daily cap an addressed question is answered 1:1.
4. **Answers come from approved facts only** (`lookupPropertyKnowledge` with a resident scope for that house): first name and room only, never another resident's details, never an amount. A door code, lockbox, gate/alarm code, Wi-Fi password or anything in an access section is NEVER posted in the group: the thread gets the open part plus "I'm texting you that privately." and the asker gets the secret 1:1. Money, legal, safety and fair-housing questions are acknowledged, texted to the asker and escalated. No approved answer: "Let me check with your landlord and get back to you." plus a team alert.
5. **Consent.** Housemates see each other's number and PropLane reads the thread, so a resident is added only with a recorded yes: the optional checkbox on the resident's lease signing window (`lease_signature`, saved by the server against the signed-in account's verified phone), or the text "join group" (`sms_join`). A resident who lives in a chat-enabled house without consent is offered it once, privately (`house-group-offer:<workspace>:<phone>`). "leave group" (1:1 or in the group) sets `opted_out_of_group`, confirms privately, and the next sync removes them; "join group" reverses it. Both are handled before routing in `handleSharedLineInbound`.
6. **Webhook.** `POST /api/twilio/conversations` verifies `X-Twilio-Signature` against the exact registered URL (403 on mismatch; no signature = 403 on Vercel/production), acknowledges at once, and works in `after()`. Dedupe is the unique (group, MessageSid) index; PropLane's own posts (`Author = proplane`) are ignored.
7. **Manager.** The owner turns house chat on per workspace; managers never join the thread. "announce: water off Tuesday 9-12" -> `announce_to_house` (write tool behind the YES gate; with several houses and none named it refuses with "Which house: A, B, or all?"; groups first, one on one when a house has no group; ids are re-checked against the workspace; delegated co-managers do not get it). The House chat section posts to its own house.

Tests: `tests/unit/house-groups-{members,ra-policy,post,sync,ra-handler,routes}.test.ts`, helpers `tests/helpers/house-group-fake-db.ts`, `tests/helpers/house-group-fixtures.ts`. Twilio is mocked; a live group proof needs the shared number.

Not done: move-out checklist link in the leaver's goodbye (no `move_out` link purpose exists; the text offers it by reply), booking-acceptance consent (only the lease signing window carries it), a STOP does not remove a member until the next sync, and the live Twilio proof (blocked on the shared number and campaign registration).

## W-int - Integration seams

- **One config reader.** `config.server.ts` (`loadSharedLineConfig`, `workspaceOnSharedLine`, `isSharedLineNumber`, `isMissingSchemaError`) is the only implementation; fail closed to `per_workspace` (read error, unknown mode, `shared` without a number). `shared-line-number.server.ts` keeps only transport helpers (`isConfiguredSharedNumber`, `resolveSendWorkspaceId`, `resolveSharedLineHumanSend`, sign-off) and re-exports the config names. `readSharedLineConfig` / `sharedLineActiveFor` are gone. `workspaceOnSharedLine` is false for an empty workspace id. `vendor-dispatch/send.server.ts` `workspaceOnSharedLine(db, ws)` delegates to it.
- **Platform lead texts** (`lead-send.server.ts`) go through `sendSms` with `purpose: "platform_lead"`: valid only from the configured shared number, no credit hold (no workspace to bill), still behind the opt-out ledger, the real-customer shield and test capture; quiet hours stay in `sendPlatformLeadText`. No platform usage meter exists, so these texts are not metered.
- **One redaction.** `redact.ts` `redactSensitiveNumbers` (card, bank, dashed SSN with kind `ssn`); `lead-redact.ts` is deleted. The secure-link reply text is unchanged for an SSN.
- **Lead photo.** `routeSharedLineInboundWithReply` returns `unassignedMediaUrls`; the seam returns `mediaUrl` (never on an emergency reply); `twimlOk(reply, mediaUrl)` draws `<Message><Body/><Media/></Message>` only for an https URL.
- **Prospect burst stamp.** `loadBurstWorkspaceId` (prospect-sms-burst-job) reads `sms_inbound_receipts.workspace_id` for the claimed message ids, requires one workspace held by the burst's owner, and passes `workspaceId` to `handleClawLeasingInbound`. Null (nothing stamped, column missing) changes nothing.
- **Shared-line readers.** A shared-line conversation has `work_line_phone` = the shared number and `work_line_id` = its workspace id, so `manager_sms_numbers` joins find nothing. `sharedLineWorkspaceIdOf` (`line-label.ts`) recognises it; the Communication list/detail pass `sharedLineWorkspaceId` to `conversationVisible` (placed by that workspace alone, no house tag needed); `ManagerSmsResidentConversation.sharedLine` drives the Text line picker label "PropLane line"; `resolveConversationSendLine` returns `via: "shared"` (numberId null, the shared number) when `line_mode = shared` and the thread used it, and `sendInboxMessage` refuses with 409 when such a thread cannot send on the line instead of using a work number. `per_workspace` is unchanged (the extra config read happens only when a hint matched no work line).
- **Outbound MMS.** Migration `20261018240000_sms_outbox_media_urls.sql` (applied to dev, ledger row recorded) adds `sms_outbox.media_urls text[]`. `SharedLineSend.mediaUrls` -> `sendFromManagerWorkNumber` -> `enqueueOwnerSms` (https only, max 10; insert retried without the column before the migration) -> dispatcher reads it for `shared_line_message` rows only -> `sendSms` `mediaUrls`. Credit is still reserved by text segments; MMS is not priced separately.

Tests: `one-number-{shared-config,config,lead-send,redact,twiml-media,burst-workspace,shared-line-readers,outbox-media,send-door,sendsms-shared-from,inbound-seam}.test.ts`.

## W9 - Delivery feel: bubbles, burst debounce, resident fast path, latency log

Migration `20261018210000_one_number_feel.sql` (dev applied, ledger row recorded): `sms_runtime_config.feel_settings jsonb`;
nine additive columns on `sms_projection_turns` (`intent`, `reply_lane`, `model_used`, `fast_path`, `bubble_count`, `first_bubble_ms`,
`total_latency_ms`, `reply_status` in sent / draft / none, `replied_at`); table `sms_reply_debounce` (service role only, classified in
`account-purge-manifest.ts`) with RPCs `sms_debounce_register` / `_claim` / `_settle`. Every read tolerates 42P01 / 42703 / PGRST205.

**Switches** (`feel-settings.server.ts`, `loadFeelSettings`): `bubbleReplies`, `residentFastPath`, `debounceMs`, `workAck`. Defaults are ON
(1500 ms) for a workspace on the shared line and OFF for a work number, so `per_workspace` behaves exactly as before. Override per lane in
`sms_runtime_config.feel_settings` as `{"shared": {...}, "work": {...}}`; 15 s in-process cache; wrong types ignored; debounce clamped 0-5000.

**Bubbles.** `bubbles.ts` (pure): `splitIntoBubbles` strips markdown, makes the text GSM-7 (emoji kept only when the texter used one),
packs sentences greedily into bubbles of one segment, at most 3 (overflow stays in the last, nothing is dropped), never splits a URL.
`bubble-delivery.server.ts`: bubble 1 is sent inside the request through the caller's own send; bubbles 2-3 follow 500-800 ms apart,
sequentially, in `after()` (no `setTimeout` in the handler; falls back to inline outside a request). A refused bubble stops the rest.
Idempotency: bubble 1 keeps `inbound_reply_<sid>`, the rest `..._b2`, `..._b3`, so a replay (which re-splits the stored reply body) sends
nothing twice. Wired into `deliverResidentSmsReply`, `deliverManagerSmsReply`, `deliverLeasingSmsReply`, `deliverVendorAgentReply` through
`deliverAgentReply`: a deliverer bubbles only when told (`bubbles`) or when a `workspaceId` resolves to a bubbling lane, so every other
caller is unchanged. A tour-booking confirmation is never split; a prospect burst's revision fence and booking id ride bubble 1 only.

**Burst debounce.** `debounce.server.ts`: each inbound registers its text (revision per text), sleeps `debounceMs`, then claims; the newest
revision answers every text of the burst merged oldest first, older invocations yield (claim completed, no reply; the resident path still
runs its team forwards). `settle` drops the answered texts once the reply is durable. A text carrying a photo registers and merges but does
not wait. Fail-open: any RPC problem answers at once with that text alone. Wired for manager, resident and vendor-session replies;
prospects keep their durable QStash burst queue (`prospect-sms-burst*.ts`, 10 s quiet window) untouched.

**Resident fast path.** `resident-fast-path.ts` (pure matcher) + `resident-fast-path.server.ts` (scope). Runs before the resident agent,
shared line only, for a phone VERIFIED on a profile texting its manager's line. Scope is `resolveResidentKnowledgeScope`: the resident's
lease house, house details only past the move-in lock (`includeHouseInfo`), approved Q&A only in the resident's audiences. Topics: Wi-Fi,
door/gate code, parking, trash / recycling day, laundry, quiet hours, guests, smoking, pets, manager / emergency contact, house chat link;
then approved Q&A with >= 60% question coverage. It answers only when the text is obviously a house question (no other intent rule matches,
no always-escalate topic, <= 160 chars, <= 2 question marks), every needed fact is on file, and the reply fits one segment; otherwise null
and the normal agent runs. The reply goes through the turn runner as a precomputed reply (`precomputedLane: "fast_path"`): persisted, no
model, no AI credit. Reads `access.doorCode/gateCode/parking`, `wifi.network/password`, `trash.day` (+ `recyclingDay`/`recycleDay`/`recycling`
when W11 adds them), `rules.*`, `contacts.*`, `laundry.*`; missing fields mean no match.

**Long work.** `slow-work.ts` lists dispatch / screening / payment tools. When a confirmed YES runs one, the turn runner calls `onSlowWork`
and the pipeline texts "On it, I'll text you when it's done." (key `inbound_reply_<sid>_ack`) before the work; the result follows as the
normal reply. Manager and resident replies only; vendor replies and read-tool waits are not acknowledged.

**Latency + intent log.** `intent.ts` (rules) and `intent.server.ts` (the cheapest configured model, `TIER_MODELS.simple`, 1.5 s cap, only
when the rules cannot tell and only on the shared line; log-only). `turn-metrics.server.ts` `recordSmsTurnMetrics` writes the fields to the
INBOUND projection turn of the answered text, sends PostHog `sms_reply_sent` (ids and numbers only) for a sent reply, and scores the
Langfuse trace (`sms-first-bubble-ms`, `sms-total-latency-ms`, `sms-bubble-count`; intent and lane in the comment). `first_bubble_ms` runs
from the receipt (`first_received_at`) to the first bubble handed to the transport; `total_latency_ms` to the end of the turn (later bubbles
follow after the response). Logged for manager and resident turns; the prospect and vendor paths do not log yet.

**Prompt caching.** `provider.ts` `withPromptCaching`: the Anthropic call now sends the system prompt as a cached block and puts a breakpoint
on the last tool, so the static prompt, property block and tool catalog are read from cache across loop iterations and turns (below the
model minimum the breakpoint is a no-op). The only moving piece in the prefix is the daily clock line.

Tests: `one-number-bubbles`, `-bubble-delivery`, `-feel-settings`, `-debounce`, `-resident-fast-path` (pure matcher + door-code scoping),
`-feel-agents` (runner hand-off, deliverer bubbles and keys), `-feel-misc` (intent, slow work, caching, metrics), `-feel-pipeline`
(resident path on the shared line and on a work number).

## W8 - Manager operations by text, alerts, the 8am digest, follow-ups, payouts

Flags: nothing here changes `per_workspace`. The 8am digest and the new-room text run only while `sms_runtime_config.line_mode = shared` (and, with a pilot list, only for those workspaces); "set up payouts" mints a link only on the shared line (else the tool answers `links_unavailable`). The command tools, alert-phone texts and the 72h tour nudge are additive to today's paths. No migration: the one new setting rides `manager_automation_settings.row_data`.

Manager commands (the manager SMS registry is the portal catalog minus destructive tools; every write is previewed and needs a YES inside 10 minutes through `agent_pending_actions`, and writes its own `audit_log` row):

| Text | Tool (file) | Kind |
| --- | --- | --- |
| "Who's touring tomorrow?" | `list_tours_on_day` (`manager-ops.ts`, reads `ops-facts.server.ts`) | read; the tool resolves today/tomorrow/date in Pacific time, the model never computes a date |
| "What's vacant at 5259 Brooklyn?" | `list_vacant_rooms` (`manager-ops-rooms.ts`) | read; `roomAvailabilityForRange` per room, the calendar the public listing uses |
| "Who hasn't paid October rent?" | `list_unpaid_rent` | read; `summarizeRentForMonth` (`ops-text.ts`) is the one rent math, the digest uses it too |
| "Mark room 3 at 4709A rented to Sam from Nov 1" | `mark_room_rented` | write; the same `room_date_block` row `block_room_dates` writes, open-ended (`9999-12-31`) unless `until` |
| "Drop room 2 price to $950" | `update_room_rent` (existing) | write |
| "Approve Priya's application" | `get_application_review_link` | read; replies with the portal link. `update_application_bucket` and `set_resident_approval` are in `MANAGER_SMS_DEEP_LINK_ONLY_TOOLS` and are NOT in the text catalog (AGENTS.md: approval is not an agent tool) |
| "Text all 5257 residents: ..." | `broadcast_to_residents` | write; preview lists the recipient count and how many are textable; sends each resident their own message through `send_message` (its sender-scope gate, consent and audit), re-deriving recipients at execute. A manager with several houses who names none gets "Which house: A, B, or all?" (`whichHouseQuestion`, which W10's announce reuses) |
| "Send the plumber to the 8th Ave leak" | `dispatch_vendor` (W7a) | write |
| "set up payouts" | `set_up_payouts` | read; see Payouts |

Scoping: every reader takes the context it is given (`workspace` of the number, a teammate's `assignedPropertyIds`); `opsContextSeesProperty` is the single house check. Data-changing commands come only from a verified manager or teammate phone (`resolveManagerSmsInboundIdentity`), a spoofed number never reaches the registry. Rent, move-in and move-out texts are W11's; the house-group announce is W10's.

Alerts (`ops-alerts.server.ts`): the six spec alerts. HUMAN, emergency word and new lead already go through `alertWorkspaceTeam`. New application, booked tour, emergency maintenance, failed payment, late fee and an unanswerable question each already reached the owner and the people who hold the house; the one missing leg was the owner's listed alert phones. `alertPhonesOf` adds exactly that leg (via `notifyWorkNumberRecipients`, idempotent on `ops-alert:<kind>:<entity>`, redacted, never throws) from `notifyManagerApplicationSubmitted`, `emitTourManagerEvent` (confirmed), `emitCreatedWorkOrder` and `createWorkOrderFromResidentSms` (Emergency), `emitHouseholdChargeTransition` (failed, late fee) and `recordEscalatedQuestion` (leasing, resident, vendor escalations). Nobody is told twice.

8am digest (`morning-digest.server.ts`, cron `/api/cron/manager-morning-digest` at 15:00 and 16:00 UTC, acts only when it is 8 in Pacific): tours today, open services, rent paid / unpaid with the amount for the month, new leads (prospect contacts stamped with the workspace in the last day); one GSM-7 segment with the "Good morning" subject, skipped when there is nothing to say. Per workspace it goes to the owner unless they turned it off, and to a teammate only if they turned it on (`managerMorningTextDigest` in their own automation settings, null = owner on / teammate off; the checkbox is in Settings -> Manager alerts). Each person's numbers are computed in their scope (workspace + assigned houses); a houses-only teammate gets no lead count. It rides `sendManagerNotificationSms`, so their alert destination and "attention digest" topic still decide whether a text leaves. Dedupe `morning-digest:<workspace>:<person>:<day>`.

Follow-ups: the tour-interest reminder (`reminders/subjects/tour-interest.server.ts`) now queues a second row 72 hours out (`TOUR_INTEREST_SECOND_BODY`, `followupStep: 2`) beside the 24h one, same prospect/thread/currency checks (any reply, application or booked tour cancels it, STOP is checked at send), then nothing. The saved rule stays the one-day rule. `prospect-room-matches.server.ts` (hourly, inside `/api/cron/unassigned-lead-followups`): a lead a team already owns (`status = assigned`) with saved criteria gets one text when a room that fits appears in THAT team's houses after a baseline sweep recorded `roomsSeen`; `newRoomTexted` is written before the send (overlapping sweeps send one), STOP is never retried, other failures are.

Payouts: `set_up_payouts` (manager) / the vendor twin added by `withSharedLineTools` in the vendor SMS turn mint a `payouts` phone-bound link to the texter's own verified phone (the code is texted when it opens; money session 30 minutes), or answer "already set up" with the last four. `handleStripeAccountUpdated` reads the profile's payout flag before its write and, on the not-ready to ready transition only, calls `textPayoutsReady` (`payouts-ready.server.ts`): it texts "Payouts are set up to the account ending 4417." once per link to a person with a payouts link minted in the last 7 days; someone who set up payouts in the app is not texted. Only the last four and the status are read (`payout_destinations_cache`); nothing about money movement changed.

Tests: `tests/unit/one-number-ops-{text,alerts,payouts}.test.ts`, `one-number-morning-digest.test.ts`, `one-number-prospect-room-matches.test.ts`, `tests/unit/tools/manager-ops-tools.test.ts`, the 72h cases in `tour-interest-reminders.test.ts`, and the exclusion rule in `manager-sms-agent.test.ts`.

Not done: a live proof needs the shared number, a live Stripe Connect onboarding and Twilio; the vendor-number-AI surface and the vendor SMS surface for payouts outside a job session are not wired (a vendor texts payouts from a job session only).

## W14 - Marketing: managed service, pricing tabs, Why PropLane

Pages: `/pricing` (Software tab; `?view=service` is the short Managed service tab), `/pricing/service`
(long form + form + FAQ; `/service` redirects to it), `/why-proplane` (overview) with sibling tabs
`/why-proplane/track-record`, `/why-proplane/how-we-manage`, `/why-proplane/software` (the old switchboard story).

- **No invented price or metric.** The managed service price is `MANAGED_PRICE_HEADLINE = "Custom"`
  (`src/lib/marketing/managed-service.ts`); software prices come from `RATE_CARD`. The only operating numbers are in
  `src/lib/marketing/track-record.ts`: 3 homes, "26 of 28 rooms occupied", "six-figure profit". The pending metrics
  (`OWNER_RESPONSE_TIME`, `RENT_COLLECTED_ON_TIME`, `AVERAGE_VACANCY_DAYS`, `OWNER_PAYOUT_TIMING`) are empty strings;
  `trackRecordMetrics()` omits any metric whose value is empty. Fill the constant and it appears everywhere.
- **Shared components** (`src/components/marketing/site/`): `pricing-cards.tsx` exports `PricingCards` (Software | Managed
  service tabs, no props, for the home page), `SoftwarePricingCards`, `ServicePricingCard`, `PlanCard`; `pricing-switch.tsx`
  is its client tab switch; `managed-service-sections.tsx` has `PricingTabs` (route-based), steps, inclusions and the
  `#talk` section; `track-record-band.tsx` draws the stated metrics and the 28-room occupancy dots from the same constants;
  `why-subnav.tsx` is the Why PropLane tab row.
- **Contact path.** `ManagedServiceForm` posts to the existing `/api/public/contact-message` with topic "Property management
  services" (already one of the Contact page's topics). No new route, no new mail system.
- **Crawl surfaces** derive from the same module: `llms.ts` (summary, Product and Pricing entries), `sitemap.ts`
  (service + Why tabs), a `Service` JSON-LD node on `/pricing/service`.
- Tests: `tests/unit/managed-service-marketing.test.tsx`.

## W12 - Role-detecting first conversation, sandbox DEMO, landlord and vendor setup by text

Spec: [`texting-plan` Onboarding and demo](one-number-spec.md) + the captain's second spec (routing step 6 Unknown). Migration `20261018230000_one_number_onboarding.sql` (dev applied, ledger row recorded): `sms_demo_sessions`, `sms_onboarding_state`, `sms_vendor_leads`, `sms_setup_links`. All RLS on, service role only; classified in `account-purge-manifest.ts`. Every read of them treats 42P01 / 42703 / PGRST205 as "nothing there": with `sms_onboarding_state` missing, `handleUnknownSenderInbound` is exactly W3's `handleUnassignedLeadInbound`.

Flags: none for the first conversation or the demo (they only run on the shared line, `line_mode = shared`). `ONE_NUMBER_WAITLIST` (default OFF) + `ONE_NUMBER_WAITLIST_CAP` (default 10) gate NEW landlords at finish; with the flag off nothing reads the database for it.

Files:

- `src/lib/one-number/onboarding/` - `role-detect.ts` (pure: `inferSenderRole`, `readRoleAnswer`, house hints `extractHouseHints`), `unknown-sender.server.ts` (`handleUnknownSenderInbound`, the router's step 7, in front of W3), `state.server.ts`, `vendor-intake.ts` + `vendor-intake.server.ts`, `setup-links.server.ts`, `finish-setup.server.ts`, `house-draft.server.ts`, `waitlist.server.ts`, `invite.server.ts`.
- `src/lib/one-number/demo/` - `script.ts` (pure step machine), `store.server.ts`, `run-demo-turn.server.ts`, `types.ts`, `index.ts`. Fixture: `src/lib/demo/demo-sms-sample-house.ts` (61 Willow Court).
- Routes: `GET /api/admin/vendor-leads`, `PATCH /api/admin/vendor-leads/[id]` (admin only), `POST /api/start/[token]/send`, `POST /api/start/[token]/complete`; page `/start/[token]` (`src/components/public/finish-setup-card.tsx`).
- Edits to shared files: `router.server.ts` (calls `handleUnknownSenderInbound`; `unassignedReplies`), `inbound-seam.server.ts` (`messages` on `handled`; manager DEMO; `invite`), `inbound-pipeline.server.ts` (`twimlOk` takes a list: one `<Message>` each), `app/api/twilio/inbound/route.ts` (STOP ends a demo).

Invariants:

1. **Ask once.** An unknown number's first text is read by code (`inferSenderRole`, landlord outranks vendor outranks searcher). Unclear = "Hey! I'm PropLane. Are you looking for a place, renting one out, or a vendor? Reply STOP to opt out." exactly once (`sms_onboarding_state.asked_at`); a still-unclear answer makes the sender a searcher. A phone with a lead already open is a searcher and is never asked. Role is sticky; a known number never reaches this code (the router routes it).
2. **Searcher** goes to W3's qualifier unchanged. **Landlord**: "Want to try me on a sample house first? Reply DEMO." (`stage offered`), yes starts the demo, no sends the finish link. **Vendor**: trade, area, rates, insurance, one per text, volunteered facts kept; the lead waits as `sms_vendor_leads.status = pending` for platform admin (never a workspace, never a dispatch rule) and gets a phone-bound finish link. The STOP notice rides the first reply only.
3. **The DEMO never touches a real row.** `runDemoTurn(db, { channel: "sms" | "web", sessionKey, text })` writes only `sms_demo_sessions` (the step) and, at the end, one `sms_setup_links` row (and, in the SMS door, `sms_onboarding_state`). Texting `DEMO` (whole body) or the homepage prefill "Hi PropLane, show me the demo" starts it; STOP (route) or "exit" ends it; `DEMO` mid-demo restarts; 120 idle minutes closes it. A manager's phone can run it too and, while it lasts, their texts are the demo's. SMS key = the 10-digit phone key; web key = an opaque browser id (`/^[A-Za-z0-9_-]{16,64}$/`). The web route must rate-limit. Returns `bubbles` (`agent` | `sample`), flat `messages` (sample ones prefixed "Sample text to you:"), `step`, `finished`, `ended`, `finishUrl`, `suggestions`. Every line is one GSM-7 segment (`tests/unit/one-number-demo-script.test.ts` asserts it).
4. **Finish setup** (`/start/<token>`): the link stores only its SHA-256 and lives 7 days; a texted link is bound to the texter's phone and the code goes to THAT number only (`startPhoneChallenge`, purpose sign_in, the W5 flow); a web link has no phone and takes the visitor's. After `/api/auth/phone/verify` signs them in, `/complete` requires a VERIFIED phone that equals the link's phone, then runs `ensureFreeManagerPortalAccess` (or `provisionVendorAccountByEmail`) and, for a landlord with hints, writes the first house as a DRAFT (`mgr-text-<hash>`, deterministic per user + link, no listing-slot charge). Nothing redirects: the page ends on an explicit "Go to your portal" button (`manager-account-creation.md`). No draft exists before sign-in.
5. **Waitlist / invite** (flag on only): a new landlord is admitted while finished text-setups < cap; otherwise the link is marked `waitlisted_at` (still unspent, re-checked on the next visit; an unreadable count fails closed). A manager's `invite <phone>` mints a link with `invited_by_workspace_id` that skips the cap (5 a day per workspace, sent through `sendSharedLineMessage`). An existing manager is never waitlisted.

Tests: `tests/unit/one-number-{onboarding-roles,demo-script,demo-run,unknown-sender,finish-setup,onboarding-seam,setup-routes}.test.ts`.

## W18 - Migration scripts, verification, cutover runbook, simulated texting E2E, load test

No migration, no flag, no runtime code: this workstream adds human-run scripts, a runbook and tests. Runbook (the
exact production sequence, guards, rollbacks and the migration list): [`one-number-runbook.md`](one-number-runbook.md).

Scripts (`scripts/one-number/`, Node `.mjs`, npm aliases `one-number:*`; each prints the exact Supabase project ref first):

- `lib/target.mjs` + `lib/runtime.mjs` - the guards. `--target dev|staging|production` is required; the ref in the env must be the one that target owns; staging and production need `--confirm-ref` even to read; a staging write needs `--reason`; a **production write needs `--confirm-ref`, `--reason` (10+ chars) and `--backup` of a complete, same-project, under-2-hour-old file from `backup.mjs`**. `--rollback` and `--undo` are writes. Dry run is the default. Refusals exit 2, failed checks 1.
- `backup.mjs` - read-only export to `~/.cockpit/backups/` (mode 0600): `sms_runtime_config`, `platform_service_settings`, the service owner's workspaces, number tables, contacts, aliases, conversation ids and keys, `sms_consent`, consent event ids, and the ids of every row whose `workspace_id` is NULL.
- `backfill.mjs` - idempotent: `sms_phone_contacts` (E.164, a user only when exactly one verified profile holds the phone), `sms_projection_aliases` for legacy keys (a merged conversation aliases its survivor), `workspace_id` on turns / outbox / receipts / manager messages / inbound log / manager contacts (conversation, then work line, then the owner's default workspace; NULLs only; only a workspace the row's own owner holds), and scoped-only consent revokes copied onto the shared Messaging Service. Writes a journal; `--undo <journal>` takes back exactly that. `sms_projection_conversations.workspace_id` is stamped only with `--stamp-conversations` (readers use it for placement).
- `verify.mjs` - the spec's queries; `--save-baseline` before, `--baseline` after: counts, stamps, opt-outs, aliases, isolation, contacts. Exit 1 on any failure. Keys that resolved to nothing before are a note, not a failure.
- `create-service-workspace.mjs` - against W15's contract (`platform_service_settings`, `create_portal_service_workspace`); refuses when that migration is absent; seeds the service owner only from an admin account when the singleton is empty; idempotent by name; moves no property.
- `cutover.mjs` - `--mode shadow|shared`, `--pilot`, `--rollback`, `--notify-moved`. Validates E.164 and the service SID, asks Twilio read-only (GET `.../Services/{sid}/PhoneNumbers`) that the number is attached, sets exactly four `sms_runtime_config` columns. `--notify-moved` queues `number_moved_notice` outbox rows from each workspace's old number (daytime Pacific, staggered, never to opted-out phones, idempotent).
- `shadow-report.mjs` - agreement of `sms_line_shadow_decisions` with the real owner; exit 1 until enough samples and 98% agreement.
- `list-migrations.mjs` - the one-number migration files in order.

Simulated texting (no Twilio; the transport and the team alert are the only stand-ins), `npm run test:one-number-e2e`, `tests/integration/one-number-e2e/`:

- `routing-and-safety` - resident in A + vendor in B: the question, the remembered answer, house and role-word switching, HUMAN pausing both and a manager resuming one, gas smell, a manager's own words, a stranger with and without a code, Twilio retries, config fail-closed.
- `prospect-journey` - stranger -> role question -> five qualifiers -> rooms from every team -> a pick -> that one team owns the thread with the history and a `new_lead` alert -> the next text reaches them. Fair-housing question changes nothing. One known gap (`it.fails`): the role question is not idempotent on `MessageSid`.
- `resident-rent-link` - `send_my_link` rent -> code to the bound phone only -> five-try lockout, 15 tries an hour, 30-minute session, forwarded link, expiry, replacement.
- `vendor-dispatch-chain` - lockout filed -> manager Y -> vendor 1 NO -> vendor 2 YES with a time -> Scheduled -> DONE -> resident YES -> completed; price over the cap; other team's manager and vendor ignored; opted-out vendor skipped; gas smell never dispatched.
- `manager-ops` - "who hasn't paid" scoped to the team and to a one-house teammate; broadcast previewed, sent only on YES, once, never to another team.
- `leak-photo-to-ticket` - MMS routed, stored privately under the owner, the repair request carries the photo and links it; another team's photo from the same phone is never attached.
- `stop-start` - the real webhook route: STOP is global and never reaches the router; START; a delayed old START cannot reopen; YES is an answer unless the phone is opted out; HELP. The control function was also run against dev in a rolled-back transaction.

Load, `npm run test:one-number-load` (`ONE_NUMBER_LOAD_COUNT`, default 5,000; `ONE_NUMBER_LOAD_REPORT=<file>` writes the numbers): residents, vendors, managers, two-team people and strangers, bursts and Twilio redeliveries, in waves of 64 through the real seam, router, session store, burst debounce and bubble delivery. Asserts routing against an independent oracle, no dropped text (each reaches exactly one reply), no duplicate reply (a burst gets one; a redelivery is answered from the receipt claim), HUMAN / emergency once each, no send from a workspace the recipient does not belong to. The debounce RPCs run on `tests/helpers/debounce-sql-port.ts`, checked against recorded output of the real SQL (`tests/unit/one-number-debounce-sql-parity.test.ts`). Timings are of the code path on an in-memory database (about 0.3 ms p50 / 0.7 ms p95 sequential service time, about 13 / 21 ms p50 / p95 per text with 64 in flight, about 5,000 texts a second on a loaded laptop); they say nothing about Postgres or network time.

Tests: `tests/unit/one-number-migration-{guards,backup,backfill,verify,cutover,service,runbook}.test.ts` (shared fixtures `one-number-migration-fixtures.ts`, fake `tests/helpers/migration-fake-db.ts`); the runbook test fails when a `20261018*` migration is on disk and not in the runbook, or when the runbook uses a flag a script does not accept.

Findings, not fixed here: the role question before the lead queue is not idempotent on `MessageSid`; no inbound auto-reply exists on an old number after the switch (the old number keeps working and the one outbound notice is the only "we've moved" text); the staging rehearsal needs a staging service-role key that was not available.
