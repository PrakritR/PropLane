# Static security analysis — 2026-09-05

This was a local, tooling-based review using the installed **Trail of Bits static-analysis workflow and public Semgrep rules**, not a paid Trail of Bits audit, certification, penetration test, or proof that the application is secure. No production endpoints, customer records, environment files, or customer documents were scanned.

## Result and remediation

The merged, deduplicated original-snapshot report contains **130 scanner alerts**, all SARIF level `warning`. Scanner levels are not risk assessments. Manual triage found four actionable issue groups, now patched in the isolated security worktree, plus outstanding GitHub Actions supply-chain hardening. The full scan used a snapshot taken before those later remediation patches; a separate targeted rescan checked the patches.

| Issue | Evidence in original snapshot | Assessment and resulting change |
| --- | --- | --- |
| Database TLS verification disabled | `src/lib/supabase/postgres-connection.ts:34` | Confirmed high-priority transport weakness in the admin schema-apply path. Connections now verify certificates, optionally use an explicitly configured CA, reject unencrypted mode, and reject connection-string SSL parameters that could override verification. Production CA/connection configuration still needs deployment validation. |
| Workflow input inserted into shell source | `.github/workflows/promote.yml:52`; `.github/workflows/vercel-deploy.yml:57,81,89` | Confirmed unsafe interpolation, requiring workflow-dispatch access. Promotion source is free-form; Vercel push branches are constrained but manual dispatch can select another ref. Inputs/ref/token now reach shell commands through quoted environment variables. |
| Unsanitized lease disclosure HTML | `src/components/portal/property-lease-document-notice.tsx:36`, via `src/lib/property-lease-document-display.ts:8` and stored override paths in `property-lease-edit.ts` | Confirmed unsanitized source-to-sink path. The disclosure helper now applies the existing lease HTML sanitizer before the fragment reaches `dangerouslySetInnerHTML`. A hostile-user end-to-end browser exploit was not attempted or established. |
| GCM authentication-tag length not fixed | `src/lib/reports/tin-crypto.ts:24` | Confirmed missing strict envelope validation: truncated input could produce a short tag. Encryption/decryption now require a 16-byte tag and reject short/noncanonical ciphertext. No cryptographic forgery was demonstrated. |
| Mutable GitHub Action versions | 31 `uses:` references across six workflows | **Outstanding** supply-chain hardening: pin reviewed action commit SHAs and keep them updated. A mutable tag is not evidence that an action is compromised. |

The remediation rescan ran eight packs successfully over seven changed source/workflow files (plus its local ignore configuration). Its merged SARIF contains **four residual alerts**: three unchanged mutable action references, and the disclosure `dangerouslySetInnerHTML` warning. That rule does not recognize the custom sanitizer; source review confirms sanitation now occurs in the helper. The TLS bypass, GCM-tag and workflow-interpolation alerts no longer appear. The parent validation run reported 138 focused tests passing and lint with zero warnings; this scan report does not claim a successful full build.

The Vercel workflow change was additionally parsed as YAML, checked with `bash -n`, and executed with a stubbed Vercel command and a literal command-substitution-shaped branch value. The branch remained data; no command substitution ran. No actual deployment or real token was used.

## Triage of the remaining original alerts

- **89 Apiiro heuristic matches:** reviewed all locations. These were readable Tailwind/CSS strings, SVG, agent/tool descriptions, lease template prose, explicit local theme/native bootstrap scripts, date/Bezier arithmetic, regexes, and nested promise callbacks. These matches do not establish malicious code.
- **Two raw-HTML-format matches:** the matched lease section builders escape title/body text through `escapeHtml`, `paragraphHtml`, or `verbatimHtml`. Classified as false positives for those specific sinks; this is not a blanket approval of every HTML or URL path in those files.
- **One agent-regression shell warning:** its expression produces only the fixed literal `--live` or an empty string, not arbitrary input. False positive.
- **31 mutable action references:** retained as the outstanding hardening work above.

The remaining seven original alerts correspond to the four patched groups: one TLS, one GCM, one disclosure sink, and four workflow shell-interpolation sites.

## Scope, tools, and rules

Source: `/private/tmp/proplane-security-20260905`, based on commit `f44f23a4479f57c6ae8929ea9364f2db8571540e` plus the in-progress security changes present when the snapshot was taken. `scope-manifest.json` records SHA-256 hashes of **2,142 first-party files**: 1,478 `.ts`, 658 `.tsx`, and six GitHub workflow `.yml` files. Scope was `src`, `next.config.ts`, `instrumentation-client.ts`, and `.github`. Tests, docs, `.env` files, node_modules, builds, graph output, SQL migrations, native sources, and production data were outside this scope.

- Semgrep Community Edition **1.176.1**, isolated Python **3.12.14** environment at `/private/tmp/proplane-semgrep-venv`; package versions are recorded in `tool-packages.txt`.
- Pro probe failed because the proprietary engine/login was unavailable; **no Pro cross-file analysis is claimed**.
- Installed plugin revision: `d3323cefbcf645678b8dc481de204b02ad3d02dc`.
- Baseline: `p/security-audit`, `p/secrets`, `p/owasp-top-ten`, `p/cwe-top-25`, `p/sql-injection`, `p/insecure-transport`.
- Language/framework: `p/javascript`, `p/typescript`, `p/react`, `p/nodejs`, `p/nextjs`; infrastructure: `p/github-actions`.
- Trail of Bits rules: `31390b3a99c04c81522d1b37c8d1900aa2dd4094`; elttam: `244268562cc92d33f54b8a60a187df5520f91b26`; Apiiro: `a21246b666f34db899f0e33add7237ed70fab790`. The installed catalog requires these for JS/TS. 0xdea and Decurity were not selected because their catalog language targets were outside this scope.
- Metrics were disabled on the Pro probe and every scan. Rules were downloaded from public registries/repos; scanning and result storage were local. No authenticated Semgrep cloud upload was run.

