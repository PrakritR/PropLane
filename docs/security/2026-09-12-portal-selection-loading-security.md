# Portal reliability security review — September 12, 2026

Reviewer: mandatory `security_review` subagent. This report covers the uncommitted implementation, including new files, on the keeper while the parent integrates captain updates. The initial read used HEAD `6eb6dff76415c92f816939614644b3c68a7b34b5`; the re-review used HEAD `1164c1d47e1d5d3a0f2a901570006683dba833d4` plus the working changes identified below.

## Scope and findings

Reviewed house-assignment authentication and owner/property authorization; strict database reads; tag replacement atomicity and grant revocation; tour source eligibility, opt-in timing, send deduplication, cancellation/edit races, provider delivery reporting, archive persistence and account deletion; shared single-record action menus and vendor invitation submission. The reviewer performed no hosted sends, database writes, seeds, commits or pushes during this pass.

### Findings resolved during the final pass

- **High, pre-existing dependency — foreign vendor write authorization trusted an unrelated property.** `src/app/api/portal-vendors/route.ts` formerly accepted `body.row.propertyId` without binding it to the stored vendor owner. A manager could submit their own property id with another manager's vendor id and modify that vendor. Owner lookup errors were also ignored. After the parent delegated this route, the reviewer replaced this gate with strict owner-bound services edit grants plus a current property-owner lookup. Client property/owner fields provide no authority. Existing ownerless records fail closed, existing records update under id plus stored-owner conditions, and new records insert rather than upsert; a concurrent transfer/insert returns conflict. Administrators preserve stored owners too. Canonical category ids are checked before authorization, and all replacement rows are authorized before any write. Regression tests reproduce the original exploit and cover valid co-manager/owner edits, cross-owner grants, transferred properties, read failures, ownerless rows, insert/update races and roles.
- **Medium — retry rotated an invitation that may already have been delivered.** The form formerly prepared a new token on every retry, invalidating the token in an email whose HTTP response was lost. The parent now retains the prepared invitation for the same vendor, email and name. Transport failures, server failures and malformed successful responses propagate an uncertain result; the form says to check Communication and labels a repeated explicit action “Send again.” There is still no claim of external-email exactly-once delivery. Re-review verified the retry reuses its credential.
- **Medium — in-flight vendor submission could outlive its form.** The parent guarded Close, Browse catalog and Create invite link while submitting and added generation checks around async persistence, draft preparation and delivery. Changed identity/form generations cannot close or update a newer form. The local directory is updated only after accepted server persistence, without issuing the old duplicate whole-directory mirror.

### Resolved during earlier security passes

- **High — house access was owner-wide rather than property-specific.** The allowed house list now uses owner-bound `propertyIdsByOwner` and current stored ownership. A grant for owner A cannot authorize owner B's house. Untagged workspace-wide conversations require full workspace edit scope for a co-manager. Existing persisted tags are loaded without the inbox display fallback or capped snapshot; partial access cannot strip inaccessible tags.
- **High — destructive tag replacement could race or partially clear tags.** The service-only `replace_conversation_houses` RPC compares exact persisted tags and an access revision while holding the relevant locks, validates current ownership, and replaces all member-key tags transactionally. The earlier SQL correlated-subquery alias defect was fixed and covered by real SQL tests. Invalid JSON, non-string and blank property ids fail before mutation.
- **High — follow-up cancellation/edit could race provider submission or rewrite delivery history.** Cancellation and the no-retry submission transition share a workspace advisory lock and reminder/outbox row locks. Explicit edits/cancels return conflict after dispatch starts; archiving preserves sent history. A successful pending cancellation blocks the outbox and cancels the reminder atomically. Delivery labels come from the outbox; reminder `sent` means enqueued and is never itself claimed to be delivered.
- **High — delayed reminder materialization could become retroactive.** The server-owned enable timestamp rejects responses sent before activation. A disabled/re-enabled setting cannot opt old responses back in. Accepted response projection repair uses the existing log-repair path without repeating provider delivery.
- **High — stale follow-ups could survive activity or revoked grants.** The server checks the exact latest inbound, accepted response identity, current owner-bound actor property permission, requests/bookings, applications and durable archive barrier. It checks existing SMS consent and automated quiet hours. A final policy read after billing/credit awaits runs immediately before provider submission. The outbox identity binds stored owner, actor, phone, conversation, property and message body.
- **Medium — phone-only prospects and cancellation bookkeeping diverged from existing queues.** The existing queue now supports a validated phone for this reminder kind without a fake email; the lead constraint permits its one after-response timing. The new controls table is service-only and classified in both account purge manifests/plans. Async archive/restore updates browser state only after server success.

## Single-record menu review

The shared menu clears selection synchronously before activating its record, then renders the existing action handlers and their disabled state. Successive menus therefore operate on one record rather than accumulating hidden selections. Workspace/viewer changes clear selection and close menus; removing a row unmounts its menu. Menu placement does not grant authorization: existing server routes remain the mutation boundary. Current behavioral tests cover successive actions, disabled rows, record removal and workspace changes. Custom-row navigation propagation was also flagged to bugbot for regression coverage; the common row guard already excludes input elements.

## Validation evidence

Executed with no real provider/model calls:

```text
npx vitest run tests/unit/sms-conversation-house-access.test.ts tests/unit/sms-conversation-house-assignment-sql.test.ts tests/unit/sms-conversation-houses-route.test.ts tests/unit/tour-followup-route.test.ts tests/unit/tour-interest-reminder-sql.test.ts tests/unit/tour-interest-reminders.test.ts tests/unit/sms-conversation-log-dispatch.test.ts tests/unit/manager-sms-archive.test.ts tests/unit/account-deletion-plan.test.ts tests/unit/account-purge-coverage.test.ts tests/unit/portal-record-selection-mode.test.tsx tests/unit/vendor-form-invite-ui.test.tsx
```

