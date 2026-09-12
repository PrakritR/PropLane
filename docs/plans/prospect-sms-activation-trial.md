# QStash batching activation and bounded silent GPT trial

2026-09-12. Akhil requested verified batching with newly configured QStash and a temporary silent GPT comparison run. Prior ship authorization persists. No customer/test SMS recipient has yet been designated; root asked asynchronously. Default proposed trial is 24 hours, pending preference.

Implementation checkout: pooled tree 5, branch prospect-sms-release. Starting integration includes origin/main 01c6af066 and keeper b427e92f7; root records actual merge SHA in handoff prompt.

## Concrete scope

1. Fix FINAL-1 in docs/security/2026-09-12-prospect-sms-bugbot-final-review.md. Reproduce using actual typed projection: Jain Home rent $1,200, address 12 Cedar Street; swapped claims must never score grounded. Replace token-bag affirmative logic with conservative full assertion matching tied to one property's evidence. Unprovable paraphrases must be unknown, never optimistic. Preserve provable exact supported assertions and negative unsupported numeric evidence when sound. Add runtime-projection regressions for swapped values, substring amounts, cross-property facts, negation and added assertions. Do not use primary prose as truth or add model judging.
2. Add server-only AXIS_PROSPECT_GPT_SHADOW_UNTIL (absolute ISO UTC deadline) to the shared shadow-enabled decision. Invalid/expired deadline disables all shadow entrypoints; a configured future deadline permits enabled=true. Preserve existing unset-deadline compatibility if necessary for callers but production rollout will explicitly set a deadline. Test expiry boundary, invalid value, disabled flag, and that no provider call occurs when expired. Root handles actual Vercel configuration, limited duration (24h unless user chooses), model and release.
3. Confirm shadow remains hermetic, same frozen pre-turn context and exact replayed read-tool evidence only, no SMS or write handlers. Existing two-per-drain/concurrency/time/output limits remain; no migration, UI, model migration, or unrelated feature edits.
4. Document activation configuration and tests in a new execution handoff. Do not rewrite historical review results. Do not commit or push: root owns integration and release.

## Ownership and validation

Sol-medium manages Terra implementation of scorer/expiry plus behavioral tests and Luna independent read-only review/test assessment. Avoid overlapping file writers. Read AGENTS.md, matching Akhil developer instructions, docs/ai-assistant.md. Original checkout has docs/agents/akhil-feature-cycle.md if pooled copy lacks it. Root operates credentials, real QStash/staging QA in parallel.

Run focused comparison/provider/shadow-recovery/runtime-boundary suites, scoped lint, typecheck. Retain true exit codes and exact changes. Reproduce the defect before fixing. Fresh Astra review follows before production. No no-mistakes, no secret output, no customer sends, no production database writes by agents. Root runs broader ship requirements.

## Operational acceptance owned by root

Read-only verify QStash token and matching signing keys; Vercel scope correctness; OpenAI model credential readiness. Stage latest reviewed code and enable staging batching. Send real QStash jobs for isolated staging fixture bursts; validate signature, quiet window, duplicate/revision fencing, recovery and one outbox intent without customer sends. Actual SMS delivery requires the designated recipient. Confirm Langfuse comparison trace persistence with new keys/config, ensure GPT never changes primary answer. After QA, normal keeper-main-staging-production ladder and verified deployment. Enable bounded production shadow only with deadline and batching prerequisites, monitor initial outcomes and report precise limitations.

## Live integration findings added by root

Real QStash API calls with the configured valid token on 2026-09-12 found two independent 400 rejections in the current publisher: URL-encoding the whole callback yields invalid destination scheme, and colon-delimited deduplication IDs are forbidden. Extend implementation to preserve/validate the raw HTTPS destination and use a deterministic allowed-character digest/key for logical ingress attempts, distinct for recovery attempts. Regression-test actual fetch URL/headers and repeated-ingress versus fresh-recovery semantics. Root's corrected raw-URL/hyphen-key probe received201 and repeated requests returned deduplicated=true with the same messageId. Signed destination delivery is separately verified after delay. These fixes are activation blockers and require fresh review with scorer/expiry.

New external blocker: the dev key in original .env returned OpenAI429 credit_balance_exhausted. Langfuse auth200 and QStash keyread200 with both signingkeys equal. User notified asynchronously for API credits and authorized testrecipient; still pending.

Upstream source 01c6af066 (already deployed by another session) includes two migration names missing from both remote ledgers: payment_preferences_promo_coverage and manager_plan_addons. No agent may silently apply these unrelated migrations under this task; root must resolve releasegate with scoped review/authorization if still missing before shipping new code.
