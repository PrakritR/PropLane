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
- `lead-redact.ts` - local redaction call site (card / bank / SSN numbers never stored). Swap its body for `redactSensitiveNumbers` (`redact.ts`, transport workstream) when the branches meet.
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
