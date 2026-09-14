# PRP-472 safety addendum - observed source acknowledgements

Read-only planning, September 13, 2026, revised after the real dev/test URL-size probe. This supplements `2026-09-13-prp-472-plan.md`; it does not authorize implementation, release, production work, or changes to existing message writers. Source inspected in pool 6 while PRP-470 was active, based on `7b3d464fe2f102a527949044fc0289513d50029f`. Transfer this contract to the PRP-472 keeper after the reviewed PRP-470 dependency is recorded.

## Decision

The task is feasible inside the existing route and store with one additive, service-role-only database function. Root authorized planning this narrow migration after the concrete URL-size failure; this supersedes the original plan's no-migration exclusion for this function only. No existing message writer changes. Add server-generated observations for the actual database rows whose content was returned, carry them through display collapse, and acknowledge only those observations through a metadata-only action. Use both `updated_at` and exact current `row_data` equality inside a conditional database update, invoked by POST RPC with expected JSON in the request body. Do not widen this ticket into a message-writer or person-identity rewrite.

The existing SMS helper supplies a useful CAS loop shape, but its read behavior is unsafe for this contract. `updateSmsNoticeMailboxState` re-reads the newest row and applies the browser's `unread: false` unconditionally. The existing `sms-inbox-notice-concurrency.test.ts` explicitly expects a previously unseen arrival to become read. Reusing that helper would preserve message bodies but violate PRP-472's unread guarantee. Preserve the existing basic SMS-notice path and its test; add the narrow action for the combined pane.

## What current code proves

- `src/app/api/portal-inbox-threads/route.ts` GET selects `updated_at`, then discards it before collapse. POST has whole-row upsert/replace and an SMS-specialized mutation, but no observed-read action.
- `collapsePersonInboxThreads` in `src/lib/portal-inbox-storage.ts` returns the newest row's ID, the oldest message's body, and a union of `sourceThreadIds`. `inboxThreadMessages` synthesizes the displayed root ID from the returned row ID. The canonical row's real root can become `merged:<id>-root`. Therefore neither the canonical ID nor displayed synthetic message IDs identify every observed database source correctly.
- Persisted `sourceThreadIds` are historical display metadata, not authorization and not proof that a source still exists or was in this GET. New same-person database rows can arrive after the GET.
- `appendOrCreatePortalMessageThread` in `portal-inbox-delivery.ts` uses a whole-row upsert and millisecond `new Date().toISOString()` timestamps. The schema declares an ordinary `updated_at` column. A timestamp alone is not a unique revision: two writes can have the same value.
- Root tested exact JSON equality against an isolated dev/test record: a 4,112-byte predicate returned 200, a 20,232-byte predicate representing 50 realistic messages returned 400, and a 60,582-byte predicate representing 150 returned 414. Root deleted the synthetic probe. This is a confirmed capacity blocker for URL-based equality, not a hypothetical concern. Do not ship a URL filter, truncate history, or drop the exact CAS guard. A body-based POST RPC removes this URL constraint while leaving all writers unchanged.
- The graphify query failed because this installed CLI looked for `graphify-out/graph.json`. No graph was rebuilt or changed. The findings above come from the authoritative documentation and inspected source.

## Smallest server contract

### GET observations

Add a response-only `readSources: Array<{ id: string; observation: string }>` field to the inbox transport row type. For each raw database record, overwrite this field with a single source minted from that record's actual primary key. Never copy this field from stored JSON or derive the raw source list from stored `sourceThreadIds`.

`observation` is a deterministic server SHA-256 of a canonical serialization of the actual durable record identity (`id`, scope, owner, participant, thread type), `updated_at`, and `row_data`. Sort object keys recursively for stable JSON; preserve array order. This is a compact stale-state check, not a credential or an authorization token. The browser never needs the raw source JSON or a signing secret.

Union these newly minted observations through both collapse functions, including a second client-side collapse. Preserve existing `sourceThreadIds` for existing navigation behavior. If the same ID occurs with conflicting observations, do not silently choose one for acknowledgement. Mint observations only after the GET has applied its existing authorization and explicit scope filter. No row absent from this GET gets an observation merely because it shares an email or phone.

