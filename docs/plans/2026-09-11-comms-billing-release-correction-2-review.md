# Fresh Astra correction-2 review

Decision: **approve the bounded final correction for root's remaining release gates.** No remaining finding in this correction scope. This is not approval to apply, deploy, promote, or enable billing. The actual production waiver remains DRAFT. No third correction cycle is opened.

Reviewed on September 11, 2026 in `/Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/3/AXIS-2`, with explicit workdir for every shell command. Independently read HEAD as `97815a2d459c0bf96e9e80d4f94d29bff7d23fe2`; the existing no-commit merge remains root-owned. Read the complete feature-cycle skill, repository/Akhil instructions, original release plan/review/handoff/root evidence, both correction plans, correction-1 review/handoff, and correction-2 handoff. Review is limited to the five named test/CI files and protected-identity readbacks. No runtime edits, Git mutations, credentials, remote database/provider operations, deployments, waiver changes, or heavy competing checks occurred. Only this review artifact was written.

## Findings closed

- **Post-interior timeout/disconnect proof:** `scripts/testing/comms-billing-migration-apply-local-harness.mjs:113` separates attempts from successful completion; completion increments only after the real `super.query` returns. At line 120 the auxiliary-insert boundary requires one completed interior before injecting real PostgreSQL statement timeout or backend termination. Lines 155-162 require two runner connections, one attempt, one completion, one injection, and no COMMIT. Fresh independent readback follows, with clean ledger/object/column assertions. Disconnect remains conservatively uncertain despite clean readback. Auxiliary/catalog rollback, real installed-catalog negative mutations, confirmed commit, lost-response uncertainty and no replay, and TLS rejection remain intact.
- **Local tools and CI:** harness line 17 fails before cluster creation with a sanitized, actionable missing-tool diagnostic, and its wrapper tests that refusal while retaining the unconditional real harness. Line 57 places Unix sockets in the private fixture directory, avoiding dependence on the system socket directory. `.github/workflows/test.yml:16-34` explicitly uses Ubuntu 24.04, provisions PostgreSQL 16 server/client and OpenSSL, exports the PostgreSQL server binary path, prints tool versions, and runs the existing mandatory unit command. `check.needs` at line 198 still requires unit, lint, and build. The handoff documents local prerequisites. Actual Ubuntu/PostgreSQL 16 execution remains unobserved and is not inferred from macOS PostgreSQL 17.11 success.
- **Specific drift refusal:** `tests/unit/comms-billing-migration-apply-subprocess.test.ts:178,185` now requires the intended source-integrity and bundle-digest diagnostics, exit 1, and absence of fake CLI invocation. Copied waiver, pinned CLI/environment isolation, private modes, cleanup, CA refusal and output-sanitization coverage remain. The real waiver is untouched.
- **Seeded browser regression:** `tests/e2e/communication-reply-composer.spec.ts:4-31` retains assistant/banner normal-click coverage at 375/768/1280 and asserts scheduling absent. Lines 40-102 open Test Resident, use the observed `resident-direct-chat-compose` textarea and scoped form controls, and exercise focus/typing, emoji insertion, file chooser without selecting a file, enabled Send without submission, schedule date/uncheck, and cleared message draft at all three widths. Root reports actual execution of this exact spec, not merely collection. No product scheduling or analytics change was introduced to satisfy the fixture.

## Evidence and identity checks

Independent read-only checks all exited 0: HEAD readback, `git diff --check`, SHA-256 readbacks, and Node 22.23.0 execution of the preparation-only manifest entrypoint. The latter rebuilt the exact six-source bundle without credentials or database access: **67,040 bytes**, `c8013155b6cb51792950177cd47b348d51d7ce24df7869a5892ec74bb29541ff`. All six working migration-source hashes match the manifest and waiver.

Independently matched correction-2 handoff identities:

- Fixed runner: `56e88313a0da9b14ef04e4d146392782a79085e80ff04266149e8a6f9be09cc6`.
- Preparation runner: `cff0016ba1799b75ddb295b83c66f921c56857e5e7d0f675adcd9c73fd91787b`.
- Canonical correction: `229e0699bc0e4685dc8ba2f6380ef9d2358816a1d72415abe7d4adb7a9c49713`.
- CA: `700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7`.
- Actual waiver: `9b8f208c2e994c5a484c12f87879b6426348cdb9f34e64d0139279f3c4a78e10`, still exactly `DRAFT - NOT APPROVED, NOT APPLY-CAPABLE, NOT CONSUMED`, recording the fixed runner above.
- Harness: `53177386606421bdcf19fdfa4ef811b50d7735eb3f7b67349383d1908d2d7137`.
- Wrapper: `43511b2df87faa9cf2af85028ae0116ef237942e75a4a8ff37ae51857cf5f09c`.
- Subprocess test: `8406e073f890146aca0ff8f8c6f0d6d8ccb1a6867cb0d1e2859aa2fa423b9c08`.
- Browser spec: `71b4643a1bdd81ff5a7b5aca6ed19cb667249eb38ad2b7124720116fb3fd831b`.
- Workflow: `987b17e946da7ca0468ba297e6aa6547c2d1332533c1de6c78c2c38f70ef54f3`.

The consumed recovery runner independently matches its final approval digest `178540a6f319c01e2c61696ec99d617189871f6c584c87643974d776c1c8e624`. Its runner, original rehearsal and SQL prerequisite fixture have no diff against HEAD. Rehearsal hash is `cc849202715f2b4e7a7c5ce538bc8c324ed775fb72c8b6f7848ba3e19b195a72`; prerequisite fixture hash is `8dfa681b806bb5d282d9d65412342e777422a1bdfc76b1b7a3a5626e4a09059f`. No consumed apply path was executed.

Accepted as attributed execution evidence, not rerun by this reviewer: Sol's final Node 22 narrow matrix **24 tests / 3 files, exit 0, 43.30 seconds**, including the real PostgreSQL 17.11 harness; syntax/scoped lint/YAML/diff checks exit 0; root's exact browser matrix **14 passed, exit 0, 1.9 minutes** with canonical process-only QA credentials and a dev/test production-mode server. Root also completed normal Turbopack build with TypeScript and 387 static pages, standalone typecheck, and full lint with 0 errors / 719 warnings, all exit 0. The build predates this test/CI-only correction. Root's final full-unit session 97642 was running at review handoff; no final pass is claimed here. Avoiding duplicate database suites/compilers on the 8GB host preserves root's stable validation run.

## Remaining release gates

Root must finish and record the final full-unit result, observe the changed mandatory Ubuntu/PostgreSQL 16 unit job in hosted CI, and explicitly disposition the full-E2E nightly failures. Root's final update reports failure markers in the still-running full-unit session, with exact cases not yet summarized. That gate is unresolved and is not green; inspect and report the final failures before any commit or promotion. This is the final automatic correction cycle, so remaining findings must be reported to Akhil without opening a third correction plan or execution. The 14-case browser pass does not replace full E2E or feature staging QA. Review URL: `http://localhost:3008/portal/communication/active`, local dev/test only.

Keeper landing, exact-SHA staging deployment with staging-scoped credentials, reviewed one-shot staging apply/readback, full billing/tour/recovery QA, designated test-handset receipt/STOP/START/reply acceptance, and current/rollback invoicer cutover proof remain. Then require ship preflight, fresh bounded production preflight, Akhil's explicit approval of named waiver `2026-09-11-production-comms-billing` for the unchanged fixed runner, one-shot production apply plus independent readback, staging-to-production promotion, and Vercel/TestFlight distribution verification. Never retry an uncertain apply. This correction approval does not supply any of those missing gates or authorize their bypass.