The workflow execution tool was unavailable, so its explicitly unattended `semgrep-scan.js` path was adapted by executing the shipped **unmodified** `scripts/run-scans.sh` and `scripts/merge_sarif.py`. This was not the skill's ruleset-approval path. The existing workspace graph was queried first; it returned stale validation-tree references, so source inspection was used for confirmation.

## Coverage limitations and recovery

1. The initial scanner default ignores every directory called `vendor`, including this application's first-party vendor portal. A supplemental scan used an allowlisted snapshot and explicit empty `.semgrepignore` to cover those **35 files**. All 15 selected packs produced artifacts, with zero findings. Counts of 36 include the ignore configuration itself. The supplemental GitHub Actions and Next.js packs opened zero files; they provide no vendor coverage claim.
2. The shipped runner expands language globs against its launch directory. Starting it at a repo root with `.ts` files can narrow per-language scans unintentionally. All five JS/framework packs were rerun from an empty working directory over the full allowlisted snapshot with vendor paths included. JS, Node, React and TypeScript each opened all **2,136 TS/TSX source files**.
3. Disk exhaustion interrupted original manifest assembly and the first framework retry. Eleven original JSON/SARIF pairs were intact and validated; four original framework outputs were unavailable, and two retry JSON outputs were empty. Those missing/invalid outputs were **not merged**. The five-pack framework recovery completed with exit 0. Original per-process exit codes were lost with the runner temporary directory, so they have not been invented; `recovered-artifact-index.json` records this limitation. `scans.json` remains available for the successful vendor, framework-recovery and remediation runs.
4. Some packs timed out or partially parsed source files even when their process completed. Counts are listed below. **A file being opened does not mean every rule analyzed every line.** Lease sanitizer parsing was incomplete, so its correctness depends on source review and the separate regression tests, not a clean scan assertion.
5. elttam has 12 invalid Java rules and Apiiro has four invalid rules. The shipped runner pruned 27 non-rule YAML files from ToB, 14 non-rule files and one unsupported join-rule file from elttam, and zero from Apiiro. These rules did not run. No repositories failed to clone.
6. `p/nextjs` returned zero files in the corrected recovery run; no Next-specific ruleset coverage is claimed. Generic JS/TS, security and React rules did scan the Next application. No unsupported language key, shared-baseline duplicate, or output-directory exclusion pattern affected this run.

| Pack artifact | Files opened | Raw alerts | Coverage errors |
| --- | ---: | ---: | --- |
| all-apiiro-malicious-code-ruleset | 2101 | 89 | Rule parse error: 4, Timeout: 142, PartialParsing: 16 |
| all-cwe-top-25 | 2107 | 8 | Timeout: 56, PartialParsing: 21 |
| all-elttam-semgrep-rules | 2107 | 0 | Rule parse error: 12, Timeout: 20, PartialParsing: 14 |
| all-insecure-transport | 2101 | 1 | Timeout: 4, PartialParsing: 5 |
| all-owasp-top-ten | 2107 | 40 | Timeout: 59, PartialParsing: 22 |
| all-secrets | 2107 | 0 | None |
| all-security-audit | 2107 | 1 | Timeout: 18, PartialParsing: 17 |
| all-sql-injection | 2101 | 0 | None |
| all-trailofbits-semgrep-rules | 2107 | 0 | None |
| github-actions-github-actions | 6 | 36 | PartialParsing: 12 |
| javascript-nextjs | 0 | 0 | None |
| javascript-javascript (recovered) | 2136 | 5 | Timeout: 36, PartialParsing: 16 |
| javascript-nextjs (recovered) | 0 | 0 | None |
| javascript-nodejs (recovered) | 2136 | 3 | Timeout: 40, PartialParsing: 14 |
| javascript-react (recovered) | 2136 | 1 | Timeout: 12, PartialParsing: 11 |
| javascript-typescript (recovered) | 2136 | 5 | Timeout: 3, PartialParsing: 17 |

The pack counts above are not additive: the same source and finding can appear in multiple packs. Thirty-one valid original/vendor/recovery SARIF artifacts were normalized to repository-relative paths and merged with the shipped merger, which reported **130 unique findings**. No selected merge input was unparseable. The invalid/interrupted framework outputs were excluded before building that manifest.

## Artifacts and repeatability

All raw evidence remains outside the repository at `/private/tmp/proplane-security-scan/`:

- `rulesets.json`, `rule-revisions.json`, `scope-manifest.json`, `tool-packages.txt` — selection and provenance.
- `raw/`, `vendor-supplement/raw/`, `framework-recovery/raw/` — original scanner results; `run.log` and recovery logs preserve interruption details.
- `recovered-artifact-index.json`, `merge-inputs.json`, `normalized-raw/`, `merge.log`, `results/results.sarif` — explicit artifact recovery, normalized inputs, and original-snapshot merged result.
- `remediation-manifest.json`, `remediation/scans.json`, `remediation/results/results.sarif` — hashes and targeted verification of fixes.

To repeat the corrected full scan, prepare the same allowlisted snapshot with an explicit `.semgrepignore`, launch from an empty directory, put the isolated Semgrep binary on PATH, and invoke the installed `run-scans.sh` with `--mode run-all`, `--target`, `--output-dir`, `--rulesets`, and a conservative `--jobs` value. Output must be separate from the target. Ensure sufficient free disk and memory before starting.

This scan does not establish production database/storage permissions, encryption-key separation, backup/restore readiness, privileged-account MFA, runtime tenant isolation, external attack resistance, or certification. Those require separate operational verification and assessment.
