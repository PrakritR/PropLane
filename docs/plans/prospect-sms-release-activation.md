# Prospect SMS release activation status

2026-09-12. Explicit Akhil production ship request. Deployment is authorized through the normal keeper/main/staging/production ladder. Activation and code deployment are distinct and must be reported separately.

## Verified infrastructure

- Vercel project `proplane`, ID `prj_rupckw3T2v0oXVg2nTLVCYePKDUc`; local `.vercel/project.json` has the correct ID and a stale display name. Do not relink.
- Current team billing plan is Pro, verified read-only via authenticated Vercel team API. The new five-minute recovery cron is supported. Cron schedules invoke production deployments, so staging needs an explicit authenticated recovery invocation for QA.
- `vercel env ls production` and `vercel env ls preview staging` both succeeded. QStash credentials remain absent. Root configured the correct callback URL, a distinct random callback secret, PROSPECT_SMS_BURSTS_ENABLED=0, and AXIS_PROSPECT_GPT_SHADOW_ENABLED=false in both scopes. All eight additions exited 0; secrets were never printed.
- Supabase CLI lists dev/test, staging and production projects and remains linked to dev/test in the original checkout. No remote migration has been applied for this feature.
- At release start main, staging and production all point to `b6085cd66e18da232640b4bc57d05e4499eb71a3`. Existing main/staging tests and production Vercel/TestFlight workflows succeeded. These are baseline results, not new-release results.

## Activation prerequisites

### Operator setup

In Vercel project `proplane`, configure both **Production** and **Preview scoped to branch `staging`**. Copy QStash credentials from the [Upstash QStash dashboard](https://upstash.com/docs/qstash/quickstarts/vercel-nextjs), never into tracked files.

| Variable | Value |
| --- | --- |
| `QSTASH_URL` | QStash regional API origin from the dashboard, without `/v2` or `/publish` |
| `QSTASH_TOKEN` | Dashboard token for that environment |
| `QSTASH_CURRENT_SIGNING_KEY` | Dashboard current signing key |
| `QSTASH_NEXT_SIGNING_KEY` | Dashboard next signing key |
| `PROSPECT_SMS_BURST_CALLBACK_URL` | Production: `https://prop-lane.space/api/internal/prospect-sms-burst`; staging: `https://staging-prop-lane.space/api/internal/prospect-sms-burst` |
| `PROSPECT_SMS_BURST_CALLBACK_SECRET` | A newly generated random secret, distinct for each environment |
| `PROSPECT_SMS_BURSTS_ENABLED` | `0` until schema, queue delivery, recovery and controlled SMS QA pass |
| `AXIS_PROSPECT_GPT_SHADOW_ENABLED` | `false` pending scorer correction and designated keys |

Retain the existing `CRON_SECRET` and SMS runtime/outbox configuration. Ensure the staging callback is reachable by QStash; Vercel deployment protection must not intercept its authenticated callback. Secrets must be installed before redeploying the respective branch.

Akhil explicitly removed the blanket production-write restriction and authorized migration reconciliation/application on 2026-09-12. Root is executing the reviewed plan in `prospect-sms-migration-reconciliation.md`; no additional operator permission is needed. The separate locked-live-listing rule remains. The production batch is only the reviewed SMS migration (SHA-256 `d1581654a9dbff50c70d96f073de3c8cfca8c13416997dae2b1d64b4161f79ab`) and the targeted occupancy-start correction (`20260912150000`, SHA-256 `78a25930905b34d16348f7f5d28023a184a89ae0bf5a08d2f673de0048484f28`). Preserve historical bundles and reconcile verified canonical identities without replaying their data backfills.

Supply `OPENAI_API_KEY` separately for designated development and production scopes when ready. That is independent of SMS batching: keep GPT comparison disabled until the known scorer defect is corrected and approved. A controlled SMS recipient is also needed for actual delivery QA; none has been designated yet.

Keep `AXIS_PROSPECT_GPT_SHADOW_ENABLED` unset or false. Known FINAL-1/P2 scoring remains unresolved and designated development/production OpenAI keys were not supplied. No live model comparison is authorized by the presence of inherited credentials.

Keep `PROSPECT_SMS_BURSTS_ENABLED` unset or 0 until the feature migration and queue are ready. In that state newly received Twilio messages follow the legacy synchronous path; do not claim the new batching is active. A disabled recovery endpoint can return503 and is not evidence of queuehealth.

The remaining external setup is QStash URL, token, current signing key and next signing key for each environment. Callback configuration is already installed. No account credentials or designated test recipient have been supplied yet.

Before enabling batching, staging must verify real signed queue delivery, duplicateSID handling, correction fencing, one durable outbox intent, recovery after publication failure, and controlled recipient delivery/unknown handling. Existing hermetic tests and isolated SQL probes do not prove a configured external queue. Existing SMS runtime, outbox scheduler, consent and work-number ownership gates remain required.

## Baseline schema metadata readback

Supabase's [dedicated read-only query endpoint](https://supabase.com/docs/reference/api/v1-read-only-query) returned HTTP201 for staging and production. Both contain `reserve_comms_credit`, `finish_comms_credit`, and `spend_sms_outbox_segment_budget`. Neither contains `prospect_sms_bursts` or the new ingress/prepare/submission RPCs. This checks catalog metadata only, with no customer rows or write-capable query endpoint. Artifact: `/tmp/prospect-sms-release-schema-status.json`. An initial attempt before decoding the CLI keyring wrapper returned401; the corrected credential handling succeeded, without exposing secrets.

## Baseline deployment identity readback

Authenticated Vercel deployment API confirms staging alias READY deployment `dpl_DTztofmQ7hYWEW19p8wg5ED51nAz` and production alias READY deployment `dpl_B8rqHrCLg31dD6cVvDZG2qgE3wDD` both serve SHA `b6085cd66e18da232640b4bc57d05e4499eb71a3` from their respective staging/production branches. This independently verifies baseline code identity beyond the green GitHub deployment notice. Neither alias contains this unreleased SMS work yet.