The UI must derive both its email bubbles and its read candidates from the same selected non-trash thread snapshot. A token covers the complete returned source content, not just its preview. Root re-labeling does not affect this contract. Keep attachments attached to the message whose body they accompany: current person collapse spreads canonical attachments while replacing the root body with `first.body`; the narrow projection fix is to carry `first.attachments` as the root attachments, including clearing them when absent. Test this as part of proving the source's full displayed content. Do not redesign collapse or re-parent persisted messages.

Treat `readSources` as transport metadata. Strip it from any generic upsert serialization, both client and server boundary as applicable; never persist browser-supplied observations into `row_data`. Existing viewer-scoped cache/session storage may carry it, but old snapshots without it cannot auto-acknowledge until a successful normal GET supplies it.

### POST action

Add only this action to `/api/portal-inbox-threads`:

```ts
{ action: "markRead", scope: MANAGER_INBOX_SCOPE,
  sources: [{ id, observation }] }
```

Validate the known scope, nonempty bounded ID/token strings, unique sources, and a batch limit consistent with GET's 500-record cap. Reject conflicting duplicate IDs and unsupported scopes. The request has no body, messages, folder, owner, email, draft, or requested unread value.

Resolve the effective viewer using `resolveInboxScopeUser(scope)`. Re-authorize every requested raw ID before any mutation, with `applyPortalInboxThreadScope` and an explicit `scope` equality. Use the existing manager `inbox/edit` linked-owner authority, matching the current persisted mailbox write path. A Communication read-only co-manager does not gain shared mailbox write access from this new action. If read-only acknowledgement is desired later, that is an explicit permission decision, not an incidental change here. A batch containing an inaccessible or missing ID fails without writing its authorized subset.

For each authorized record:

1. Read current identity, `row_data`, and `updated_at` under the authorized scope. Trash is never altered. A currently read row can return an idempotent `alreadyRead` result.
2. Recompute the observation. If it differs from the submitted observation, return `changed` and current unread metadata. Do not clear it and do not replace the request token with the new state. This conservative rule can defer acknowledgement after a draft or other unrelated edit; it is safe and keeps the action small.
3. After matching the observation, call the single service-role RPC described below with the current DATABASE identity, timestamp and exact JSONB snapshot. Do not forward browser-owned identity or JSON to the function. The only intentionally changed durable metadata is `unread` plus `updated_at`; SQL computes that patch from the locked/matched database row. Do not call the generic upsert builder or `updateSmsNoticeMailboxState`.
4. Invoke `db.rpc` normally as POST, with arguments in the body. Do not use GET/head mode, append expected JSON as URL filters, or fall back to a direct write if the function is unavailable. A true result means precisely one matching source was changed; false means no row was changed. Database/function/schema-cache errors remain errors, not successful acknowledgements.
5. On false, re-read and re-authorize with a bounded retry. Recompare against the ORIGINAL observation. A changed source is not acknowledged. Exact row equality closes the same-millisecond race, including concurrent draft/folder/body edits. It must not be dropped as an optimization.

Return per-source outcomes tied to the submitted observation: `read`, `alreadyRead`, `changed`, or `archived`, and the current unread boolean where appropriate. Do not return a fresh observation for content the response does not display. Never discover additional same-person members in this action or recursively call `smsNoticeMembers`. A new database member row remains untouched and unread.

Authorization preflight prevents ordinary mixed-ID partial writes. A database failure or a later concurrent permission change can still produce partial success across several independent rows; report/reconcile honestly and make retry idempotent. Each source update is atomic. A batch-wide transaction, new application route, receipt table, new message revision column, and changes to existing writers remain out of scope.

## Narrow database function and migration

Add one uniquely timestamped, idempotent migration defining exactly one function, provisionally:

```text
public.mark_portal_inbox_source_read(
  p_id text,
  p_scope text,
  p_owner_user_id uuid,
  p_participant_email text,
  p_thread_type text,
  p_expected_updated_at timestamptz,
  p_expected_row_data jsonb
) returns boolean
```

Use `LANGUAGE sql`, `VOLATILE`, `SECURITY INVOKER`, and a fixed empty `search_path`, with fully qualified relations and functions. This operation does not need `SECURITY DEFINER`: the existing service-role client already has the required privilege. The function owner is the normal privileged migration owner, never an app client role. Function ownership does not authorize a portal user; the server route's existing authenticated scope resolution remains the authorization boundary.

