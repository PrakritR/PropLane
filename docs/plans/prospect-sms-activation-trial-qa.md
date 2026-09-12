# Prospect SMS activation trial: operational QA

2026-09-12. Root operated against the staging database `xwszcafaontidfgznlxd` and Vercel Preview branch `staging`. No production database mutations or customer SMS were performed.

## Proven behavior

- Real staging ingress RPC: two rapid messages coalesced into one burst; the second message incremented its revision; retrying its source message ID did not increment the revision or insert again.
- A claim before the 20-second quiet period was refused. The isolated QA burst was then marked suppressed, so subsequent callbacks could not run the agent or send SMS.
- Real QStash reproduced two errors in the deployed publisher: encoding the complete destination URL caused an invalid-scheme response; colon-containing deduplication IDs were rejected.
- Corrected publication accepted two revisions with a 20-second delay. Repeating each publication reused its message ID. Both jobs were delivered to staging with HTTP 200 after the delay, verified using QStash `/v2/logs`.
- The actual modified `enqueueProspectSmsBurst` helper was then run twice against the same existing suppressed staging fixture. Both calls returned success and duplicate=true, preserved the revision, and reused one QStash message ID. That job also reached the staging callback with HTTP 200.
- Missing signature returned 401; a valid signature with the wrong URL subject returned 401; the correct signature and callback URL returned 200. Verification was not weakened.

Staging's initial signature rejection was resolved by copying the coherent local QStash URL/token/current/next key set into branch-scoped Preview variables and redeploying. The current and next local keys were compared in memory with the authenticated QStash keys endpoint and matched. No secret values appear in this report.

## GPT readiness and limitations

The available local OpenAI key was tested with a minimal `gpt-5.4-mini` Responses request. It returned HTTP 429, `credit_balance_exhausted`. This proves the local key is not ready for a live comparison; it does not establish the billing state of any different Vercel key. Langfuse project authentication returned HTTP 200.

No real GPT comparison completed, and no shadow trial was enabled. The implementation adds an absolute UTC expiration setting, `AXIS_PROSPECT_GPT_SHADOW_UNTIL`, so a proposed 24-hour trial can stop making model calls automatically. Only read-tool schemas and recorded read evidence are supplied. GPT cannot send a second text or execute a write tool.

The signed queue delivery test used a suppressed fixture. It proves real scheduling, deduplication, and callback authentication, not a complete customer-facing generated reply or Twilio delivery. A user-designated test phone number is still pending.

## Release constraints

New source is based on already-deployed upstream `01c6af066`, merged into keeper HEAD `b251d49f73c76f56804e14de956aea8ac66f7d5f`. Both staging and production migration ledgers lack `20260912120000_payment_preferences_promo_coverage` and `20260912201050_manager_plan_addons`. The latter would activate billing paths with unresolved High findings. See [the bounded upstream review](prospect-sms-upstream-migrations-review.md). Do not apply those unrelated migrations blindly or bypass migration parity to promote SMS code.

Production batching and GPT flags were not enabled. Staging batching was enabled only for controlled callback QA and restored to 0 pending deployment of the reviewed publisher fix. Verified signing credentials remain installed.

Private operational scripts, logs, and isolated fixture identities are stored outside the repository under `/private/tmp/proplane-sms-trial`; the directory contains credentials and must not be committed or printed wholesale.

## Final verification log

- Staging restoration deployment `dpl_3Ux38t5E2yVjjNzoUfQZVDeuppeh` reached READY on upstream source `01c6af066`; both staging custom aliases point to it. A callback probe returned 503 `durable_bursts_disabled`, confirming the temporary QA flag is off.
- Full repository lint exited 0, with 722 warnings and no errors. Scoped changed-file lint was clean.
- `npm run ship:preflight` exited 0 with warnings because the shell had no exported credentials/database URL. That summary is not proof of remote migration parity or production environment health. The separately authenticated read-only ledger check found the two missing migrations documented above, so promotion remains blocked.

- Final frozen full suite: `PATH=/Users/akhilvemuri/.nvm/versions/node/v22.23.0/bin:$PATH NODE_OPTIONS=--max-old-space-size=4096 npm run test:unit -- --maxWorkers=3` exited 0: 1,417 files and 9,981 tests passed in 212.05 seconds. Earlier failures are retained in the private logs and correction handoffs; this final run includes both corrections with no concurrent source edits.
- Final independent acceptance: [acceptance review](../security/2026-09-12-prospect-sms-trial-acceptance-review.md), 49 focused tests passed, code accepted, existing Low expiry-bookkeeping finding remains nonblocking.
- Read-only recheck immediately before handoff confirmed both missing migration names remain absent on both staging and production. Remote main/staging/production source remains `01c6af066`.
- No local Next build or browser/Twilio delivery test was claimed for this server-only patch. The patch is reviewed and unit/type/lint validated; it has not been promoted.
