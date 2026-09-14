# PRP-470 / PRP-472 release inventory

User authorized another correction and movement toward production after the prior two-cycle handoff. Root resumed the same feature cycle; a transient Sol capacity error was retried with the same manager/model and existing Terra/Luna delegates, without model substitution.

## Pinned Git candidate

Read-only remote inspection and fetch found main, staging and production all at `75d711053085e340072c605bcb96eaa9416ef87e`. Compared with the keeper's prior pinned-main parent `203d5e58f3ad99e6a977d65b1bbdb69115c52711`, there are two upstream public-documentation commits, 11 files, no PRP470/472 source/test overlap. Integrate this pinned tip before final source validation/review. The production GitHub Vercel and iOS workflows for75d711 both completed successfully; that baseline is not evidence of the new release.

## Exact schema inventories and backups

Root used authenticated Supabase CLI2.117.0 Management API read-only queries with explicit project refs. No linked project was changed and no schema/data mutation occurred. Private directory `/private/tmp/axis-inbox-release` is mode0700. Inventory captures the real ledger version/name/statements, target function definition/ACL or absence, inbox column metadata, and service-role UPDATE privilege. No mailbox content or authentication credentials were selected.

Staging `xwszcafaontidfgznlxd`:206 recorded migrations, exact-name comparison missing only `mark_portal_inbox_source_read`; target function absent, inbox8columns, service UPDATE present. Private backup `staging-before.json` SHA256 `180ad0cf9f5c97e65669d766e257e416722059a570fa1173a6b923e0e25c3115`. Two remote-only historical names do not imply pending local migrations.

Production `qahnczmilgptcedaqype`:212 recorded migrations, target function absent, inbox8columns, service UPDATE present. Private backup `production-before.json` SHA256 `c70a76bb5dc8343986fbf45beaffb45b2b47ee74efcd3269afb1cedd3fc0a061`. Five local names are missing: the new read RPC and four older migrations below. Recorded statement search does not show those older functions/column changes under a bundled name. Separate read-only catalog query confirms genuine missing effects.

| Prior migration | Observed production state | Effect requiring separate release assessment |
| --- | --- | --- |
| `20260912210000_atomic_conversation_house_assignment.sql` | Both functions absent | Service-only atomic house assignment and access revision |
| `20260912220000_tour_interest_reminders.sql` | New functions/trigger column/control table absent; recipient_email remains NOT NULL and recipient_phone absent | Reminder table/constraints/index, automation timestamp backfill and trigger, controls table, service functions and reminder resolver replacement |
| `20260912230000_vendor_directory_private_fields.sql` | `manager_vendor_records_vendor_read` policy still exists | Removes an existing vendor SELECT policy |
| `20260912233000_atomic_inbox_folder_changes.sql` | Both functions absent | Atomic folder functions, one depending on tour-followup function |

These four gaps predate this branch's changes and are not silently covered by the authorization for the new read RPC. Do not blindly apply all pending files or repair history. Before any additional production apply, finish the concrete review, backup and staging QA and resolve the bounded scope with Akhil as required by the root production authorization invariant. Continue all independent feature work and staging preparation first.

## Release apply constraints

The reviewed new migration is `20260913170000_mark_portal_inbox_source_read.sql`, SHA256 `8a6007c229d637f3eb4d6091650ddb8c546a7f5dee353abcb157e4bd99f5bad6`; already verified on DEV. Do not modify/reapply it to DEV. Build an isolated apply directory from actual remote history and the exact reviewed pending SQL, preserve backups, verify dry-run proposes only intended files, use the repository CLI push path, then re-read catalog/ledger/grants. Staging apply must follow candidate advancement to origin/staging and source SQL must match that commit. No seed, wipe, locked listing write, generic history repair, production credential file, provider send or skip-staging path is authorized.

## Isolated staging QA preparation

Canonical dev QA credentials failed staging authentication (invalid_credentials) for manager/resident; no existing account password or role was changed. Root used the explicit staging URL/service key and the repository's fixture account shape to create two uniquely named synthetic QA accounts with confirmed local-only email addresses, own profiles/roles, random private passwords and unique manager IDs. No provider mail/SMS was sent. One owned synthetic inbox row `prp472-release-1789352747840-inbox` contains root probe one and one appended probe two, unread true. Verify exit0 confirmed exact owner, preserved body and one appended message. No listing, reminder or customer rows were touched.

Private bounded seed/verify script: `/private/tmp/axis-inbox-release/staging-qa.mjs`; credential/created-ID manifest: `staging-qa-state.json` in the same mode0700 directory, file mode0600. These files are not repository artifacts. Root also prepared a tiny isolated Supabase apply directory from206 real staging ledger rows; it links only staging, while the keeper remains linked DEV. No pending new migration has yet been copied or applied there.