Its one data-modifying statement conditionally updates `public.portal_inbox_thread_records`, using a CTE and `RETURNING` to return whether a row changed. Predicates must include:

- Exact primary key and `scope = p_scope`, with an additional literal manager inbox scope restriction. Reject null/empty IDs, null owner, null timestamp, and null/non-object expected JSON by matching nothing. This function serves only the new manager action.
- Owner UUID, participant email and thread type equal the server-read expected identity, using null-safe equality where nullable. All parameters come from a row the server authorized, not from browser fields. This pins the owner/participant identity against a concurrent reassignment; parameters are preconditions, not an independent authorization grant.
- `updated_at = p_expected_updated_at` AND `row_data = p_expected_row_data` as native JSONB equality. Same-millisecond changes therefore fail the CAS. Do not hash inside SQL, substitute JSON containment, compare only message counts, or match only a preview.
- Current folder explicitly in `inbox`/`sent`, and current JSON `unread` exactly the JSON boolean true. Trash, malformed state, and already-read rows are no-ops at this layer.

Compute `row_data` with `pg_catalog.jsonb_set` on the DATABASE row, setting only `{unread}` to JSON false. Compute `updated_at` in SQL as the greater of `clock_timestamp()` and the old timestamp plus one microsecond. No replacement JSON, caller-supplied new timestamp, message changes, folder changes, insertion, deletion, or same-person member expansion is accepted. The database rechecks the full predicate when a concurrent update wins the row lock. Return only a boolean, not private row contents.

The server preflight applies `applyPortalInboxThreadScope` plus explicit scope and existing `inbox/edit` co-manager lookup before calls, and again whenever it re-reads after CAS failure. The function deliberately does not duplicate the application's permission catalog or accept a browser-supplied allowlist. It pins the exact authorized row identity. As with the current service-role routes, a separate concurrent co-manager permission revocation is not serialized with every row write; do not claim a new cross-table authorization transaction in this ticket.

Create/replace the function and set grants in one migration transaction, leaving no commit where default public execution is exposed. Revoke ALL on the exact function signature from `PUBLIC`, `anon`, and `authenticated`; grant only EXECUTE on that signature to `service_role`. Restate the revokes on every idempotent apply. Do not add an overload, table grants, RLS policy, or broad schema privilege. Verify the service-role table privileges already support the invoker operation. If they do not, report the concrete failure rather than silently switching to SECURITY DEFINER or granting client roles access. Migration-owner administrative access is inherent and is not exposed through the client API.

The function exists in the exposed public schema for RPC discovery, so execution privilege is load-bearing. Verify both catalog grants and actual calls with anon and ordinary authenticated credentials; knowing an ID, observation, or full JSON snapshot must not make the function callable. Do not rely on RLS alone. No new table is introduced, so no account-purge table classification is needed.

### Dev-only apply and validation

Read `docs/database-environments.md` before execution. The app's `assertNonProdDatabase()` does NOT guard Supabase CLI. Explicitly confirm both the runtime URL and the CLI linked project are `emstjswhotsnyksqhqyf` before any push; never infer the CLI target from `.env`. No staging/production apply is authorized by this plan.

Inspect `npm run db:status`, migration-name history and the `npm run db:push -- --dry-run` pending list before apply. The new migration must have a unique version prefix and an appropriate position relative to recorded history. Compare history by name when versions differ. Read every pending migration: authorization for this function does not authorize replaying unrelated data/schema changes, locked listings migrations, or a blanket `--include-all` push. If the pending set is not exactly this reviewed change (or separately authorized pending work), stop that apply and give root the concrete list to resolve. Do not repair migration history, mark migrations applied, hide files, or relink staging/production to bypass the issue.

Once root's implementation/review flow has the concrete migration and the dev target/pending set are verified, apply through the repository `npm run db:push` path, then confirm recorded status and RPC discovery. Use `--include-all` only if its entire resulting pending set has been inspected and separately resolved. Missing function/schema-cache responses fail closed in the app; no unguarded fallback. The subtask producing this addendum applies nothing.