Exit **0**; **12 files / 140 tests passed**, at 17:09:55 local time. Output retained locally at `/tmp/proplane-security-review-tests.log`. Migration tests execute actual SQL under PGlite, including stale revisions, rollback, provider-boundary cancellation and immutable sent history. Earlier targeted backend lint passed; this run did not repeat the parent-owned whole-branch typecheck/build/browser gates.

After the vendor fix, `npx vitest run tests/unit/portal-vendors-write-authorization.test.ts tests/unit/vendor-form-invite-ui.test.tsx` passed at 17:17:54: exit **0**, **2 files / 24 tests**, including 17 server authorization cases. Output: `/tmp/proplane-security-vendor-final-tests.log`. The new vendor route and its isolated regression suite also passed targeted ESLint (exit **0**, no diagnostics). A later combined rerun including newly added real menu-to-Modal coverage encountered a Radix/jsdom focus recursion and was terminated; this is not counted as a pass. Bugbot independently reproduced the menu-to-dialog failure and the parent owns its fix. The initial 140-test result predates that expanded UI test. This security report does not waive the separate bugbot gate.

Limits: PGlite tests exercise both serial orderings, not a multi-connection contention load test. UI delivery tests mock the provider boundary and cannot establish provider idempotency. The feature source currently covers accepted assistant tour-availability responses with durable prospect-burst facts, not arbitrary manual composer messages. Full desktop/mobile/browser and release checks remain parent-owned. The targeted security review has no known unresolved High or Critical finding after the vendor fix and re-review.

## Reviewed snapshot

SHA-256 file manifest includes untracked implementation files; the diff hash uses `git diff HEAD --` over the same paths.

```json
{
  "head": "1164c1d47e1d5d3a0f2a901570006683dba833d4",
  "tracked_diff_sha256": "899a7d693592dc8d4b59fbf28b714a14c00dc0b71fa9f6cf9f60ab4a799b4e87",
  "files": {
    "src/app/api/portal-vendors/route.ts": "841567c96cd122ea2dcce254a3ef1013efd0544489037b74ce11f018dc80036d",
    "src/components/portal/pro-vendor-form-modal.tsx": "fe5bb58e5a120f7a705eebf22b020a4db9e28cc3b3c87429ecbdab1075b5d84d",
    "src/lib/manager-vendor-invite-client.ts": "0d582eb8af4de3fb219a6a6b15415c1a74e305155dc85a32b485bba234ead52f",
    "src/lib/portal-message-delivery.ts": "fc422076527d112e66aeb9b807fa9caa67557c77ac4ee1839f436f946eac4636",
    "src/lib/manager-vendors-storage.ts": "5a24e1fde2e28d80cebbce594c3dd8bbc19837b1a77d56092170fd29092abd6d",
    "src/components/ui/record-action-menu.tsx": "b86c3f65ff6ea397b099236db9c13951e116230a51f46d07662fe07f3d5293f7",
    "src/components/ui/row-select-checkbox.tsx": "747e448b1f57ce93f6a323d40ed96640f34300ad21d60d7f5422babc6021cd3e",
    "src/components/portal/portal-record-list-surface.tsx": "e3db5aaa654b2191391fe7a0e243fcfe2fb893505fd9e1ab5d019a9e4adb7eec",
    "src/app/api/manager/sms-conversations/houses/route.ts": "54021b0cbcd2cecf657d999c963dc8b2ee2e17b88b4ecd56dfada3b58c45030b",
    "src/app/api/manager/tour-follow-ups/route.ts": "678ada0f9e2e0c5f5c2481fc0ad108e1cee84ce819f6e041ae4dfe6979a00b25",
    "src/lib/sms/conversation-house-access.server.ts": "742eb0dcfd1deabdba232f84f1cd641c150bf0a768c6649e1a8ece93ccf4bea9",
    "src/lib/sms/conversation-houses.server.ts": "36ea8eb6fadfe7c209469993a153fc3aec79ffa690a473048624278eda69b380",
    "src/lib/auth/co-manager-module-scope.ts": "bf1ee5869c627cab9be947b554767dccc4a8da04ba0e4e2aef325940e6eee736",
    "src/lib/reminders/tour-interest.ts": "3c4b6c025a47e7d5eeb5a53f639007f83d5578dd61aff6cc8adc3488867d3fe2",
    "src/lib/reminders/subjects/tour-interest.server.ts": "2c3519f979885ded94efaddbd1525ac936fa2ed7c4a3ad91d525c5fb154e2693",
    "src/lib/sms/owner-sms-dispatcher.server.ts": "b2f9c4b0307a6d0d88170591952e99576f2043efec72f08f0ed6cdbb75af710d",
    "supabase/migrations/20260912210000_atomic_conversation_house_assignment.sql": "cdc12b5d8af2d286742e7053d78cd5be0e6a22a2cbc606b2df53ef9b82e3d08f",
    "supabase/migrations/20260912220000_tour_interest_reminders.sql": "5937d23cca3c921128409e7ec7b0e649f11c69b40f7c2898fc575e100b3a0f34",
    "tests/unit/portal-vendors-write-authorization.test.ts": "60ebe2233aa646323d8d1e5b97a7cc302a97ba417e3a212f3e624d3e2f47fe3d"
  }
}
```
