# Inbox composer width correction acceptance

Date: 2026-09-13. Fresh Astra review for Akhil.

**SOURCE AND COMPOSER RUNTIME ACCEPTED. No actionable correctness, regression, or security finding in the four-file correction. Subsequent release gates remain root-owned.** This report supplements the original inbox source acceptance and security reviews; it does not represent a fresh line-by-line audit of their unchanged 33-file scope.

## Exact reviewed inventory

Keeper `akhil/prp-472-inbox-unread`, HEAD `542d11ca0cc20aaf6edb2d7141fa4d2d29afb3f5`, base `75d711053085e340072c605bcb96eaa9416ef87e`, plus the exact four-file working diff below. Reviewer independently read the diff against HEAD, checked all 37 current file hashes and all 33 original accepted hashes, and recomputed both aggregates from sorted compact JSON path-to-hash dictionaries. Zero mismatches; verification exit 0. Read-only `git diff --check` also exited 0.

- Current 37-file aggregate: `2f24e6e624a6e289d735fc4aff3f148a9d6eac3d22a9448d74693a5a1ee527e4`.
- Original 33-file aggregate, unchanged: `7432b0cc36d65cd4822aa16295e368812194258ad4b4d7fe35b64f11df263ce8`.
- Private manifests: `/private/tmp/axis-inbox-release/source-freeze.json` and `source-freeze-33-accepted.json`.

| Additional file | SHA-256 |
| --- | --- |
| `src/components/portal/portal-inbox-ui.tsx` | `3f6304856dfd80e00f51598b5c27960182ef4a58d88e6c3e153e21f39f68f356` |
| `tests/e2e/communication-reply-composer.spec.ts` | `3327d9a9cb33113da5f536ee298dae9cac13665d89c2914116302c466a642204` |
| `tests/e2e/mobile-portal-layout.spec.ts` | `d9bf6975fad0404c0ba88954c8de6efe7b316d1ba63831602ca75b69813c036e` |
| `tests/integration/portal/portal-vendors.test.ts` | `00697a7f7beb1a1393fe3583e7907ca4bbf03211fcddfa9d45b5cd94ad267295` |

Read repository and matching Akhil instructions, composer width plan/handoff, prior composer QA maintenance handoff, Communication/UI checklist, original inbox release acceptance, and its Bugbot/security acceptance reports. Neither current nor legacy graph exists in this worktree, so authoritative documentation and scoped source/diff inspection supplied context. This reviewer made no source, Git-state, database, provider, browser, or server changes and ran no broad tests or no-mistakes. Only this report was written.

## Correction assessment

**Shared composer, `portal-inbox-ui.tsx:1679` and `:1735`: accepted.** The product diff consists of exactly two class changes. When trailing controls exist, widths below 640px use a 4px outer gap and zero inner tool gap. Three outer gaps recover 6px and two inner gaps recover 8px, predicting 143px from the previously measured 129px textarea. At 640-767px the outer/tool gaps remain 6px/4px; at 768px and above they remain 8px/6px. `sm:max-md` bounds the intermediate override and preserves desktop spacing. Composers without trailing controls retain their existing row behavior.

No controls are removed or reduced in size. The textarea flex sizing, attachment/send dimensions, responsive emoji hiding, no-wrap choice, focus and keyboard handlers, safe-area padding, attachment handling, submission authorization, analytics attributes, and component props are unchanged. The arithmetic supports the plan, but is not substituted for browser geometry. Zero gap between phone tool hit boxes makes the screenshot and click sweep material acceptance evidence.

**Composer E2E maintenance, `communication-reply-composer.spec.ts:35`: accepted.** Independently rechecked the already-reviewed delta. The fixture-label override retains the CI default and still selects the actual `resident-direct-chat-compose` textarea with controls scoped to its form. The test preserves the `>140px` field-width requirement at 375/768/1280px, focus, empty/draft Send state, actual filechooser click, desktop emoji insertion, intended phone emoji hiding, and the current schedule configure/cancel interaction with pressed-state checks. The phone attachment minimum reflects the pre-existing 36px control. No message submission or upload is introduced.

**Mobile E2E maintenance, `mobile-portal-layout.spec.ts:106`: accepted.** Only the document measurement retries across navigation-context destruction. A successful measurement of actual overflow exits the retry and is retained for the final failing assertion. This cannot poll a genuine overflow away. The route list, viewport, tolerance, landmark check, and final assertion remain unchanged.

**Vendor integration fixtures, `portal-vendors.test.ts:20`, `:138`, and `:182`: accepted.** The empty accepted-link mock supplies the existing `select().eq().eq()` read used by `linkedOwnerScopeForModule`; it grants no extra owners and leaves the real authorization helper active. The own-vendor fixture now models the actual missing-row `insert().select().maybeSingle()` persistence path instead of obsolete upsert behavior. Comparison against `src/app/api/portal-vendors/route.ts:186-250` confirms that stored-owner lookup and server-derived ownership remain authoritative. The other-owner case still requires 403 and its error text. The own case still requires 200 and persisted sharing/name fields, and now explicitly asserts `manager_user_id: "mgr-a"`. No product vendor source changes are part of this correction.

## Bugbot and security implications

This fresh independent branch-delta bug review found no unresolved Critical/High or other actionable bug in the four-file scope. No hosted Bugbot service execution is claimed.