Probe on a namespaced dev/test synthetic record, preserve unrelated rows, and clean up in `finally`. Repeat the previously failing 50- and 150-message histories with attachments, passing expected JSON only in the RPC POST body. Verify equality matches unchanged JSON, rejects a changed body/append/draft/folder with the SAME timestamp, and changes only unread/timestamp. Test changed owner, participant, scope, thread type, and timestamp individually; none may mutate. Exercise a deterministic append while CAS waits on the row, not merely a sequential mismatch. Test idempotent retry and already-read/archived records. Check anon and authenticated calls cannot execute, then verify the service-role call succeeds. Test body/request failure preserves unread and history; do not lower the supported history capacity to make a probe green.

Also run migration-version uniqueness and an executable grant/behavior test; a source-text migration assertion alone is not sufficient. Record exact exits and statuses without logging service credentials or full message bodies. No production/staging changes, SQL Editor apply, or message-provider sends belong in these checks.

## Client integration

Add one narrow helper next to the existing storage mutations in `portal-inbox-storage.ts`, backed by the new action. It captures viewer generation, source observations, and the selected rendered content snapshot. Stage only an unread metadata change, never `persistInbox`/upsert a collapsed row. Preserve PRP-470's successful-load/TTL/in-flight behavior.

An optimistic acknowledgement is keyed by the exact observations it covers. Reconcile success or failure against the current cache, never restore a whole old row. If the viewer changes, discard the result. If a newer content/source snapshot arrives, an older request cannot clear its unread flag or overwrite its body, preview, time, folder, draft, or attachments. On `changed`, remove only that optimistic acknowledgement; retain the server's unread result until the normal refresh displays the new content. On failure show a concise recoverable error and offer an explicit retry/reopen path. Do not retry indefinitely because optimistic rollback causes another render.

Only a mounted, selected, document-visible combined pane acknowledges. A visibility event can re-enable acknowledgement once visible. Define existing read-on-view semantics as: the selected pane's rendered snapshot is observed; no scroll-position receipt model is added. Newly rendered arrivals while visible get new observations and may be acknowledged. Hidden-tab or other-thread arrivals remain unread. Deduplicate requests by viewer + scope + observed source set; emit existing store events only for real changes. An unread-list row disappearing after acknowledgement must not cause a request loop or automatically open another row.

## Exact native SMS source wiring

`ResidentDirectChatPane` already accepts `smsResident`; the parent currently fills it with `smsResidents.find(residentEmail === directChatEmail)`. Change the parent resolution before adding read behavior:

- Parse the selected unified row's `memberKeys` (or its own key) with `parseUnifiedInboxKey`. Resolve each selected SMS key against `smsConversationId`, `conversationKey`, or an exact server-returned SMS `memberKeys` alias in the already authorized payload.
- Pass the resolved source object to the existing prop. Its missing `residentEmail` does not invalidate an exact selected key. A supplied explicit key that cannot resolve must not fall back to email or phone. Respect the owner/role encoded in the selected key and the server-returned source identity.
- With no explicit selected SMS key, retain only the established unambiguous exact-email fallback for a direct contact pane. Never infer a match from a name, body, or shared phone. Multiple distinct selected native sources must all be rendered before all are marked; if necessary add a small plural source prop while preserving existing singular callers. Do not pick an arbitrary first source and acknowledge the rest.
- Extract the opened-ID utility shared by `pro-sms-panel.tsx` and `pro-unified-inbox.tsx`. Persist newly observed inbound native IDs synchronously, then invoke the stable parent callback. The callback reloads opened IDs locally; it does not refetch SMS. Scope new state to the current viewer and do not adopt unscoped legacy data as another viewer's receipts. No server read receipt or outbound-message mutation is added.

## Verification seams and execution gate

Use a focused server helper such as `portal-inbox-read-state.server.ts` for fingerprinting/conditional acknowledgement, called by the existing route. Luna can own new focused read-action tests while Terra owns route/store/pane integration. Existing tests to retain: `sms-inbox-notice-concurrency`, `manager-sms-panel-opened-loop`, `unified-inbox-person-merge`, `portal-inbox-thread-scope`, `inbox-thread-omnichannel`, and PRP-470 initial-readiness tests.

