# Action pinning and telemetry privacy review — 2026-09-05

## Changes completed in the security worktree

All 31 executable external GitHub Action references in six workflows now use full commit SHAs. Each SHA was resolved read-only from the official upstream repository using `git ls-remote`; the pinned commit is exactly where the existing major reference resolved at verification time. No alternate release or new major version was selected. CodeQL uses the peeled commit of its annotated tag; Ruby's `v1` is a branch, matched to its release tag.

| Original action ref | Verified commit | Corresponding release | References |
| --- | --- | --- | ---: |
| `actions/checkout@v4` | `11d5960a326750d5838078e36cf38b85af677262` | v4.4.0 | 14 |
| `actions/setup-node@v4` | `49933ea5288caeca8642d1e84afbd3f7d6820020` | v4.4.0 | 12 |
| `actions/upload-artifact@v4` | `ea165f8d65b6e75b540449e92b4886f43607fa02` | v4.6.2 | 2 |
| `github/codeql-action/{init,analyze}@v4` | `cdf488f595d80d6e07e03d4674febd5ab45fa938` | v4.37.9 | 2 |
| `ruby/setup-ruby@v1` | `95ef2b042f9d7a56d8268cba8559e2842e2ad01b` | v1.321.0 | 1 |

`.github/dependabot.yml` adds weekly GitHub Actions update proposals targeting `main`, with at most five open update PRs. It does not automatically merge or deploy updates. Same-line release comments let Dependabot track the pins. GitHub documents [full-SHA pinning](https://docs.github.com/en/actions/reference/security/secure-use), [SHA/comment updates](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories), and [the root directory requirement for GitHub Actions](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference).

Validation: parsed all six workflow YAML files and the new Dependabot config; verified exactly 31 external action references, all full 40-character lowercase hexadecimal SHAs; `git diff --check -- .github` passed. No workflow ran, dependency package was installed, commit was made, or deployment was initiated by this task.

## Read-only telemetry findings

The following are source-level findings, not a check of live PostHog/Langfuse settings. No production telemetry or customer content was fetched. `docs/observability.md` requires replayable full prompts, tools, arguments, results and attribution; this review deliberately did not change that contract or silently remove trace data.

| Priority | Evidence | Gap and next action |
| --- | --- | --- |
| High | `src/lib/observability/langfuse.ts:178,192,209,215`; `src/lib/agent/loop.ts:173,199`; `src/lib/agent/images.ts:69,99` | Langfuse receives the full assembled system prompt, model messages, outputs, and uncapped tool arguments/results without a central privacy transform. Model inputs can contain base64 image/PDF attachments. Establish a field policy that always removes credentials/tokens and highly sensitive identifiers, and replaces attachments with access-controlled replay references plus hashes. Preserve the required replay evidence in an appropriately restricted encrypted store; coordinate this architecture before reducing trace inputs. |
| High | `src/lib/observability/langfuse.ts:581,605,611`; `src/lib/observability/langfuse-otel.server.ts:17`; `scripts/langfuse-setup-improvement-loop.mjs:183` | Successful tool evidence is copied into both legacy and OTEL grounding summaries; configured evaluator sampling is 100%. Sensitive record text can therefore be duplicated and submitted to the judge model. Define a grounding-specific projection that preserves factual numbers/statuses/tool provenance but excludes unrelated private free text; confirm processor and judge access, region and retention. |
| High | `scripts/langfuse-sync-eval-dataset.mjs:121` | Denied-proposal dataset items copy full generation input, user input, and rejected previews with no scrubbing or expiry handling in the sync path. Create sanitized, representative eval fixtures or tightly restricted replay references. Set dataset retention separately from trace retention and ensure deletion requests reach derived dataset items. |
| High | `src/lib/agent/chat-history.ts:181,203,215`; `supabase/migrations/20260625000000_agent_observability.sql:34`; `scripts/lib/account-deletion.mjs:69` | Deleting a portal conversation cancels proposals and deletes the DB session/messages, but this path does not delete Langfuse traces or eval copies. Pending rows are denied, not purged. The inspected account-deletion paths also have no external telemetry erasure. Define a deletion/retention job spanning DB transcripts, pending payloads, Langfuse traces, derived datasets and analytics, preserving only documented audit/legal records. |
| Medium | `instrumentation-client.ts:3`; `scripts/posthog-verify-setup.mjs:17,52`; `docs/observability.md:41` | Browser instrumentation does not explicitly configure replay text/input masking, sensitive-area blocking, URL/query filtering or exception scrubbing. The project verifier checks replay enabled, not masking or retention. The docs mention 30-day replay retention; the live value was not verified. Audit actual project settings and captured synthetic sessions, then enforce masking for resident/lease/inbox/financial surfaces and verify sensitive URLs/errors cannot leak. This is an unverified configuration gap, not proof that SDK defaults currently expose inputs. |
| Medium | `src/lib/agent/sessions.ts:142`; `src/lib/tools/pending-actions.ts:174`; `src/lib/observability/langfuse.ts:45`; `src/lib/observability/langfuse-otel.server.ts:17` | Transcript content is stored directly (with a 20,000-character cap), and pending-action TTL prevents execution but does not erase stored payloads. No trace/transcript/dataset retention policy or purge implementation was found in the inspected source. Agree retention durations and implement monitored expiry jobs; confirm live provider settings and staff access separately. |

Useful existing controls: traces preserve user/session/landlord attribution and prompt identity; SDKs refuse initialization in test mode; portal transcript reads/deletes re-derive ownership; named product events are intended to carry IDs/enums only. These controls do not by themselves minimize trace content or establish live retention/access settings.

The worktree remains uncommitted. The parent security plan owns implementation decisions for telemetry minimization and production verification.
