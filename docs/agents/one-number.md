# One-number SMS: implementation map

Spec: [`one-number-spec.md`](one-number-spec.md). Shared types: `src/lib/one-number/contracts.ts`.
Each workstream owns one heading below.

## Number model (Oct 18 decision)

Captain, verbatim: "have a set work number for anyone who signs up; for pro and business can get personalized
work number for their workspace; keep overall service PropLane separate." (W16)

- **Everyone texts on the set PropLane line** (`sms_runtime_config.shared_number_e164`, `line_mode = shared`).
- **A Pro or Business workspace MAY take a personalized number** (the existing per-workspace provisioning).
  Both run side by side. PropLane's own managed service (W15) has no exemption from the paid-plan rule, and (captain, Oct 25) a PropLane-MANAGED workspace never uses a personalized number at all: it texts on the PropLane line (206) in both modes (W29 § PropLane-managed workspaces).
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
   subscription; PropLane's managed service has no exemption (and a PropLane-managed workspace never takes one: it texts on the PropLane line, W29). A Free workspace gets 403 `personal_number_needs_paid_plan` ("This workspace texts from the
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
4. Assignment (`assignLeadToHouse`) happens exactly once per lead: the house is re-read from the database (must be `status = 'live'`, never trusted from the stored offer), it decides the workspace and its owner, and the claim is `update … where status = 'open'`. (Superseded Oct 26, § W30: a PROSPECT pick writes a one-line "Looking for" summary instead of the transcript; only a PropLane staff placement copies the history.) Then the history is copied through `logManagerSmsMessage` (counterparty role `prospect`, stable `lead:<turnId>` ids, `workspaceId` passed for the transport workstream's stamp) into that owner's conversation, the contact row and `sms_line_sessions` point at the workspace, and only that team gets a `new_lead` alert (`alertWorkspaceTeam`). A prospect's own pick leaves out the triggering text: the pipeline records it when the leasing agent takes over. An admin assignment copies everything.
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
- `phone-otp.server.ts` - `phone_otp_challenges`: 6 digits, keyed HMAC (`PHONE_OTP_HMAC_SECRET`, else the service-role key) bound to challenge id + phone, 10-minute expiry, 5 attempts (counted before comparing, by compare-and-set), at most 3 sends/phone/hour PER PURPOSE under a phone-wide ceiling of 8/hour across every purpose (`SHARED_LINE_OTP_RULES.maxSendsPerHour` / `maxSendsPerPhonePerHour`), a failed send leaves nothing behind, newest code only. Per purpose because the public-bind door takes an arbitrary phone from whoever holds a printed entry code, so its sends must not spend what a rent link or a phone sign-in needs.
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

Abuse limits on phone sign-in (security pass, 2026-10-18): `POST /api/auth/phone/start` is limited to 5 sends per IP per hour, and 300 per hour across every door that texts a code — `allowPhoneStartGlobalBudget` in `src/lib/auth/phone-auth-request.server.ts`, one shared key that `/api/start/[token]/send` draws from too (`rateLimit`, same generic refusal as every other failure), and texts only to US/Canada `+1` numbers with a real NANP shape (`isAllowedPhoneAuthDestination`; widen with a comma list in `PHONE_AUTH_ALLOWED_CALLING_CODES`, e.g. `1,44`). The Supabase Send SMS hook fails closed: off the shared line it sends nothing unless `SUPABASE_PHONE_AUTH_HOOK_ENABLED=1` (`true` is read the same, via `src/lib/auth/phone-hook-flag.ts`), and even then it must claim a pending reservation (`phone_auth_claim_hook_delivery`). A phone with 10 wrong codes for ONE PURPOSE in any 24 hours is locked for that purpose (no new text, no code accepted, right or wrong): `phone_auth_failed_code_count` in `20261018310100_phone_auth_failure_cap.sql`, re-scoped per purpose by `20261019150100_phone_auth_failure_cap_per_purpose.sql`, feeds `phone_auth_start` / `phone_auth_consume`, and `phoneLockedOut` in `phone-otp.server.ts` counts the same way. `20261019160000_phone_auth_send_budget_per_purpose.sql` gives `phone_auth_start` the same per-purpose send budget under the phone-wide ceiling. Counting every purpose together let a few cheap public-bind guesses lock the owner of that phone out of their rent link and phone sign-in for a day. `requestPhoneOtp` still counts then inserts without a lock (a rare double-send inside one hour is bounded by the route and IP limits).

Public texting endpoints: `POST /api/public/text-demo-link` texts a code first (a message containing only the code) and the demo link only after the visitor enters it; the shared hourly link budget is spent only on a verified send, never on invalid input. `POST /api/public/phone-bind` keeps send and verify in separate buckets (send: 8 per IP and 20 per entry code per hour, 200 per workspace per day).

`POST /api/auth/phone/reset` lets the verified owner of the active workspace release an established resident/vendor's lost phone. Both the helper and SQL re-derive the relationship and refuse self-reset, manager/admin targets, wrong workspace and conflicts. It clears phone proofs and credentials atomically and audits the release; it never chooses a replacement or mints a session. The person must then verify their replacement phone.

The resident/vendor Communication projection reader accepts shared rows with no legacy work line only after verifying the phone, role and stamped workspace owner; turns remain scoped to that workspace. Prior SMS is read through that projection, never copied to another tenant.

Migrations: `20261018180000_phone_auth.sql`, `20261018180001_phone_auth_reset.sql`. New lease state is service-only/RLS and classified in the purge manifest. Tests: `phone-auth*`, `phone-otp-delivery`, `shared-phone-settings`, `one-number-legacy-phone-writes`, resident/vendor conversation suites, and the rollback-only `tests/integration/phone-auth-transitions.sql`. The Auth identity shape follows [Supabase's identity model](https://github.com/supabase/auth/blob/master/internal/models/identity.go); session minting follows [generateLink](https://supabase.com/docs/reference/javascript/auth-admin-generatelink) and [verifyOtp](https://supabase.com/docs/reference/javascript/auth-verifyotp).

**When possession of a phone may open a session (one rule, security review Oct 20).** A text proves only that
someone holds the SIM or can spoof the sender, which is weaker than an email or OAuth sign-in. So a session minted on
SMS proof alone is allowed only where that proof is not weaker than the account's own credentials:
`smsProvenSessionVerdict` (`src/lib/auth/sms-proven-session.server.ts`) - NEVER an admin (an `admin` row in
`profile_roles`, the legacy `profiles.role`, or the primary admin email); otherwise either every role the account holds
is resident and/or vendor, or the phone is its ONLY proven credential (a manager account made by SMS sign-up has a
placeholder `@phone.proplane.invalid` login, no real email, no OAuth identity). An accepted team seat counts as a
manager-side role whatever `profile_roles` says ([`co-manager-access.md`](co-manager-access.md) § Accepting a seat stamps the account-wide `manager` role).
Any other account, and any read that fails, is refused and sent to the ordinary sign-in. The askers are
`link-portal-session.server.ts` (a `/l` link's portal session), `signup/sign-in-link.server.ts` (the texted one-tap
link) and `short-stay/guest-login.server.ts` (a guest's link, which no caller mints today).

DOCUMENTED EXCEPTION: a signed-out phone-code sign-in (`verifyPhoneChallenge`) is the captain's phone-first direction,
so it is open for every account, admins included (captain, Oct 26) - a verified one-time code to the account's own
verified phone is a stronger proof than an inbound text's sender id. It asks `phoneCodeSignInDecision`
(`phoneCodeSignInAllowed` is the same verdict as a boolean), which refuses only an unreadable account; an inbound text
alone still never opens an admin session (`smsProvenSessionAllowed`). The refusal is checked before the phone is bound,
and the HOSTED (GoTrue) OTP path is only chosen for an account that passes it (an unreadable one stays on the local
path), because GoTrue's own verify would mint the session past that check. An admin session opened this way writes one
`admin_phone_code_sign_in` audit row (the account's own scope, ids and enums only) BEFORE the bind, like every other
admin-privilege door; the insert is best-effort, since the code is already proven and a failed audit must not lock an
admin out of their own sign-in.

**Phone sign-in: plain errors, server wins on "off", straight to the portal (Oct 26).** Still Shared-mode only
(`phoneAuthEnabled`). The sign-in page decides whether to draw the phone box from one read when it loads; the SERVER's
answer wins when they disagree: `POST /api/auth/phone/start` returns `409 { phoneOff: true, kind: "off" }`, and
`PhoneAuthForm` calls `onPhoneOff`, so `NativeAuthHub` replaces the phone box with "Phone sign-in isn't available right
now. Use Apple, Google or email." and opens the email form. No dead form.

Failures carry a `kind` and ONE copy table (`src/lib/auth/phone-auth-errors.ts`, only for the signed-out `sign_in`
door; Settings purposes keep `PHONE_AUTH_ERROR`). A kind may be named only when its cause is the typed input, a setting
that is the same for everyone, something that happens identically for any number, or THIS browser's own challenge:

| kind | Message | Raised by |
| --- | --- | --- |
| `off` | Phone sign-in isn't available right now. Use Apple, Google or email. | switch off at start or verify (409) |
| `bad_number` | Enter a 10-digit phone number. | does not normalize, or a +1 number with an impossible shape |
| `not_us` | We can only text US and Canadian numbers. | a non-allowed calling code |
| `send_failed` | We couldn't send the text. Try again in a minute. | the provider refused (`PhoneSendFailedError`) |
| `throttled` | Too many codes requested. Try again in an hour, or use Apple, Google or email. | the per-IP and endpoint-wide budgets only |
| `wrong_code` | That code didn't match. Check the text and try again. | malformed code, or a refused code on a live challenge |
| `expired` | That code expired. | challenge missing / not this browser's / no proof cookie / spent / past 10 minutes / 5 tries |
| `generic` | We couldn't sign you in with this number. Use Apple, Google or email. | EVERYTHING else |

`generic` is deliberate for: a number held by two accounts, an admin account, the per-number send cap
(`phone_auth_start` refusing) and the per-number failed-code lockout (`classifyRefusedCode` re-reads
`phone_auth_failed_code_count`; at 10 or unreadable it is `generic`, never `wrong_code`), and every unreadable, claim,
bind or mint failure. Naming any of them would tell a stranger something about whoever owns the number.
`tests/unit/phone-auth.test.ts` ("phone sign-in error kinds") pins each branch and fails if an ownership, role or
lockout branch returns a named kind. An `expired` verify also answers `canResend` (`phoneResendAllowed`, read-only,
fail closed); the form auto-sends a fresh code only when it is true, otherwise it shows "Send a new code".

The code text ends with the domain-bound line `@<host> #<code>` (`phoneAuthCodeBody`), the format iPhone's keyboard
suggestion and Android Chrome's Web OTP look for. The host comes from `resolveEmailLinkBaseUrl()` (canonical origin),
never the request's Host header. The form: fixed "+1" and as-you-type US formatting (`src/lib/phone-format.ts`), the
last number used on this device (`axis:remembered-login-phone`, cleared by `clearPortalBrowserCache` with the remembered
email), six boxes over one real `autocomplete="one-time-code"` input, auto-submit on the 6th digit (one verify per
challenge via the `inFlight` guard), Web OTP with an AbortController, a 30 second resend countdown. Email and
password sit behind "Use email instead" while the phone box is drawn, and open from the start when phone is off or
when this device last signed in by email (`axis:last-login-method`, written on a successful sign-in either way).

Straight to the portal: after a `sign_in` verify the route runs the SAME resolver `/auth/continue` uses
(`resolvePostSignInDestination`, shared with `/api/auth/oauth-portal-access`) for the new session and returns `next`;
the form navigates there. A `?next=` deep link (re-validated server-side) still wins. Any failure leaves `next` unset and
the form falls back to `/auth/continue`. A number with no account is created exactly as before (`resolvePhoneUser`),
but verify returns `/auth/get-started?phone_new=1`, whose heading is "No account uses (510) 309-8345 yet" with the three
existing role routes (looking for a place / manage homes / vendor). Only someone who just proved the code sees it.

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
on an open job -> `vendor_job` (the image is re-uploaded to the private `manager-documents` bucket and only its path is
put on `row_data.completionPhotoPaths`, never base64); prospect/manager unlinked. The
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
`20261018200000_automations.sql` (dev applied, ledger row recorded): `workspace_automation_presets` (workspace, preset,
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

Spec: the captain's local `~/.cockpit/briefs/texting-plan-1018.md` (not in this repo) § House group chats,
§ Preset auto-sends, § Risks; everything load-bearing from it is restated below. Migration `20261018190000_house_groups.sql` (dev applied, ledger row
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

## W14 - Marketing: managed service and pricing

The separate `/pricing`, `/pricing/service`, `/service`, `/why-proplane/*`, `/contact`, `/support`, `/book-a-demo`
and `/reviews` pages this workstream built are gone: the one public page owns that content as the `#service`,
`#pricing` and `#contact` sections, and `MARKETING_REDIRECTS` (`src/lib/seo/marketing-routes.ts`) is the one list of
canonical public paths and of the temporary redirects from the retired URLs.

- The homepage, its sections and the no-invented-price / no-invented-metric rule are
  [`marketing-mocks.md`](marketing-mocks.md) § Public homepage; the crawl surfaces are
  [`ai-search-visibility.md`](ai-search-visibility.md). Do not re-describe either here.
- One-number's own stake: the managed service price stays `MANAGED_PRICE_HEADLINE = "Custom"`
  (`src/lib/marketing/managed-service.ts`), the only operating numbers are `src/lib/marketing/track-record.ts`
  (a metric with an empty value is rendered nowhere), and `ManagedServiceForm` posts to the existing
  `/api/public/contact-message` — no new route and no new mail system.
- **The homepage's number is `PROPLANE_PUBLIC_SMS_NUMBER` in production.** `readPublicTextingConfig` only returns a
  public line in `shared` / `shadow` mode, so in `per_workspace` (how production runs) the hero's green
  "Text (206) 678-1909" button comes from that variable alone - unset, `TextingHomeHero` degrades to a plain
  "Text PropLane" link to `#contact` and the page loses its one call to action. It is checked by
  `scripts/check-production-env.mjs` (group `public_sms_number`, surfaced by `npm run ship:preflight`), so a promote
  gets told when it is empty; set it in every deployed environment.
- Tests: `tests/unit/managed-service-marketing.test.tsx`, `tests/unit/public-texting-config.test.ts`.

## W12 - Role-detecting first conversation, sandbox DEMO, landlord and vendor setup by text

Spec: [`texting-plan` Onboarding and demo](one-number-spec.md) + the captain's second spec (routing step 6 Unknown). Migration `20261018230000_one_number_onboarding.sql` (dev applied, ledger row recorded): `sms_demo_sessions`, `sms_onboarding_state`, `sms_vendor_leads`, `sms_setup_links`. All RLS on, service role only; classified in `account-purge-manifest.ts`. Every read of them treats 42P01 / 42703 / PGRST205 as "nothing there": with `sms_onboarding_state` missing, `handleUnknownSenderInbound` is exactly W3's `handleUnassignedLeadInbound`.

Flags: none for the first conversation or the demo (they only run on the shared line, `line_mode = shared`). `ONE_NUMBER_WAITLIST` (default OFF) + `ONE_NUMBER_WAITLIST_CAP` (default 10) gate NEW landlords at finish; with the flag off nothing reads the database for it.

Files:

- `src/lib/one-number/onboarding/` - `role-detect.ts` (pure: `inferSenderRole`, `readRoleAnswer`, house hints `extractHouseHints`), `unknown-sender.server.ts` (`handleUnknownSenderInbound`, the router's step 7, in front of W3), `state.server.ts`, `vendor-intake.ts` + `vendor-intake.server.ts`, `setup-links.server.ts`, `finish-setup.server.ts`, `house-draft.server.ts`, `waitlist.server.ts`, `invite.server.ts`.
- `src/lib/one-number/demo/` - `script.ts` (pure step machine), `store.server.ts`, `run-demo-turn.server.ts`, `types.ts`, `index.ts`. Fixture: `src/lib/demo/demo-sms-sample-house.ts` (61 Willow Court).
- Routes: `GET /api/admin/vendor-leads`, `PATCH /api/admin/vendor-leads/[id]` (admin only), `POST /api/start/[token]/send`, `POST /api/start/[token]/complete`; page `/start/[token]` (`src/components/public/finish-setup-card.tsx`).
- Edits to shared files: `router.server.ts` (calls `handleUnknownSenderInbound`; `unassignedReplies`), `inbound-seam.server.ts` (`messages` on `handled`; manager DEMO; `invite`), `inbound-pipeline.server.ts` (`twimlOk` takes a list: one `<Message>` each), `app/api/twilio/inbound/route.ts` (STOP ends a demo).

Invariants:

1. **Ask once.** An unknown number's first text is read by code (`classifyFirstText` in `src/lib/sms/propline-first-text.ts`: a signal for exactly one of resident / vendor / looking / manage is CLEAR and skips the question). Unclear = "Hi, this is PropLane. Are you a resident, a vendor, looking for a place, or want to manage your own property with PropLane?" exactly once (`sms_onboarding_state.asked_at`); the answer routes (§ W29), and a still-unclear answer makes the sender a searcher. The question itself carries no STOP line, so the notice rides the reply that follows it. A phone with a lead already open is a searcher and is never asked. Role is sticky; a known number never reaches this code (the router routes it).
2. **Searcher** goes to W3's qualifier unchanged. **Landlord**: "Want to try me on a sample house first? Reply DEMO." (`stage offered`), yes starts the demo, no sends the finish link. **Vendor**: trade, area, rates, insurance, one per text, volunteered facts kept; the lead waits as `sms_vendor_leads.status = pending` for platform admin (never a workspace, never a dispatch rule) and gets a phone-bound finish link. The STOP notice rides the first reply that can carry it - the ask no longer does, so it is the reply after the ask.
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
- `cutover.mjs` - `--mode shadow|shared`, `--pilot`, `--rollback`, `--notify-moved`. Validates E.164 and the service SID, asks Twilio read-only (GET `.../Services/{sid}/PhoneNumbers`) that the number is attached, sets exactly four `sms_runtime_config` columns. `--notify-moved` queues one `sms_moved_notices` row per phone (daytime Pacific, staggered, never to opted-out phones, idempotent); `/api/cron/moved-notices` sends them from the shared number as platform sends at PropLane's cost.
- `shadow-report.mjs` - agreement of `sms_line_shadow_decisions` with the real owner; exit 1 until enough samples and 98% agreement.
- `list-migrations.mjs` - the one-number migration files in order.

Simulated texting (no Twilio; the transport and the team alert are the only stand-ins), `npm run test:one-number-e2e`, `tests/integration/one-number-e2e/`:

- `routing-and-safety` - resident in A + vendor in B: the question, the remembered answer, house and role-word switching, HUMAN pausing both and a manager resuming one, gas smell, a manager's own words, a stranger with and without a code, Twilio retries, config fail-closed.
- `prospect-journey` - stranger -> role question -> five qualifiers -> rooms from every team -> a pick -> that one team owns the thread with the history and a `new_lead` alert -> the next text reaches them. Fair-housing question changes nothing. A Twilio retry of the first text (and of a later answer) gets the same reply and moves nothing twice.
- `resident-rent-link` - `send_my_link` rent -> code to the bound phone only -> five-try lockout, 15 tries an hour, 30-minute session, forwarded link, expiry, replacement.
- `vendor-dispatch-chain` - lockout filed -> manager Y -> vendor 1 NO -> vendor 2 YES with a time -> Scheduled -> DONE -> resident YES -> completed; price over the cap; other team's manager and vendor ignored; opted-out vendor skipped; gas smell never dispatched.
- `manager-ops` - "who hasn't paid" scoped to the team and to a one-house teammate; broadcast previewed, sent only on YES, once, never to another team.
- `leak-photo-to-ticket` - MMS routed, stored privately under the owner, the repair request carries the photo and links it; another team's photo from the same phone is never attached.
- `stop-start` - the real webhook route: STOP is global and never reaches the router; START; a delayed old START cannot reopen; YES is an answer unless the phone is opted out; HELP. The control function was also run against dev in a rolled-back transaction.

Load, `npm run test:one-number-load` (`ONE_NUMBER_LOAD_COUNT`, default 5,000; `ONE_NUMBER_LOAD_REPORT=<file>` writes the numbers): residents, vendors, managers, two-team people and strangers, bursts and Twilio redeliveries, in waves of 64 through the real seam, router, session store, burst debounce and bubble delivery. Asserts routing against an independent oracle, no dropped text (each reaches exactly one reply), no duplicate reply (a burst gets one; a redelivery is answered from the receipt claim), HUMAN / emergency once each, no send from a workspace the recipient does not belong to. The debounce RPCs run on `tests/helpers/debounce-sql-port.ts`, checked against recorded output of the real SQL (`tests/unit/one-number-debounce-sql-parity.test.ts`). Timings are of the code path on an in-memory database (about 0.3 ms p50 / 0.7 ms p95 sequential service time, about 13 / 21 ms p50 / p95 per text with 64 in flight, about 5,000 texts a second on a loaded laptop); they say nothing about Postgres or network time.

Tests: `tests/unit/one-number-migration-{guards,backup,backfill,verify,cutover,service,runbook}.test.ts` (shared fixtures `one-number-migration-fixtures.ts`, fake `tests/helpers/migration-fake-db.ts`); the runbook test fails when a `20261018*` migration is on disk and not in the runbook, or when the runbook uses a flag a script does not accept.

Findings, not fixed here: the staging rehearsal needs a staging service-role key that was not available.

### Fixes (on/fixes)

- **Turn replay.** `handleUnknownSenderInbound` is idempotent per `MessageSid`: the whole turn (reply, bubbles, photo, assigned workspace) is recorded in `sms_onboarding_replies` and returned unchanged on a retry, so onboarding state, leads and setup links never advance twice (`onboarding/turn-replay.server.ts`). Rows are pruned after an hour (a reply can carry a live setup link). Table missing = no recording, old behaviour.
- **Old numbers after the switch.** `old-number.server.ts` + the seam in `api/twilio/inbound/route.ts`: in `shared` mode a text to an old work number whose workspace is on the shared line (`isOldNumberOnSharedLine`, i.e. `workspaceOnSharedLine`; dedicated workspaces excluded) is routed as a shared-line text (`toPhone` becomes the shared number; if the seam takes nothing it reverts to the old number) and its sender gets "We've moved to (XXX) XXX-XXXX. Save this number." once per 30 days (`sendMovedAutoReply`; marker `sms_moved_notices`, one row per phone, claimed before the send and released on failure; table missing = no reply, text still routed).
- **Who pays.** The auto-reply and the one-time cutover notices are platform sends: `sendPlatformLeadText` (`inboundReply` skips quiet hours for the reply), purpose `platform_lead`, from the shared number, no workspace wallet or credit hold. Cutover notices queue in `sms_moved_notices` (`status = queued`, `available_at` in Pacific daytime) and `runMovedNoticeQueue` sends them (cron `/api/cron/moved-notices`, every 5 minutes, claims each row before sending, puts it back on a provider failure).
- Migration `20261018290000_one_number_fixes` (applied to dev); both tables RLS on, service role only; classified in `account-purge-manifest.ts` (`sms_moved_notices` cascades with its workspace; replies are pruned and carry no account column, so neither is in `DELETE_ORDER`).
- Tests: `tests/unit/one-number-old-number.test.ts`, `tests/unit/one-number-old-number-route.test.ts`, the retry cases in `tests/integration/one-number-e2e/prospect-journey.test.ts`, `tests/unit/one-number-migration-cutover.test.ts`.

## W15 - PropLane Service workspaces (admin Service tab)

Admin > Accounts > **Service** lists PropLane's own managed-property workspaces (one per city). They are
ordinary `portal_workspaces`, so everything the manager portal does works for managed properties with no
new code path. Migration `20261018260000_admin_service_workspaces.sql` (additive; applied to dev).

**Ownership model.** One designated *service owner* account owns every service workspace
(`portal_workspaces.is_service = true`, plus a free-text `city`). Other admin operators are **members with
the Admin role** (an accepted `account_link_invites` row pinned to the workspace, `team_role='admin'`,
`house_scope='all'`) - "add other people to the admin team" = add them to the service workspaces.
- Source of truth: `platform_service_settings` (singleton, service_role only). The DB trigger needs it to
  exempt the owner from the 10-workspace ceiling. `PROPLANE_SERVICE_OWNER_USER_ID` only **seeds** the row,
  once, and only for an existing account holding the admin role; a stored row always wins over the env.
  No row and no valid env = not configured: the tab says so, `+` is disabled, create returns 409.
- `src/lib/service/service-owner.server.ts`: `resolveServiceOwner` (seeds), `isPlatformServiceOwner`
  (read-only, fail-closed; 42P01/42703/PGRST204/205 = no owner), `loadServiceWorkspace` (the one test every
  route runs on a body id: must be `is_service` AND owned by the stored owner, else 404).
- `create_portal_service_workspace(owner, name, city)`: service_role only, refuses any owner that is not the
  stored service owner (42501), makes the first the owner's default (no stray "My workspace").

**Routes** (`POST|GET /api/admin/service-workspaces`, every verb starts with `requireAdminRoute()`):
`create` (owned by the service owner, the creating operator is seated as Admin; the workspace is deleted if
that seating fails), `rename`, `open`, `team`, `team-add`, `team-remove`. Logic is in
`src/lib/service/service-workspaces.server.ts`; each action re-derives what the operator IS inside the
workspace (`actorWorkspaceStanding`): Open needs an accepted membership (or ownership), rename / team
need the workspace "members" right (owner or Admin). A non-member admin sees the row but cannot act.
`team-add` only accepts a target that itself holds the admin role (re-checked server-side); `team-remove`
cancels only that workspace's own row (`canActOnMember`). **Open** sets the same `proplane-workspace`
cookie the manager portal's switcher sets (`POST /api/workspaces` select) and lands on
`/portal/properties`, so the viewer reads only that workspace's houses.

**Service number: there is none of its own.** Service workspaces use the same default PropLane line as every
other workspace (captain, Oct 18). Nothing is provisioned, reserved or exempted for them: no route action, no
entitlement bypass, no budget exemption (`tests/unit/admin-service-guards.test.ts` fails if `src/lib/service/`
touches provisioning, or if the sms entitlement/provisioning modules mention the service owner). A workspace
gets its own number only the normal way (W16: paid Pro/Business specialized number). The Service list shows
the number the workspace actually texts from (`workNumber` + `workNumberSource`): its own live number if it
holds one, else the shared PropLane line when `sms_runtime_config` puts the workspace on it
(`workspaceOnSharedLine`), else "No number".

**Invariants.** No manager route gains an admin branch (`tests/unit/admin-service-guards.test.ts` pins the
set of manager-side files that use an admin gate, and forbids any of them importing `@/lib/service/`). The
admin ROLE is still not the all-owners read. Purge: `platform_service_settings` is classified in
`account-purge-manifest.ts` (deleting the owner clears it, so the exemption fails closed).

**Admin navigation: one headed half (Software).** `ADMIN_SECTION_TABS` / `ADMIN_GROUPS` in
`src/lib/portals/nav-groups.ts` are the one source. Admin Settings (`profile`) has NO sidebar row
(captain, Oct 25): it is unassigned, so `SIDEBAR_EXCLUDED_SECTIONS` keeps it out, and it is reached
from the bottom-left account menu like every other portal's ([`ui-page-structure.md`](ui-page-structure.md)
§ Shell); `/admin` lands on the Dashboard. Dashboard and Communication come first, then **Software** (headed group, three
rows): Accounts (one page; its Managers · Residents · Vendors tabs, and an operator-only Test tab, live inside it),
Money (Payments · Promo codes · Finances · Managed funds) and **Service** (ONE row keyed on `service`: tabs Workspaces
(`/admin/service`, with its own Workspaces · Vendors · Network tabs) · PropLane line · Unassigned leads). Support and
Growth follow, unheaded. Oct 25: the "Property management" heading, the all-owners Properties list (`/admin/properties`,
now a redirect to `/admin/service`) and Subscribers (`/admin/subscribers`, a redirect to Accounts) were removed.
Every other section id and route is unchanged (`/admin/unassigned-leads` etc.); the native bottom bar
(`NATIVE_BOTTOM_NAV_ADMIN_PRIMARY`) shows Service where it showed Properties.

**The PropLane line** (`/admin/proplane-line`, `src/lib/service/proplane-line.server.ts`, route
`/api/admin/proplane-line`): the shared number on the website is the admin account's number
(`sms_runtime_config.shared_number_e164`, mode `line_mode`, `shared_pilot_workspace_ids`). The panel shows number,
mode (Per workspace / Shadow / Shared; status Off / Shadow / Live) and the workspaces on it; **Change** needs a
reason. `PATCH` is `requireAdminRoute`, validates the mode, the E.164 number (shared needs one) and that every
workspace id exists, refuses a no-op (409), and writes the `audit_log` row (`admin_proplane_line_change`, before /
after / reason) **before** applying - no audit row, no change; the row is stamped `applied: true|false` after.
It never touches Twilio and no sms module is imported (guard test). Existing manager workspaces, their numbers
and ownership are untouched.

**One workspace per owner client, per city** (migration `20261018260100_service_owner_of_record.sql`, applied to
dev). The Service list is sectioned by city (`groupServiceByCity`: Seattle first, the rest alphabetical, no city
last; matched ignoring case). A workspace carries `city` and an optional `owner_of_record_name` typed on `+`
(the client, before they have an account on the team). The **Team** pop-up has an **Invite owner** section:
`team-invite` takes a PropLane ID and writes a **pending** `account_link_invites` row (Admin role, `house_scope
all`, this workspace only - full access to it once accepted in their own portal, through the existing accept
flow); the invitee must already be a property-portal account (the same rule as every co-manager invite) and
their own accounts and workspaces are untouched. `account_link_invites.is_owner_of_record` flags THE membership
that is the owner of record for payouts and finances (W17); it grants nothing by itself, and a partial unique
index allows one live row per workspace (the server checks first and returns 409). A pending invitee shows by
the invite-time name snapshot, never their live profile or email. `team-owner-of-record` sets / clears the flag;
`team-remove` also withdraws a pending invite. The list shows the owner of record by name (the accepted flagged
member's profile name, else the typed client name). Money / finances are W17: `serviceWorkspaceFinancesHref`
(`src/lib/service/service-links.ts`) returns `null` and the row menu draws a Finances button only when it
returns an href.

**Service owner must be a property-portal manager too.** The co-manager sweeper
(`purgeOrphanedCoManagerLinks`, run when an admin loads the portal) deletes every `account_link_invites` row whose
inviter is not a manager/owner account, which silently stripped every operator from every service workspace when the
owner held only the admin role. `resolveServiceOwner` therefore returns "not configured" (create / list) for an
owner without that role, and refuses to seed one.

**Not done / notes.** The service owner still needs a plan for *inviting non-admin teammates by role* through
the manager portal's Team pane (that route enforces its own Pro/Business invite gate); the Team pop-up adds
admins directly and links to the portal for role invites.

## W22 - Bring existing owners' workspaces under PropLane Service

No migration, no flag, no product code: one guarded operations script. Runbook (exact commands, undo): [`one-number-runbook.md`](one-number-runbook.md) section 5b.

- `scripts/one-number/move-houses-to-service.mjs` (+ `lib/move-plan.mjs`, `backup.mjs --owner-email`). One owner per run. Dry run is the default and lists every house with residents, leases (open), bookings (upcoming), charges (open), services, applications and conversations.
- **`--mode attach` (default).** The workspace keeps its owner. Writes only `portal_workspaces` (`is_service`, `city`, `name`, `owner_of_record_name`, owner pinned in the `where`) and one `account_link_invites` row (service owner, accepted Admin, all houses, `ADMIN_STAMP` = `stampTeamRolePermissions("admin")`, pinned by a test). An existing accepted Admin row is kept (and not removed by undo); any other row refuses. Proof: a snapshot with a fingerprint of every row (all columns) of the houses and of ~50 house-keyed tables, compared after; only the workspace row and that membership may differ, owners unchanged. Any difference or error undoes the run (exit 1). Undo deletes the membership we added and restores the workspace columns.
- **`--mode transfer`.** The app's `transfer_portal_workspace_ownership` RPC (migrations 20260921000000 / 20261012121000): the service owner is first seated as an accepted member (the RPC only hands a workspace to a member), the former owner stays as Admin and owner of record, `is_service`/`city`/name are set, and an owner whose default workspace this was gets a fresh one from `ensure_default_portal_workspace` (undo removes it only while empty). Refuses without `--acknowledge-unmoved`: the RPC re-keys only twelve house-keyed tables; ~30 others (documents, bills, service requests, deposits, move-in forms, inspections, owner settings, tour state) keep the old owner's id, and workspace-keyed history keeps its owner column. The dry run lists them as LEFT BEHIND. `property_data.managerUserId` is not rewritten (the app's own transfer does not either). No promoted/demoted emails (RPC called directly).
- City gate: every house must read as the city (an explicit city field, else `street, City, ST zip`); a mixed workspace, or one with an unreadable city, STOPS the run (never splits). `--workspace-id` is the captain's explicit override that skips the gate (an empty draft with no address). Two Seattle workspaces need `--workspace-id` to choose.
- Guards: `--expect-houses <n>` (the dry run's count) on apply; journal (mode 0600) written before the first change and after each step; production needs the standard guards plus a backup taken with the same `--owner-email` (`meta.move`).
- Attach mode and the admin Service routes: `loadServiceWorkspace` still requires the workspace to be owned by the service owner, so an attached owner-held workspace is reachable through the manager workspace switcher (the service owner is an Admin member) and from Admin > Service only once the production port's attach action relaxes that check.
- Tests: `tests/unit/one-number-migration-move-houses.test.ts` (fake db with a port of the RPC: city rules, refusals, production guards, attach apply / re-run / undo / stray-write detection, transfer apply / undo / auto-undo, backup section). Proven on dev with two fixture owners: attach, SQL row-fingerprint identical before and after, undo, override for a no-address draft, transfer refusal without the flag; fixtures removed.

## W17 - Owner management: PropLane-held funds, party ledger, owner and vendor withdrawals

Authoritative design, Stripe research, ledger and legal flag: [`owner-management.md`](owner-management.md). Migration `20261018270000_owner_management.sql` (dev applied, ledger row recorded). Dev proof: `scripts/prove-managed-finance.ts` (Stripe TEST mode only, dev database only; refuses anything else).

Flags: none. A workspace is managed only when it has an ACCEPTED `managed_workspace_fee_policies` row (recorded by an admin, or created automatically for a PropLane Service workspace - nobody signs a fee policy: [`owner-management.md`](owner-management.md) § Automatic management fee); with none, every code path below is the unchanged self-serve flow. Every read of a new table treats 42P01 / 42703 / PGRST205 as "not managed".

Files:

- `src/lib/owner-management/` - `fee-math.ts` (pure: floor fee on the month's cumulative figure, leasing/minimum, spread, pro rata refund split, Pacific months), `policies.server.ts` (draft / attest / end, `ensureServiceFeePolicy` and `setServiceManagementFee`; atomic `activate_managed_policy`), `monthly-statements.server.ts`, `owner-line.server.ts` (the owner on the PropLane line: runs before routing in `inbound-seam.server.ts`), `alerts.server.ts`.
- `src/lib/managed-finance/` - `ledger.server.ts`, `capture.server.ts` (allocation of a verified platform capture), `adjustments.server.ts` (refunds, disputes), `vendor-bills.server.ts` (bills + owner approval), `withdrawals.server.ts` (reserve, Transfer, Payout, reconcile, weekly batch), `finances.server.ts`, `statement.ts`, `tax-package*.ts`, `reconcile.server.ts`, `resolve.server.ts`.
- Edits to hardened files, each a small additive branch: `household-captured-source.server.ts` (`creditManagedIfApplicable`: a managed capture is allocated in the party ledger instead of credited to a hold, for card Checkout, manual bank and autopay), `household-charge-refund-rail.server.ts` (`managed` rail: refund from the platform balance, no `reverse_transfer`), `stripe-webhook-financials.ts` (refund and dispute hooks), `stripe-household-charge-checkout.server.ts` (a cart mixing a managed workspace with another payee is refused), `work-order-approve-pay.server.ts` and `pay-from-balance/route.ts` (a managed workspace pays vendors from PropLane funds; above the owner's repair amount the owner is asked first), `vendor-invoice-pay.server.ts` (no Stripe Checkout for a managed invoice), `queryOwnerStatement` (the real fee on a managed house).
- Routes: `/api/owner/finances/*`, `/api/vendor/managed-finance/*`, `/api/admin/managed-finance`, `/api/admin/managed-workspaces[/..]`, `/api/admin/managed-policies/[id]`, cron `/api/cron/owner-management` (hourly: reconciliation every run; vendor weekly batch Mondays Pacific; owner statements on the 1st).
- UI: `src/components/portal/finances/owner-payouts-panel.tsx` (Finances › Owner payouts, `/portal/financials/owner-payouts`), the vendor Finances "PropLane balance" section (`vendor-managed-balance.tsx`), admin "Managed funds" (`admin-managed-finance-panel.tsx`, `/admin/managed-finance`).

Invariants: see `owner-management.md` § Invariants. In one line: the ledger balances, every post is idempotent on a Stripe/source id, a party never withdraws more than the ledger says is matured and owed, ownership is re-derived from the policy / property / session at every write, and a managed capture that cannot be allocated throws (never falls back to a hold).

Tests: `tests/unit/owner-management-*.test.ts`, `tests/unit/managed-finance-*.test.ts`, `tests/unit/owner-payouts-panel.test.tsx`, `tests/unit/admin-managed-finance-panel.test.tsx`, `tests/unit/vendor-managed-balance.test.tsx`.

## W21 - Owner portal (RETIRED Oct 19)

The separate owner portal (`src/components/owner/*`, `src/app/portal/owner/*`, `src/lib/property-owner/sections.ts`) is gone. An owner of a
PropLane-managed workspace uses the Property portal view-only; money is Finances › Owner payouts. Contract:
[`co-manager-access.md`](co-manager-access.md) § Property owner.

## Completeness audit fixes (messaging checklist, Oct 18)

Checklist of every spec line with its code and test: `~/.cockpit/briefs/one-number-completeness-1018.md`. Fixes found by the audit:

- **A dispatched vendor reaches their team on the shared line.** `findVendorJobCandidates` (router step 3) matched only a
  `vendor_work_order` agent session, so a rostered vendor with a dispatch offer but no login was asked "looking for a place, renting one
  out, or a vendor?" and their YES / DONE never reached `handleVendorDispatchReply`. It now also matches through the manager vendor roster
  (`manager_vendor_records.row_data.phone`, any typed format, compared as E.164) to an `offered | timed_out` attempt on an `offering |
  exhausted` run, or an `accepted` attempt on an `accepted` run or one `completed` in the last 30 days. Inactive roster rows never match.
- **Vendor photos land on the job.** `handleVendorDispatchReply` (DONE with `mediaCount`) and `handleVendorDispatchMedia` (a bare photo from
  the vendor of an accepted job) attach the text's files: a work-order run gets `completionPhotoPaths` and `linked_type = 'vendor_job'`
  (`attachVendorJobMedia`, which stores each image in the private manager-documents bucket exactly as an uploaded completion photo -
  non-images are dropped and the 6-photo cap counts what is already there), any other run links the files to the run (`linkVendorRunMedia`). Audit event `vendor_photos`. Several accepted
  jobs need `#N` in the text. The pipeline calls it before any other agent, so a login-less vendor's photo is never answered by the prospect agent.
- **Hour-before reminder.** `sweepJobReminders` in the dispatch sweep: one text to the accepted vendor when the agreed time is within 75
  minutes (not finished, not past, not accepted in the last 30 minutes). Once-only by outbox key `dispatch-job-reminder-<run>`; audit `vendor_reminded`.
- **One photo per offered room.** The lead agent's offer is now one text per room (`buildOfferBubbles`: price, availability, listing link,
  that room's first real https photo) plus a pick prompt; `UnassignedLeadTurn.bubbles` -> `unassignedBubbles` -> the seam's TwiML `bubbles`. The
  joined `reply` is still what the retry record and the inbox log store.
- **Photos on request.** Leasing tool `send_listing_photos` (shared line only, registered beside `send_my_link`): up to two real https photos
  of one live listing as MMS from the PropLane line through `sendSharedLineMessage`, to the texting phone only. It is a `read` tool that
  sends, on purpose (same shape as `send_my_link`: the prospect's own phone, public photos, asked for); a captain who wants a YES gate on it
  makes it a `defineWriteTool`.
- **The resident agent sees the photo.** `inboundImageBlocks` reads the current text's stored files (this owner's path, images only, 3.6 MB
  and four at most) into image blocks; `runSmsAgentTurn` takes `inboundImages`, puts them on the last user message
  (`attachImagesToLastUserMessage`) and pins a vision-capable model for that turn. History stays text.

Tests: `tests/integration/one-number-e2e/{routing-and-safety,vendor-dispatch-chain,prospect-journey}.test.ts`, `tests/unit/one-number-{lead-match,
mms-vision,listing-photos,feel-pipeline}.test.ts`.

## W19 - End-to-end scenario harness against the real webhook (`on/msge2e`)

`scripts/one-number/e2e-scenarios.mjs` (`npm run one-number:e2e`) drives the real `POST /api/twilio/inbound` with Twilio-signed
form bodies against the **dev** database (`emstjswhotsnyksqhqyf`; `resolveTarget` refuses any other project). Nothing is sent.

- **Transport capture, dev only.** `src/lib/sms/e2e-transport.server.ts`: with `SMS_E2E_CAPTURE_FILE` set on a non-production, non-Vercel
  runtime, `sendSms` appends the text (after consent, credit and shield have run) to that file as JSON and answers `sent: true`;
  synthetic `SMe2e...` MessageSids pass the control-keyword time look-up (`fetchTwilioMessageCreatedAt`) and loopback media URLs are
  fetched without credentials (`fetchTwilioMessageMedia`). The harness also starts the dev server with a fake Twilio account, a fake
  QStash that refuses connections (the app runs each prospect burst inline, its documented outage path) and
  `PROSPECT_SMS_BURSTS_ENABLED=1`. Unset, or on production/Vercel, every one of these paths is the real one.
- **What a run does.** Snapshots `sms_runtime_config`, flips it to `shared` with `shared_pilot_workspace_ids` = only this run's
  workspaces (and adds its managers to `pilot_manager_user_ids`), creates throwaway fixtures (`e2e-<run>-...@proplane-e2e.test`,
  `+1206555 01xx` numbers: manager and workspace, a live house with photos and tour slots, a resident with an overdue month, roster
  vendors, dispatch rules, a second team sharing a vendor, a managed-workspace owner), starts `next dev --webpack -p 3010`, posts the
  scenarios (prospect, resident, vendor dispatch, manager, owner, STOP/START/HELP/retry), asserts reply text (in voice, "service" never
  "work order", plain GSM-7) and the rows written, then removes the fixtures (account-purge manifest + phone-keyed sms tables + auth
  users) and restores the config. `--only a,b`, `--keep`, `--reap <ledger.json>` (crashed run), `--sweep` (every leftover
  `e2e-*@proplane-e2e.test` user), `--tick` (also call the burst and outbox crons, which sweep the whole shared database).
- **Guards.** A run refuses to start when the config is already `shared` with a pilot list (another run, or a crashed one).
- **Concurrency.** `sms_runtime_config` is one shared dev row: two runs (or a run and someone's `--sweep`) at once clobber each other. A run
  refuses to start when the config is already `shared` with a pilot list. `--reap <ledger>` leaves the config alone unless `--restore-config`.
- **Known limits.** The dev model client (undici over HTTP/2) sometimes drops mid-turn ("could not finish that request"): the harness
  resends once. The shared dev API gets slow under several panes; a run can time out, and its cleanup (`--reap`) is safe to repeat.
  Resident and vendor LLM flows (B, C, G) are model-driven and were not seen passing end to end; D, E, F and A pass.
- Fixes it drove (git log of `on/msge2e`): shared-line workspace for the leasing turn and its billing; comms-pool funding row for
  workspaces created after the backfill; projection of five inbound kinds; the pick carried to the leasing agent; a malformed listing no
  longer silencing the lead search; burst original proof on the shared line (`20261019010000`); today's date for the tour-slot tool; no
  second claim completion (503) on a manager reply; lockout is not "call 911" and is filed as a service; "service" in the manager tools'
  confirmations; plain quotes and "to" in SMS previews; one question per triage text; the rent figure from the ledger.

## W23 - The PropLane line answers from PropLane-managed homes only (`on/svcline`)

Captain, Oct 19: texting the PropLane line (+1 206 678 1909, held by the platform service owner in `per_workspace` mode)
got no reply to "HEY", a "can't verify that link" refusal, and 25 to 35 s answers. It must answer, and only about homes under
PropLane management.

- **The line.** `isPropLaneServiceLine` (`src/lib/service/service-catalog.server.ts`): the number belongs to the owner in
  `platform_service_settings` and is not released. In `shared` mode the line is the shared number and the router serves strangers.
- **The catalog.** `getServicePublicListings` = `getPublicListings({ workspaceIds })` over the `is_service` workspaces (the allowlisted
  public projection, 60 s snapshot). It feeds (1) the leasing agent on the line (`leasingScope.serviceCatalog`: browse and resolve
  read ONLY these homes, never the owner's own other workspaces) and (2) the stranger lead qualifier on the shared line. A failed read
  throws: the reply becomes "a teammate will follow up" (`linkRecovery.replaceWhen`), never another workspace's homes. Any other
  workspace's own number keeps its own homes.
- **Areas.** `src/lib/places/seattle-places.ts`: hand-entered table (OSM/Wikipedia coordinates, USPS zip centroids), aliases, haversine.
  `list_live_listings` takes `area`; homes come back nearest first with `areaMatch.distanceMiles` and their own `listingUrl`; a home with no
  coordinates matches by neighborhood then zip. The lead matcher (`listingsInArea`) uses the same resolver first.
- **Links.** The Luna guard now also takes the links of earlier replies, the system prompt and the site constants. For a prospect
  (`runAgentTurn({ linkRecovery })`) a bad link is redone once without links, then answered by `summarizeLeasingEvidence` from the tool
  results; the portal sentence never reaches a prospect.
- **First text.** An unclear first text gets the role question (`PROPLANE_FIRST_TEXT_REPLY`, § W29) at once, before the burst queue. A worker
  turn that produced nothing sends a fixed line (`PROPLANE_PROSPECT_FALLBACK_REPLY`) instead of failing the burst.
- **Latency.** `quietSecondsFor`: 5 s quiet window for a finished question or 4+ words, 10 s for a fragment.
- **Scenario.** `svcline` in `scripts/one-number/e2e/scenarios-svcline.mjs` (flips to `per_workspace`, makes a fixture the service owner,
  restores both). No migration.

## W24 - Vendors on the PropLane line: jobs near me, sign-up link, history that follows them (`on/smsvendor`)

Captain, Oct 19: a vendor texts the PropLane line "hey is there any available jobs in the area to do" and gets the jobs they can do, is added to the
vendor list, is offered a vendor-account link, and the chat is kept; if they take their own PropLane Number the chat moves with them.

- **Where it engages.** `handlePropLaneLineVendorInbound` (`src/lib/sms/vendor-line-inbound.server.ts`) is ONE block in `inbound-pipeline.server.ts`,
  after the manager / job-session / resident forks and before the leasing fallback. It runs on the PropLane line in `per_workspace` mode
  (`isPropLaneServiceLine`: every text from a known vendor or lead is answered; a stranger who reads as a vendor is captured and answered) and on the
  shared number (only a jobs or link ask). In shared mode an unknown number that asks for work is routed by `handleUnknownSenderInbound` to the same
  flow (`asksForJobs`); "I do cleaning in Seattle" keeps the four intake questions. `inferSenderRole` now reads "any jobs available" as a vendor.
- **No silent vendor.** Every text from a known vendor (a VERIFIED phone on a profile with a `vendor_business_profiles` row) or a lead on the line gets a reply.
  A trade word no longer adds the phone to the service owner's `manager_vendor_records` with no answer; a PropLane-line vendor is captured ONLY in `sms_vendor_leads`.
- **The jobs.** `list_open_jobs_near` (the only tool of `vendorLineRegistry`, context `VendorLineContext`; no write) is `listOpenJobsNear` over
  `loadOpenBoardCandidates` (the Find work board's own read) and `publicServiceProjection`: published, unassigned, still-open services only,
  filtered by the Seattle place or zip the text names (`resolveSeattlePlace`, nearest first) and by trade; a known vendor's saved trades / service area
  apply when the text names none. The text shows trade, a general area (zip neighborhood), when and a published budget; the title is scrubbed of any street
  (`titleWithoutAddress`). An area the table does not hold is named back, never answered with other places' jobs. Dispatch jobs appear only if published.
- **Bare trade word.** On the PropLane line (per_workspace) a stranger who only names a trade ("handyman here", "cleaner", "I do plumbing") enters the same flow: jobs, sign-up link, pending lead,
  never the old silent `manager_vendor_records` add. Other workspaces' numbers and the shared number's unknown-sender intake are unchanged.
- **Questions.** "How does it work?", "how do I get paid?", "what areas?", "is it free?" get a templated answer (`VENDOR_ANSWERS`: jobs offered in Find work, payout through the vendor account, Seattle area by neighborhood or zip)
  plus the right link (sign-up for a stranger, Find work / Payouts for a vendor), unless the text also asks for jobs or names a place.
- **The link.** One per text. A vendor with an account gets `/vendor/work-orders/find-work`; a stranger gets `mintSetupLink({kind:"vendor"})` bound to the phone,
  minted at most once per 6 hours (`SIGNUP_LINK_WINDOW_MS`; later texts say it is in the earlier text) unless they ask for LINK; minting is also rate limited per phone.
- **History.** `agent_sessions` kind `vendor_line_sms` (one per service owner + phone, unique index) with `agent_messages` keyed on the MessageSid; the next text reloads
  it (a trade or place named earlier still counts), and the inbound/outbound texts are also in the owner's Communication thread (role vendor). No model runs in this flow.
- **Upgrade.** `copyPropLaneLineHistory(db, {phoneE164, role, newOwnerId, newWorkspaceId?})` (`history-transfer.server.ts`) copies the agent session + messages (`propline_carryover`,
  `copiedFrom` per message) and the inbox thread (`deliverPortalMessageThreadSide`, `propline-copy:<owner>:<id>`) onto the new owner; idempotent, the PropLane-line copy is never changed.
  Called (never throws) when a vendor's SMS number is ready (`setupVendorWorkIdentity`) and when a resident's is (`provisionResidentAgentNumber`), with the VERIFIED phone from the profile.
- **Migration.** `20261019130000_vendor_line_history.sql` (two partial unique indexes, no table).

Tests: `tests/unit/vendor-line-{intent,open-jobs,turn,inbound,shared-unknown,history-transfer}.test.ts`. Scenario: `vendor-jobs` in `scripts/one-number/e2e/`.

## W25 - Owners, teammates and residents on the PropLane line (`on/smsowner`)

Captain, Oct 19: "residents text 'hey is there any house available' and residents text as prospects; get sent links for payments etc.
Managers/owners text about the status of their houses." Both line modes; no migration.

- **Status for people who run houses.** (Oct 25: only PropLane-MANAGED workspaces; a self-serve manager, team, resident or vendor is no longer
  served here, § W29.) `src/lib/one-number/line-member-status.server.ts` (`handleLineMemberText`). A VERIFIED phone
  (`findVerifiedProfileByPhone`: two claimants = nobody) that is a workspace owner, an accepted teammate, or the owner of record
  (`is_owner_of_record` Property owner seat) of an `is_service` workspace gets READ-ONLY status of THEIR workspace(s) on the PropLane
  line: houses, rooms occupied, rent collected vs owed, open services, next tour, leases ending within 60 days
  (`get_portfolio_status`, `portfolio-status.server.ts`, the same `summarizeRentForMonth` / availability / lease normalizer the portal and
  digest use; a part that fails to read is named, never zero). Deterministic text, no model. A teammate sees only their assigned houses and
  the modules granted on each (rent needs Payments); several workspaces: "Is this about A or B?" once, remembered under session key
  `ls:<phone>` in `sms_line_sessions`. A change request is declined ("text your work number or use the portal"; a managed client is told
  the account is view only). Never any workspace the phone does not belong to.
- **Where it runs.** per_workspace: `answerPropLaneLineText` in `processClaimedInbound`, after the work-number manager fork, only when
  `isPropLaneServiceLine` (the line owner's own team still gets the full manager agent). shared: the seam, before routing, for owners of
  record only (owners and teammates already route to their workspace with the full agent, which also gains the `get_portfolio_status` tool).
- **Residents as prospects.** `src/lib/one-number/line-intent.ts` decides intent per text (`classifyLineText`). A resident asking for a
  house ("is there any house available", "looking for another place") is a prospect for that text: per_workspace skips the resident fork and
  `handleClawLeasingInbound` ignores the known-resident hub on the service line; shared passes `asProspect` to the router so the lead agent
  answers from the `is_service` catalog. Their next text about rent or a repair is a resident's again.
- **Payment links by text.** The resident `send_my_link` (rent / move-in / lease) now mints in `per_workspace` too
  (`withResidentSendMyLinkTool`, `allowPerWorkspace`): the same phone-bound `/l/<token>` + texted code, the code sent from the lease
  workspace's own work number. A resident of ANOTHER workspace texting the PropLane line gets it from `handleLineResidentText`
  (identity via `resolveResidentSmsAgentContext` bound to the landlord that holds the lease). Leasing and vendor links still need the
  shared line. `start_rent_payment` stays the fallback; no hosted checkout link without the phone-bound unlock.
- **Scenarios.** `owner-status`, `resident-prospect`, `resident-paylink` in `scripts/one-number/e2e/scenarios-smsowner.mjs`.

## W24 - The SMS matrix: prospects, residents, vendors, managers on a workspace's own number (`on/smsmatrix`)

Captain, Oct 19: "everyone can fully communicate via SMS ... payments, tours etc.". The scenarios are `scripts/one-number/e2e/scenarios-matrix.mjs`
(`m-prospect`, `m-resident`, `m-vendor`, `m-manager`, `m-cross`; items 1-22 of the captain's matrix). Run one mode at a time:
`node scripts/one-number/e2e-scenarios.mjs --mode per_workspace --only m-prospect --tick` (production's mode: each workspace's own number)
and `--mode shared`. `MX_ITEMS=5,9` limits a run to those items. Each run ends with a table (item, PASS/FAIL, first-reply latency, the reply).

- **Harness rules.** One run at a time: the harness takes `$HOME/.cockpit/slots-1018/e2e.lock` (mkdir; waits and retries every 60 s), waits for the
  dev database to answer `profiles` in under 2 s before every scenario, gives every database call a 30 s timeout, reaps strictly one table and one
  small batch at a time, and puts `line_mode` and the service owner back (`--check-config` restores and verifies the baseline `shadow` + the real
  service owner). A workspace line fixture must carry the deployment's messaging service and campaign SIDs and be `attached` + `registered`, or
  every reply is blocked `number_not_attached` / `provider_identity_mismatch`.
- **Bugs this drove (all with unit tests).**
  1. A house named in a text to ONE manager's number (`resolvePropertyByLabelHint`) fell back to the whole public catalog and moved the entire
     conversation (inbound log, inbox notice, burst, reply) to the OTHER owner's account. `catalogHomeMayAnswerHint`: a scoped line only accepts its
     own manager's homes.
  2. Every texting resident read as the Free plan: `resident-sms-context` handed `getManagerSubscriptionTierByManagerId` the owner's USER id (it is
     keyed by the manager code), so Services and Documents tools were hidden and no maintenance request could be filed by text. A uuid is now
     answered from the user's own plan.
  3. A prospect asking the application fee got "the manager will follow up": `get_listing_details` now carries `applicationFee` from the checkout's
     own resolver. A "how do I apply" reply whose link the model typed without a lookup is redone with the home's verified links (`linkRecovery.relink`)
     instead of losing the link.
  4. Texts showed literal `**bold**`: `stripSmsMarkdown` at the outbox. A resident's message preview and the maintenance preview named the manager
     with their LOGIN email; they now show a name only (`managerLabelForPreview`). "Services -> Work orders" copy is gone from a reply.
  5. A tour booked by text (phone, no email) was never reminded: `remindableTours` accepts an email OR a phone.
  6. The assistant's vendor list filtered trade by exact string ("plumbing" missed "Plumber"): `vendorMatchesTradeQuery`.
  7. MMS from the e2e harness is loopback http: accepted only while the capture transport is on (`isE2eMediaUrl`); a skipped photo now logs why.
- **Open product decisions.** A roster vendor's free-text question (address, payout) is recorded in the manager's inbox with NO automatic reply
  (by design today); an SMS-booked tour sends the prospect no reminder text (the sweep reminds the manager); a resident's "tell my manager" needs a
  YES; the maintenance triage asks up to four questions before filing; phone-bound links (`send_my_link`, OTP unlock) exist only in `shared` mode.


## W26 - Phone-first accounts: sign up by text, and a phone on every account (`on/smssignup`)

Captain, Oct 19: texted the PropLane line "Hey I want to sign up as a manager" and got the `/demo` link. "People must put their phone number in; they should be able to create an account through SMS as well ... even if they log in with Google/Apple, ask for the number ... be number oriented."

- **Sign up by text, every role** (`src/lib/one-number/signup/`). `intent.ts` (pure) reads the ask ("sign me up", "create an account", "I'm a landlord", "I manage 12 units", "my landlord uses PropLane"; never a tour/waitlist sign-up, a room search, or a repair). `flow.server.ts` is the conversation, one question per text: role (only when the words did not say) -> full name -> manager: business name, homes / vendor: trade, area (a pending `sms_vendor_leads` row's answers are reused) / resident: the home -> optional email (SKIP) -> CODE. State is `sms_signup_sessions` (24h idle, a retried MessageSid changes nothing, CANCEL / START OVER). No model runs; copy is fixed GSM-7. The first reply of a manager / vendor also carries the phone-bound web setup link (`mintSetupLink`), so the ask is never answered with `/demo`.
- **Where it runs.** per_workspace: `handlePropLaneLineSignupInbound` (`src/lib/sms/signup-line-inbound.server.ts`), ONE block in `inbound-pipeline.server.ts` ahead of the vendor branch and the leasing fallback, only on the platform service owner's line (`isPropLaneServiceLine`). Shared: `handleUnknownSenderInbound` calls the same flow first. Replies are sent with `skipLog` (name, email and the proof code never reach the owner's Communication thread) under a `signup_conversation` consent scope the person's own first text opens. The vendor line's replies end with "Or reply SIGNUP to create it right here by text."
- **Proof of the phone (invariant).** Caller ID can be spoofed, so nothing is created on "this text came from +1...". The last question is a 6-digit code texted TO that number in our own message (`requestPhoneOtp`, purpose `sms_signup`: keyed-HMAC hash bound to challenge + phone, 10 minutes, 5 attempts, 3 sends / phone / hour, 10 wrong codes in 24 h lock the phone) that the person must text back (`verifyPhoneOtp`). A code for one phone never verifies another. Starts are rate limited per phone and for the line, and only US/Canada numbers are texted a code (`isAllowedPhoneAuthDestination`).
- **One account per phone (invariant).** Before the first question and again after the proof, `phoneOwners` (verified profile phone, confirmed Auth phone, texter contact) is read; an owner means NO second account: the person is told so and sent a one-tap sign-in link, or the plain `/auth/sign-in` address when no link may be minted for that account (below). An unreadable check creates nothing.
- **Provisioning is the website's** (`signup/provision.server.ts`): a phone-only Auth user (random `@phone.proplane.invalid` login, confirmed phone) bound by the SAME `phone_auth_bind` RPC phone sign-in uses, under the same phone lease (so `profiles.phone` + `phone_verified_at`, the contact binding and the Auth phone identity land in one transaction); then manager = `ensureFreeManagerPortalAccess` (`trialForNewManager: false`, Free plan, the business name renames the untouched default workspace), vendor = `provisionVendorAccountByEmail` + the vendor business record, resident = `provisionResidentAccountByEmail` with `emailProven: false` and NO workspace binding (the manager invites or confirms them into a home). The bind's default resident role is dropped for managers and vendors. A provisioning failure deletes the half-made login.
- **The typed email is a claim.** Stored as `user_metadata.unverified_email`; never the login, never `profiles.email`, never an inheritance key (`emailProven: false`).
- **The sign-in link** (`signup/sign-in-link.server.ts`) is the `token_hash` confirm link the guest portal uses (`/auth/confirm?token_hash=...&type=magiclink`, never a PKCE `code`): Supabase keeps only the hash, it is single use and short lived, and the account is re-derived from the phone's verified owner (never from a request value) and the text goes only to that phone. It is minted only where `smsProvenSessionAllowed` says a text alone may open that account (§ W5); anyone else is sent the plain `/auth/sign-in` address. 5 per phone per hour. No second link service was invented.
- **`sms_runtime_config.phone_required`** (migration `20261019150000_phone_first_accounts`, default FALSE on every row; the live site flips it deliberately after verifying code delivery there; dev is set TRUE). With it on, `needsPhoneVerification` sends ANY signed-in account (email, Google, Apple) without a verified phone to `/auth/verify-phone` before a portal, in any line mode. Admins are exempt (View-as is exempted by `getPortalAccessContext`); shared mode keeps its older gate untouched; phone SIGN-IN stays shared-line only. `/auth/verify-phone` and the `verify_phone` / `change_number_*` codes work in per_workspace through the platform verification sender (`TWILIO_DEFAULT_FROM`). **Fail safe:** an unreadable switch is OFF, an unreadable phone state never gates; a code that cannot be SENT shows the error and "Skip for now" (`POST /api/auth/phone/skip`), allowed only with the signed `proplane_phone_send_failed` proof set by `/api/auth/phone/start` for that account, never in shared mode; the skip cookie is bound to the account AND its last sign-in, so the next sign-in is asked again. The skip is CAPPED per account - 3 in a lifetime, one a week (`PHONE_SKIP_LIFETIME_MAX` / `PHONE_SKIP_COOLDOWN_MS`), counted and inserted in one transaction under a per-account advisory lock (`record_phone_required_skip`, `20261020110000`) so parallel requests cannot both pass, and a write that fails refuses the skip - because for `verify_phone` the person picks the number, so typing an undeliverable one manufactures the very proof the skip asks for. Only a platform-wide `phone_send_outage` lifts the cap (the skip is still recorded).
- **Website sign-up** asks for the phone on every door (manager, resident, vendor, the role-agnostic hub; `vendor-register` now refuses a missing phone). Google / Apple land on the gate above. The owner-invite hub signup posts no phone and is asked by the gate.
- **Settings > Profile > Phone > Verify** (Oct 25, `profile-phone-verify.tsx`): when the saved phone is unverified, a Verify button texts a code and shows an inline code row with Confirm, on every portal and whatever `phoneVerificationEnabled` / `sharedPhoneAuth` say. It is the `verify_own_phone` purpose of `/api/auth/phone/start` and `/verify`: a signed-in session is required, the number is the one saved on THAT user's profile (never the request's), and a number verified on another account is refused before any text ("This number is verified on another account."); wrong and expired codes answer "That code didn't match. Try again." / "That code expired. Send a new one." (`phone-own-errors.ts`). The per-IP and endpoint-wide send budgets still apply, plus 5 sends per account per hour. Every other purpose and `needsPhoneVerification` are unchanged.
- Migration: `sms_signup_sessions` is RLS on, service role only, classified in `account-purge-manifest.ts` (`user_id`; typed answers are dropped at completion and stale sessions pruned after 7 days).

Tests: `tests/unit/sms-signup-{intent,flow,provision,sign-in-link}.test.ts`, `phone-required-skip.test.ts`, `phone-auth.test.ts` (gate), `phone-auth-routes.test.ts`, `signup-phone-required.test.ts`. Scenario: `sms-signup` in `scripts/one-number/e2e/scenarios-smssignup.mjs`.

## W26 - Short stays and payment links by text (`on/smsstay`)

Captain, Oct 19: "implement messaging for residents [prospects/guests] to book short-term stays by text"; the reply states the exact price and sends a link to pay, with no third-party app.

- **Flow.** The leasing SMS agent (PropLane line in `per_workspace` and shared, and a workspace's own number) gets `quote_short_stays`, `prepare_short_stay`, `request_short_stay` (the third inline write, after `escalate_to_manager` and `request_tour`) and `send_payment_link` on SMS turns only (`withLeasingSmsStayTools`, prompt `leasing-sms-stay-prompt.ts`). One question per text (dates, guests, area); up to 3 homes with the stay total (`nightly x nights`, the figure the `stay_total` charge bills, equal to `resolveStayPricing`'s short-stay daily rate) and each home's link; a pick; "Reply YES <code>" (§ Coded confirmation on the PropLane line); the 24-hour hold, capped at 3 SMS holds per room per day and 6 per workspace per hour. `detectStayIntent` / `parseStayDates` (`short-stay/sms-stay-intent.ts`, Pacific) split short from long term; a "month" is 30 nights, over the 28-night cap, and the agent says so. Owned by [`bookings.md`](bookings.md) § Guest portal stays.
- **Pay link.** The existing `rent` purpose on the stay's own charge (no new purpose, no new destination logic). The `/l/<token>` form is now the in-page Stripe embedded checkout (card, Apple Pay, Google Pay) with "Pay from bank" (`/api/l/<token>/bank-payment`, the shared `resident-ach-payment.server.ts` core with the link session as the actor); the hosted-checkout redirect is gone. The long-term path uses the same link: `send_payment_link` for the open deposit / first-month / fee charges of the login the texting phone owns.
- **Migration.** `20261019170000_sms_stay_offers.sql` (`sms_stay_offers`, RLS on, no client grants). Applied to dev only. No `action_events` constraint changed (`channel_booking` / `tours` already admitted; new events `short_stay_unpaid_expired`).
- **Scenario.** `short-stay` in `scripts/one-number/e2e/scenarios-short-stay.mjs`.
- **Apple Pay / Google Pay.** Register `proplane.ai` as a Stripe payment method domain (Dashboard > Settings > Payment methods > Payment method domains) in the live account, and in test mode for staging/dev; the wallet buttons appear in the embedded form only for a registered domain. Dashboard step, not code.

## paysms (Oct 19) - texted codes, rent reminders and the pay link

See [`resident-payments.md`](resident-payments.md) § Pay by text link and [`sms-system.md`](sms-system.md) § Consent basis of a texted code. In short: a code is `control` class, owner / vendor notices use their own consent purposes, every rent reminder carries a fresh phone-bound `/l/<token>` (works in `per_workspace` too), reminders leave from the line of the workspace that holds the house, links in any text sit on their own line on the canonical host, OTP sends are budgeted per purpose, and lease / move-in links open a portal session after the code for a verified phone.

## Coded confirmation on the PropLane line (security review, Oct 20)

Identity on the shared PropLane line is the inbound `From`, which a caller can spoof, and the verified service manager
phone reaches every PropLane Service workspace with the full manager catalog. So a WRITE confirmed there is not
confirmed by a bare YES: the ask carries a random 4-digit code ("Reply YES 4821") and only a reply repeating it
confirms. A spoofed sender never sees the ask, so it never learns the code; the real phone always has it in the thread
it is answering. One module owns the store and the budgets: `src/lib/sms/confirmation-code.ts` (migrations
`20261020100200` / `100300` / `110100` / `120000`).

- Only the keyed HMAC hash of a code is stored (`sms_confirmation_codes`, one row per subject, 30-minute TTL), so a
  table dump hands over no live code and nothing derives one from the proposal id. With no `PHONE_OTP_HMAC_SECRET` /
  service-role key there is no code, and every coded confirmation is REFUSED rather than waved through.
- **Three wrong codes cancel the proposal** (`SMS_CONFIRMATION_CODE_MAX_ATTEMPTS`): a 4-digit secret with no lockout is
  a 13-bit PIN. A bare YES costs no attempt - it re-asks with a FRESH code, which is why the stored hash is replaceable
  but the attempt count is not. The budget belongs to one PROPOSAL (`proposal_id`, intrinsic to the proposal's own
  facts), so a later proposal on the same run starts clean and a re-ask of the open one does not.
- **Ten wrong codes from one phone in 24 hours pause the coded path for that number** (the portal is the way through):
  `sms_confirmation_failures` keyed by a keyed hash of the phone, never the number, counted and reserved in one
  transaction under a per-phone advisory lock. A count that cannot be read or written fails CLOSED.
- The subjects: a manager's pending action on the line (`pending_action`, `requireConfirmationCode` is set only when
  the turn is on the PropLane line - a manager texting their OWN work number still answers a plain YES), dispatch
  approvals / quotes / invoices / retries (`dispatch_*`), and a short-stay request (`stay_request`). The dispatch gate
  (`vendor-dispatch/approval-code.server.ts`) covers PropLane Service runs and the platform service owner's own runs,
  and FAILS CLOSED: an unreadable flag asks for a code. Each ask carries exactly one instruction, naming every form the
  parser accepts ("Y 7 4821", "1-3 7 4821 to pick"), and no instruction is promised when no code could be issued.
- Satellites, not second copies: [`vendor-dispatch-agent.md`](vendor-dispatch-agent.md) § Service roster and
  [`bookings.md`](bookings.md) § Guest portal stays point here.

## W27 - Service roster, service manager phone, one manager for every service workspace (`on/adminops`)

Captain, Oct 19: admins add vendors' phone numbers and those vendors are texted when work is needed in a managed workspace;
tours and messages for managed workspaces land in the admin portal; 510-309-8345 acts as a manager with access to ALL
service properties and is told about every inquiry, tour, stay request, application, filed service and payment.
Migration `20261019160100_service_vendors_and_manager_phone.sql` (dev applied, ledger row recorded): the two
`platform_service_settings` columns, `phone_otp_challenges.purpose` gains `service_manager` (rebuilt as the UNION of the live
list, so `sms_signup` and any later value survive), and a partial index on roster rows.

- **Roster** (`service-vendors.ts` pure, `service-vendors.server.ts`, routes `/api/admin/service-vendors`, UI `admin-service-vendors-list.tsx`):
  `manager_vendor_records` rows owned by the service owner with `serviceRoster: true`, `dispatchTrades`, `serviceArea`,
  `dispatchAvailable` (Pause), soft Remove (`active: false`, `rosterRemovedAt`; the row stays for history). One entry per phone
  (a vendor already on the owner's own list is promoted, not duplicated); a verified phone of a PropLane vendor account links
  (`vendor_user_id`). ONE intro text per entry (`introSentAt`), as the service owner, relationship attested on the vendor consent ledger
  (`consentBasis: added_by_admin_prior_relationship`, `rosterAddedBy`); a STOPped number is never texted. Intro:
  `PropLane here. <Admin> added you to our local vendor list for homes we manage. You'll get texts when a job near you needs doing. Reply YES to a job to take it.`
  plus the transport's first-text sender line with `Reply STOP to opt out.`
- **Dispatch**: [`vendor-dispatch-agent.md`](vendor-dispatch-agent.md) § Service roster.
- **Manager phone** (`service-manager.server.ts`, route `/api/admin/service-manager`, UI `admin-service-manager-phone.tsx`): a code is texted
  to the number being verified (`requestPhoneOtp`, purpose `service_manager`), `verify` saves it, audited first (`admin_service_manager_phone_change`,
  numbers masked). Texts to it use the manager-recipient purpose `service_manager_notice`, whose consent is the verified setting
  (`ensureTeamNoticeScopedSmsConsent`).
- **Alerts**: `notifyManagerFromAgent` (the one chokepoint of the notice spine, so the action-event bus, escalations, tour requests, applications,
  stays, services and payments) calls `alertServiceManagerFromNotice` for the notice's workspace; only `is_service` workspaces, one text per
  event (the per-recipient suffix of the idempotency key is dropped), digests and reminder confirmations quiet. A new person writing to the
  PropLane line (per_workspace, or a new unassigned lead) is `alertServiceManagerOfInquiry`: once per phone per day, last four digits only.
- **PropLane line**: `recognizeServiceManagerInbound` (before the generic identity fork in `inbound-pipeline.server.ts`) - Oct 25: a platform admin
  (`profile_roles` admin, verified unique profile phone) or the verified Service-settings phone (kept as an alias), and, for a seat holder, the
  delegated agent over their seats only (§ W29). The verified manager phone
  texting the PropLane line (the service owner's number, or the shared number) is the service manager: the FULL manager agent, writes behind a
  CODED yes (§ Coded confirmation on the PropLane line), over ONE service workspace at a time (landlord = the workspace's owner, actor = the service owner, access `owner`; the managed-client
  lock is the client's and never applies to the service owner). The workspace is named in the text, remembered for 6 hours (`sms_line_sessions`
  key `sm:<phone>`), else "Is this about Ambika or Vinod?". Dispatch Y / N / R / B answers across all service workspaces at once.
- **Admin Communication** (`fetchAdminSmsConversations`): adds the service owner's PropLane-line traffic and, for a client who owns a service
  workspace, ONLY texts stamped with a service workspace (`workspaceRestriction`); it reads with `visibility: "none"` (oversight is not a viewer).
  Non-service workspaces of the same client are never shown, and no manager route gained an admin branch.
  Oct 20 (`on/admcomms`): each thread is placed on its service workspace (or Unassigned) with a Workspace filter, Open in workspace and lead
  assignment - [`communication-inbox.md`](communication-inbox.md) § Admin Communication.
- Not done: the shared-mode router does not yet recognise the manager phone ahead of its own routing (per_workspace is what the live line runs).

Tests: `tests/unit/{service-vendors-roster,service-roster-dispatch,service-manager,admin-service-vendors-route,admin-sms-service-scope,service-manager-pipeline-wiring,admin-service-vendors-list}.test.ts(x)`.

## W28 - A specific home on the PropLane line that PropLane does not manage (`on/admnetwork`)

Captain, Oct 20: free managers' homes show on the public site; if someone texts the PropLane line about one, the line sends them to that
team's number. `house-redirect.ts` (pure street-number + street-name match, one edit of slack on a 5+ letter word, never a guess between two
homes) and `house-redirect.server.ts` (`resolveHouseRedirect`): a text naming a street address that is NOT in the service catalog but IS a live
public listing of a non-service workspace gets `buildDedicatedRedirectReply(<street line>, <that workspace's own number>)`; with no own number
of its own it gets the home's public link and an offer of the homes PropLane manages. A PropLane-managed home, no match or a failed read
returns null and the existing flow answers. **Superseded Oct 25 (§ W29):** the home is matched by street, house name or title; a PAID number
gets "For <street, city>, text <number>."; anything else gets a reply that names nothing (no street, no link, no name). Seams: `claw-leasing-bot.server.ts` (per_workspace line, via `sendServiceLineReply`) and
`handleUnassignedLeadInbound` (shared line, `houseRedirect` dep). Tests: `tests/unit/one-number-house-redirect.test.ts`.

## W29 - Who the PropLane line serves (`on/lineserves`, Oct 25)

One rule set for the PropLane line (the 206 number), in TWO modes. Production `line_mode` is `per_workspace` until the captain flips it to
`shared` himself (Admin > Service > PropLane line > Mode); code never flips it. **Fail closed everywhere**: an unreadable
table, a phone two verified accounts hold, an unverified phone or a missing entitlement is LESS access, never more. A "managed" workspace is
`portal_workspaces.is_service` (attached client workspaces included) or one the line's own owner holds.

### Mode `per_workspace` (the PropLane service owner's own number: homes PropLane manages only)

| Who texts the line | Gets | Where |
| --- | --- | --- |
| Platform admin (`profile_roles` admin; `profiles.phone` verified AND the only verified holder) or the verified Service-settings phone (alias) | The full manager agent over EVERY service workspace; the workspace is named in the text, remembered 6 hours, or asked ("Is this about Ambika or Vinod?"); every write behind the coded YES | `service-manager-inbound.server.ts` (`recognizeServiceManagerInbound`, `basis: "admin"`) |
| Accepted seat on a service workspace (attached ones too) | The delegated manager agent over every managed workspace they hold a seat on, limited to that seat's houses and module grants; a Viewer seat (or one with no edit grant on the workspace's houses) is `readOnly`: the registry holds no write tool | same file (`basis: "seat"`, `buildServiceManagerAgentContext`); `ManagerSmsAccess.readOnly` in `buildManagerSmsRegistry` |
| Resident of a managed home | Unchanged (resident assistant; the rent-link ask) | `line-resident.server.ts` (managed residencies only) |
| Prospect | Unchanged leasing assistant, searching ONLY managed homes (`serviceCatalog`, `getServicePublicListings`) | `leasing-sms.ts` |
| Vendor | Unchanged vendor flow over managed jobs | `vendor-line-inbound.server.ts` |
| Unknown number, CLEAR first text ("Any rooms near UW under $1,000?", "I'm a plumber") | The flow it asked for, no question | `classifyFirstText` |
| Unknown number, UNCLEAR first text ("hi", "who is this") | ONE question: "Hi, this is PropLane. Are you a resident, a vendor, looking for a place, or want to manage your own property with PropLane?" On a manager's own number the name is the workspace's. Answers: resident -> told where to look; vendor -> the vendor flow (a manager's own number: "What trade do you do...?"); looking -> the leasing assistant; manage -> "Great, set up your homes here: https://proplane.ai/auth/create-account?role=manager A personal work number comes with Pro." The question carries no STOP line (its wording is fixed), so the opt-out notice rides the reply that FOLLOWS it (`withOptOut`) | `role-question-line-inbound.server.ts`; shared mode: `unknown-sender.server.ts` |
| Asks about a SELF-SERVE home (street, house name, or a listing title with a distinctive word in it - "Private Room" names no home) | Its manager's PAID number (`managerPersonalNumberEntitlement`; a trial or a lapsed plan is not paid): "For 12 Elm St, Louisville, text (502) 555-0142." Nothing else. No paid number: "I can only help with homes PropLane manages. Looking for a place in Seattle? Tell me your area, budget and move-in date." (no street, no link, no name) | `house-redirect.server.ts` |
| Self-serve manager, their team, residents, vendors with an open job | Not served: "This line is for homes PropLane manages. Text your work number <number>." (paid) else "...A personal work number comes with Pro: proplane.ai/pricing". A housing search, a jobs ask, STOP/HUMAN/emergency are not redirected | `line-member-status.server.ts`, `line-inbound.server.ts`, `self-serve-line.server.ts` |
| Anyone texting a manager's own work number | Unchanged (it answers only for that workspace), plus the unclear-first-text question above | `inbound-pipeline.server.ts` |
| Anyone texting a PropLane-managed workspace's OLD own number (Ambika, Vinod) | Still routed to that workspace (nobody who saved it is stranded); the reply leaves from the 206, and every send about a managed workspace does, in both modes | `resolveOwnedWorkNumber`; `resolveServiceLine` (§ PropLane-managed workspaces always text on the 206) |

### PropLane-managed workspaces always text on the 206 (Oct 25, both modes)

Captain: "update the work number for ambika and vinod to be 206 since they are under proplane admin portal management and anything under that
management use main 206 number now." Every workspace with `portal_workspaces.is_service = true` sends on the PropLane line, in `per_workspace`,
`shadow` and `shared` mode, even when it still holds a live `manager_sms_numbers` row of its own (Ambika's +1 (814) 679-3694). The line is
`resolveServiceLine` (`src/lib/one-number/service-line.server.ts`, a leaf module): `shared` mode = `sms_runtime_config.shared_number_e164` (sent
through the shared messaging service, the managed workspace's own wallet pays); otherwise the number the platform service owner holds on its
DEFAULT workspace (the line `isPropLaneServiceLine` recognises). One decision, four consumers:

| Consumer | What it does for a managed workspace |
| --- | --- |
| `evaluateWorkspaceSendReadiness` (the dispatcher's final from-number) | `resolveManagedSendTarget` decides managed-ness from the named workspace, the stamped outbox workspace, the pinned line's workspace or the house, else the owner's default; any of them managed = the 206. The registration, runtime, provider-identity and wallet checks then run on that line (`evaluateNumberRowReadiness`): the wallet is still the managed workspace's own, while the rollout allowlist gates the NUMBER and so is read against the line's holder (the service owner), never the workspace's owner |
| `resolveActiveManagerSendNumber` / `resolveWorkspaceSendLine` | Answer with the 206 (`numberId` stays the workspace's own row, which names the workspace to the dispatcher). `{ ownLineOnly: true }` asks the old question, "does this workspace hold a number of its own" (vendor dispatch uses it) |
| `resolveOwnerSendNumberRow` / `resolveWorkspaceStatusLine` | The 206 first, ahead of the workspace's own rows and a pinned line id. A pinned id is checked for ENTITLEMENT first (the owner's own `manager_sms_numbers` row, or one a workspace of theirs holds in `workspace_work_numbers`): a line that is neither answers nothing, so the managed override can never hand an owner a line they have no claim on |
| `GET /api/manager/messaging-number` | `sharedLine = { number: 206, onSharedLine: true }` in both modes (the "PropLane line" row and the teammate "Workspace number" row), `number` and the workspace's `numbers` hide the old number, `canRequest` false, no add-on; `POST` and `PATCH` refuse (403 "This workspace texts from the PropLane line."); `provisionNumberForWorkspace` refuses too |

Fail closed: no service owner, no live service-owner number, or an unreadable `portal_workspaces` / `platform_service_settings` /
`sms_runtime_config` read refuses the send (`workspace_has_no_work_number`, or `control_plane_unreadable` for a failed read). It never falls
back to the workspace's old number and never retries on the owner's default line (`sendWorkspaceText` lost its old retry). Inbound is unchanged:
a text still arriving on a managed workspace's OLD number routes to that workspace (`resolveOwnedWorkNumber`), and the reply leaves from the 206.
Staff and seats texting the 206, and self-serve workspaces, are unchanged. The old number is not released here (no provider call): that is an
operator step. Tests: `tests/unit/service-workspace-propline-line.test.ts`.

**Every display of a managed workspace's number goes through the resolver (Oct 26).** `resolveServiceLine` /
`workspaceWorkNumber` / `resolveActiveManagerSendNumber` decide what is SHOWN as well as what is sent: nothing reads
`manager_sms_numbers` directly to draw a workspace's number. The resident conversation header
(`loadResidentCounterparties`: `workPhone` is the 206 and `onPropLaneLine: true` for a managed workspace, drawn "(206) 678-1909 ·
PropLane line"), Admin › Service's row and Integrations/Settings all agree; an unresolvable line shows nothing, never the old
number. Audited and left alone because they are not displays: `service-catalog.server.ts` `isPropLaneServiceLine` (recognition) and
`wallet.server.ts` `resolveWorkspaceIdForWorkNumber` (placing a number). **The old number is kept receive-only** (inbound still
lands in that workspace, replies leave from the 206) until an admin presses Admin › Service **Release old number**
(`releaseServiceWorkspaceOldNumber`, audited first, admin only); no timer releases it
([`admin-service.md`](admin-service.md)). Tests: `tests/unit/{resident-counterparty-managed-number,admin-service-workspaces,admin-service-panel}`.

### Mode `shared` (Oct 25: the 206 is every free or trial manager's work number, with full service)

`line_mode = shared` makes the 206 the work number of every workspace WITHOUT a personal number (`workspaceOnSharedLine`: not dedicated, inside
the pilot list when there is one). Everything the per_workspace table says about "self-serve is not served" is per_workspace only; the
"This line is for homes PropLane manages" / "I can only help with homes PropLane manages" replies never appear in shared mode.

| Who texts the 206 | Gets | Where |
| --- | --- | --- |
| Free or trial manager (owner) / their teammate | The manager SMS assistant for THEIR workspace (as if they texted their own work number); every text they send to residents, vendors and leads goes out from the 206 | router `findTeamMemberCandidates` -> pipeline (`handleSharedLineInbound` `continue`) |
| Their residents, vendors, applicants | Their normal flows for that workspace (resident assistant, vendor job flow, leasing) | router, same seam |
| Prospect (stranger, or a resident searching) | The lead agent over the OFFER catalog: managed homes, free managers' homes and (as offers only) paid managers' homes, tagged by tier. A pick or a text naming one home locks the line to it (§ W30). | `line-catalog.server.ts` (`getLineOfferListings`), `lead-match.ts` (`matchOffers`), `unassigned-leads.server.ts` |
| Prospect asking about a home WITH a personal number | Nothing on a mere mention (`resolveHouseRedirect` returns null in shared mode). On interest (a pick, a text naming the home, a yes to the switch question): "12 Ravenna Pl is listed by Marcus. To learn more or book a tour, text Marcus at (206) 555-0142." and only that interest text + the reply land in the manager's Communication (§ W30). When the number cannot be named, nothing about the home is said | `unassigned-leads.server.ts` (`paidInterestTurn`) |
| Anyone whose workspaces ALL have a personal number | The dedicated redirect: "<house> texts from (XXX) XXX-XXXX. Please text that number." | `dedicated-redirect.server.ts` (unchanged) |
| Unknown number, UNCLEAR first text ("hi", "who is this") | ONE reply, "Hi! This is PropLane. Which home are you texting about? (street or house name)", and the text waits in Admin > Unassigned (an open `hold` lead), never in a Communication; a SECOND unclear text gets the role question; "manage my own" answers "Set up your homes here: https://proplane.ai/auth/create-account?role=manager You'll text from this number until you get your own." (the link stays bare: nothing glued to it) | `unknown-sender.server.ts`, `MANAGE_OWN_SHARED_REPLY` |
| Admin, service-seat holders, owner of record, managed residents/vendors | As in § per_workspace (the pipeline's service-manager recognition and `handleLineMemberText` `shared_line` are mode independent) | unchanged |

### Personal-number redirects (both modes, before any routing)

`personalNumberRedirectFor` (`personal-number-redirect.server.ts`) runs first on the 206: in the shared seam (`handleSharedLineInbound`, before the
member/owner/router steps) and on the per_workspace line (`answerPropLaneLineText`, after the sign-up intent check). A sender whose VERIFIED, unique
profile phone owns:

- an active resident PropLane Number with an entitled subscription (`NUMBER_SUBSCRIPTION_ENABLED` and `numberServiceEntitled`): "You have your own
  PropLane number, (425) 555-0110. Text it to find homes, book tours and reach your manager."
- a ROUTABLE vendor number (`getRoutableVendorNumber`: active and entitled): "Text your PropLane number (206) 555-0177 for jobs and messages."
  (A person with both gets the vendor number for a work ask, the resident number otherwise.)

is pointed at it. Lapsed, unreadable, unverified or shared phone = no redirect (they are served normally). Never redirected: STOP / HELP / START,
HUMAN, emergencies (`isLineKeywordOrUrgentText`), a dispatch answer (`parseVendorDispatchReply`), "is it fixed?" answers, and any account that holds a
manager-side role or a workspace seat (their texts here run houses). Reads only.

Invariants: the first-text question is asked once per number PER LINE (nothing was ever sent to it, `sms_outbox`, AND no `asked_at` inside the
window naming this line in `asked_line`). The ask is recorded BEFORE the question is sent and only one request wins it (`claimRoleQuestionAsk`, a
compare-and-swap on the `asked_at` just read), so a burst of unclear texts that arrives before the question's outbox row lands is asked once and only
once; an ask that could not be stored is not sent at all (its answer could never be read back, so the text takes the path it always took). Its answer
is read within 24 hours of `asked_at`, whenever THIS line holds that live ask - a role the phone gave ANOTHER line does not close this line's question -
and recording any answer clears `asked_at`, so no later text is re-read as one. The answer carries the
opt-out notice the fixed question cannot, and a webhook retry answers once (`dedupe_key line_role_<sid>`). A seat's admin-ness is never inferred:
the legacy `profiles.role` and the ops email are not evidence for the phone door. Shared mode (above) is code-complete but OFF in production until the captain flips `line_mode`; per_workspace behaviour is unchanged by it. Tests:
`tests/unit/{propline-shared-mode,propline-personal-number-redirect,propline-line-policy,propline-first-text-classifier,propline-first-text,one-number-house-redirect,one-number-line-status,one-number-line-resident,service-manager,service-manager-pipeline-wiring,one-number-unknown-sender}.test.ts`.

## W30 - Stranger sorting, tiered offers, the home lock and the switch question (`line-206-chat-1026`, Oct 26)

Shared mode only (per_workspace behaviour is unchanged). Captain's decisions 2, 5, 6, 7, 8 on the plan `claude-2/line-206-chat-1026`.

**Sorting a stranger (`unknown-sender.server.ts`).** A text that names exactly one home (street, house name or listing title, matched over the
OFFER catalog by `matchListingsNamedIn`) needs no role question: the lead flow locks the line to that home. A tour/booking ask with a day, or a
search for homes ("what houses are in Seattle?", `asksTourWithDay` / `asksForHomes` in `home-lock.ts`), goes to the qualifier. Anything else
unclear gets ONE reply (`HOLD_REPLY`) via `handleHoldInbound`: an open lead in stage `hold`, turns recorded in `sms_unassigned_lead_turns`, nothing in
any workspace. A second unclear text gets the role question as before; a named home on the next text locks and the hold leaves Unassigned.

**Tiered offers.** `line-catalog.server.ts` `getLineOfferListings` / `sharedLineOfferListings` return the public homes (still
`getPublicListings`, the allowlisted projection) tagged `lineTier` (`line-tier.ts`): `managed` (`is_service`), `free` (answers on the 206), `paid`
(dedicated workspace with a personal number). The served catalog (`getLineCatalogListings`, used by the redirect and the followups) is unchanged and
has no paid homes. `lead-match.ts` `matchOffers`: one managed, one free, one paid home when each has a fit (cheapest of each), otherwise the best fits;
never two homes from one manager; 3 offers, or 4 when exactly 4 managers have a fit; cheapest first. Offer text never carries a phone number
(`tests/unit/one-number-lead-match.test.ts`, `line-206-home-lock.test.ts`). The qualifier asks budget, move-in, area and room type, and asks the
household question only while MORE than 4 rooms fit (`countFittingRooms`); the headcount never filters a match.

**The lock.** `sms_line_sessions.locked_property_id` / `locked_at` (migration `20261026120000`; code before it reads and writes the session without
the lock). Set by a pick of an offered home, by a text naming one home, or by a yes to the switch question - always through
`assignLeadToHouse` (managed / free: the lead is claimed for that home's workspace, the thread is tagged with the home via `tagConversationHouse`
so only the owner and the co-hosts who hold it see it, the session points there) or `paidInterestTurn` (paid). `assignLeadToHouse` NO LONGER replays
the browsing transcript for a prospect pick (it held the other managers' homes): the manager's conversation opens with one "Looking for: private room
near UW - under $1200 - Dec 1 - 6 mo" line (`lookingForLine`), then only texts about their own home (the text itself continues through the normal
pipeline). Only a PropLane staff placement into a PropLane-owned (`is_service`) workspace still hands over the whole conversation; a placement into a free or paid manager's workspace gets the same "Looking for" line. Pre-lock browsing stays in Admin > Unassigned, read-only,
and leaves it when the lead is assigned.

**Paid homes.** A paid manager's home is offered but never described by the line. On interest (a pick, a text naming it, a yes to the switch question)
the reply is `paidInterestReply` ("12 Ravenna Pl is listed by Marcus. To learn more or book a tour, text Marcus at (206) 555-0142.", number from
`paidWorkNumberFor`, first name from `profiles.full_name`) and ONLY the synthesized interest text plus that reply are written into that manager's
workspace Communication (`recordPaidInterest`: prospect conversation through the conversation key, tagged with the home), so the thread continues when
the prospect texts the manager's own number. Later texts from the locked phone get the same reply again, written nowhere. A number that cannot be
named says nothing about the home and does not lock.

**The switch question (`locked-prospect.server.ts`, called from `routeSharedLineInboundWithReply` before candidates are decided).** For a phone
whose only ties are returning-prospect ones and that has a lock: a text naming a DIFFERENT home, or pointing at an offered one by position ("the other
one", "#2", "the first one", "interested in 3" - `offerReference`, deliberately narrow), is never acted on. The line asks "Are you asking about <street>,
<room>?" (or "Which one? 1) ... 2) ..." for several) and stores it as `pending_candidates`. The question and the answer are written to an open lead
in Admin > Unassigned and to NO workspace. YES (or a number / name from the list) re-locks (managed / free: `assignLeadToHouse` + a one-line details
reply logged in the new workspace; paid: the interest flow above); NO answers "OK, still talking about <street>." and keeps the lock; any other text
lets the question lapse and is read fresh. Everything else routes to the locked home's manager.

Tests: `tests/unit/line-206-home-lock.test.ts` replays the plan's A5 conversation through the router over an in-memory database and asserts, after every
text, which workspaces got new message rows; plus `one-number-{lead-match,unassigned-leads,unknown-sender,session,house-redirect}` and
`propline-shared-mode`.

**The leasing agent knows the locked home.** `runLeasingSmsAgentTurn` reads `sms_line_sessions.locked_property_id` for the texting phone
(`locked-home-context.server.ts`, never from the text), re-checks the home is live and belongs to the routed manager and workspace, and puts
`lockedHome` in `LeasingSmsAgentScope`, a sentence in the system prompt (`lockedHomePromptNote`) and a head-of-list preference in `list_live_listings`
(`lockedPropertyId` in its result). A switch moves the lock, so the next turn carries the new home; a lock that points at someone else's home is no
lock. Tests: `tests/unit/line-206-leasing-locked-home.test.ts`.

## W31 - The 206 on the booking sites, and guest messages by email (`channel-inbox-1026`, Oct 27)

The 206 goes on every listing as the contact phone; the host's own account phone on Airbnb, Booking.com, PadSplit and SpareRoom STAYS
(it receives their sign-in codes - switching it risks a lock-out). The sites never text guest messages, so those arrive by EMAIL at the work email
and are answered by the leasing assistant ([`inbound-email-inbox.md`](inbound-email-inbox.md) § Booking-site guest messages). A reply on Airbnb or Booking.com
never carries the 206 (or any link, phone or email); PadSplit and SpareRoom replies may. On a PropLane-managed (`is_service`) workspace the email
assistant browses the managed-homes catalog (`serviceCatalog`), like the 206. Availability in any reply is the CHECKED calendar only
(`list_live_listings` / `get_listing_details` / `check_room_availability`); a failed read says "let me confirm", never "available".