Required added cases:

- Two or more raw email sources, including the canonical root alias, contribute to one displayed conversation. All observed non-trash sources become read; a newly created third same-person row does not.
- An append before the request is rejected as changed. An append between read and conditional update causes zero matches. Explicitly force that append to retain the same `updated_at`: exact JSONB equality must still protect the new content and unread state. Test concurrent draft and archive edits the same way.
- A read commits before an inbound writer: the later inbound write retains its new message and unread=true. This ticket does not claim to repair pre-existing races between two independent blind message writers.
- Real POST RPC integration and grant checks described above, including the 50/150-message regression against the confirmed URL-size failure. Missing migration or RPC permission/schema-cache failures cannot report success or fall back to URL equality/direct upsert. All checks and any authorized migration apply target dev/test only.
- Denied scope, missing/wrong-owner ID, mixed authorized/unauthorized batch, admin effective viewer, and edit-vs-read-only co-manager. No response reveals an unauthorized source's state.
- Native `residentEmail: null` plus an exact selected key displays and marks the intended inbound SMS. Same phone/different owner or role, unresolved explicit key, and ambiguous email fallback do not display or acknowledge unrelated messages.
- Source metadata survives server and client collapse, never persists in durable JSON, and stale historical source IDs are not trusted. Old cached rows wait for normal GET observations.
- Root and appended attachments stay with their bodies. Optimistic failure after a newer sync leaves the newer snapshot intact; viewer A -> B -> A cannot publish A's old request. Visibility/new-arrival behavior, unread-list selection stability, and no render/refetch loop.

The revised plan retains exact CAS and normal history capacity through one service-role-only RPC. Root's real probe invalidated the previous URL-based proposal; no unsupported no-schema fallback remains in this plan. This planning subtask modified no source code, migration, git state, database, browser, server, Linear item, or production resource. The only artifact written is this addendum.
# Root migration-path feasibility addendum

Root verified the dev-only CLI path while PRP-470 correction 1 executed. Installed global Supabase 2.12.1 failed migration-list authentication, including with the configured local password. Temporary `npx --yes supabase@2.117.0 migration list --linked` succeeded using its managed login role; no global installation changed and no credential was printed. Pool6 is linked to exact dev project `emstjswhotsnyksqhqyf`.

The repository and remote version histories differ, so do not use blanket `--include-all`, repair remote history, or apply unrelated repository migrations. A private, non-git CLI directory was created by `mkdtemp`, mode 0700. Its path is stored in `/private/tmp/axis-inbox-cycle/prp472-migration-workdir.txt`; current value is `/var/folders/n7/whxw24l127j04lh_4lpgxsn80000gn/T/prp472-dev-migrations-j0D7rl`. It contains the copied Supabase config and the actual 175 migration files fetched from the dev ledger using `supabase migration fetch --project-ref emstjswhotsnyksqhqyf --workdir <directory>`. These are a private remote-history snapshot, not new repository migrations or proposed history repairs. New CLI `link --project-ref emstjswhotsnyksqhqyf --workdir <directory>` supplied the IPv4 pooler configuration.

Baseline validation used the repository script through the temporary CLI package:

```text
npx --yes --package=supabase@2.117.0 -- npm run db:push -- --workdir <directory> --dry-run
```

With `PGSSLMODE=require`, it exited 0 and returned `upToDate:true`, `dryRun:true`, and empty migrations/seeds/roles. This proves the isolated baseline would apply nothing. No DDL or data mutation was performed by these CLI checks.

For PRP-472, author the one additive RPC migration in the keeper, review it, copy only that exact file into the private history directory, compare its SHA-256 with the repository source, and repeat this dry run. Proceed to the repository `db:push` apply only if the plan names exactly that one migration and no seed/role operation. Recheck the exact dev project binding before applying. A changed remote history or extra pending migration must stop the apply for investigation. Verify RPC grants and the long-history/concurrency behavior afterwards. Retain a concise ledger/source hash and command outcome in the handoff, never commit the fetched private history, and remove this small temporary CLI directory when the bounded migration/probes finish. This is not a git worktree and contains no node_modules or Next build cache.