The only product changes are responsive CSS gaps. They create no route, authorization, database, storage, provider, account, or data-disclosure behavior. The test mocks do not replace the ownership resolver or make a denied owner authorized; they allow existing denial and permitted-write assertions to reach the current implementation. E2E actions remain local draft/menu/filechooser interactions without sending or uploading. The original 33-file security acceptance remains applicable to exactly matching bytes, including the read-state and recovery-trigger corrections. This bounded review adds no production mutation authorization.

## Validation evidence and remaining boundary

- Reviewer independently verified manifests and diff formatting, exit 0.
- Implementation handoff reports scoped composer ESLint exit 0 with 12 existing warnings; the earlier E2E maintenance scoped lint/diff checks also exited 0. These were not rerun here.
- Root reports the final full integration command exited 0. Reviewer read `/private/tmp/axis-inbox-release/integration-final.log`: **51 files passed, 5 skipped; 275 tests passed, 40 skipped; 16.84 seconds**. Root's prior full integration run had reproduced the two baseline vendor fixture failures; this passing result belongs to the current corrected fixtures.
- Final full unit, full lint, build, retained 12-case E2E suite, and screenshots are root-owned and pending at this report's initial write. Earlier source-freeze broad results must not be presented as fresh validation of the new composer bytes.
- Required browser proof remains the actual direct pane at 375/768/1280px, including field width above 140px at 375px, attachment and Send reachability, all three distinct clickable phone tools, unchanged larger-screen spacing/emoji behavior, and no overflow. The earlier 129px failing run remains a failed run until superseded by retained passing evidence.

Source acceptance permits continued root validation. It is not a completed release, deployed QA, or device/TestFlight certification. A changed frozen source path requires affected re-review and validation. Root should append the final exact-freeze results before treating this correction's runtime acceptance as complete.

## Final validation addendum

Root subsequently relayed completed broad checks; reviewer inspected the retained result JSON and relevant log summaries:

- Full unit: **1,465 files and 10,349 tests passed, exit 0**, 206.96 seconds command wall time (205.64 seconds runner duration). This run began before the final breakpoint-class refinements. It supplies behavioral regression coverage, but is not claimed as an exact-final-CSS geometry check.
- Final build: **exit 0**, 39.48 seconds, with successful compilation, TypeScript, and all 394 static pages. This build includes the final composer classes and current four-file correction.
- Final scoped lint across all four changed files: root reports **exit 0**; retained log shows zero errors and 12 existing warnings in the shared composer file. The earlier full-repository lint remains exit 0 with 746 existing warnings; it was not rerun as a new full-repository pass after this correction.
- Full integration remains **exit 0**, 275 passed and 40 skipped, as recorded above.

Root is running the retained 12-case E2E suite against the rebuilt application. Final geometry, screenshots, and runtime acceptance remain pending. The source verdict remains accepted without new findings; no test threshold was weakened.

## Final geometry and schedule synchronization acceptance

This addendum supersedes the earlier pending composer-runtime status. The inventory above now records the final test bytes. Reviewer independently rehashed all 37 final paths and the sorted compact JSON aggregate after the last harness correction: zero mismatches, exit 0. Only the composer E2E changed from the initially reviewed 37-file freeze; product source and the original accepted 33 paths remain unchanged.

Root's geometry browser command exited 0. Reviewer read `/private/tmp/axis-inbox-release/composer-layout-result.json`:

| Viewport | Textarea width | Outer / tool gap | Page overflow |
| --- | --- | --- | --- |
| 375px | 143px | 4px / 0px | false |
| 640px | 366px | 6px / 4px | false |
| 768px | 391.65625px | 8px / 6px | false |
| 1280px | 331.109375px | 8px / 6px | false |

Reviewer also viewed the retained `composer-375.png` and `composer-1280.png`. The phone field is readable; attachment, three separate tools, and Send remain visibly distinct and contained above navigation. The desktop composer retains its spacing and emoji affordance. This closes the measured 129px failure with actual 143px browser evidence, without hiding actions or shrinking controls.

The rebuilt-product broad run passed 11 of 12 cases. Its sole failure occurred when the composer test immediately reopened the desktop schedule menu while its previous close animation was exiting. Root added a state-based wait after schedule confirmation and strengthened the cancellation wait: `expect(sendAt).toHaveCount(0)`. Reviewer compared those four added/changed lines with the actual controlled `InboxComposerScheduleMenu` and shared dropdown implementation. **Accepted, no actionable bug or security finding.** Confirmation still requires `aria-pressed=true`; cancellation still clicks the actual Send now instead item and requires `aria-pressed=false`. All geometry, focus, filechooser, emoji and Send-state assertions remain intact. No arbitrary sleep, retry of a product assertion, provider send, or product change was introduced. The role locator's zero count means no accessible matching input remains; the current fade-out/removal lifecycle provides the intended close synchronization.

The focused rerun then passed the actual resident composer at **375px, 768px and 1280px**, with all retained interactions: root reports **exit 0, 27.503 seconds** command wall time; reviewer read `composer-focused.log`, which reports **4 passed (3 authentication setup cases plus the composer case), 27.1 seconds** runner duration. Root retains `composer-focused-result.json`.

Together, the broad run and focused rerun supply passing coverage of all 12 distinct retained cases. **This is not a claim of one uninterrupted 12/12 passing run.** Earlier failures remain accurately recorded. The final change after the build was E2E synchronization only; unchanged product hashes preserve build applicability. No further source correction or repeated broad run is requested by this bounded review. Staging/deployment QA, preflight, and final release verification remain separate root-owned gates.
