# Public documentation pre-landing Bugbot review

Date: 2026-09-13, 21:01 UTC

## Scope and revisions

- Branch: `keeper/akhil-docs-succinct`.
- Base: `origin/main`, resolved to `203d5e58f3ad99e6a977d65b1bbdb69115c52711`.
- Reviewed head: `c6d7db81ae1486bf400164e328e0a293692c03f0`.
- Reviewed the complete eight-file base/head change: both public docs routes, shared navigation, two tests, and three plan/execution/review artifacts. The working tree had no implementation changes during review. A separate concurrent security-review report appeared during the review and is outside this implementation diff.
- Read Akhil's developer instructions, ship gate, MCP area guidance, installed Next.js server/client-boundary guidance, and the prior correction evidence. Graphify query returned graph-not-found (exit 1); its installed CLI also lacks `review-delta` (exit 1). Used direct source evidence. No implementation, environment, database, registry, or deployment files were changed by this reviewer.

## Findings

### BB-1: Medium / P2 - Sticky index hides its final links on short desktop viewports

Location: `src/components/docs/docs-scrollspy-nav.tsx:127`, with the larger link targets at line 147.

At desktop width, the index is permanently sticky at 96px with `h-fit`, but has neither a viewport-relative maximum height nor vertical scrolling. On `/docs`, the new 40px minimum targets make the rail 604.875px tall. In an independently measured 1280x600 Chromium viewport, after scrolling the document to 1500px, its top was 96px and bottom 700.875px; the Free trial link occupied 660.875px through 700.875px, entirely below the viewport. The same rail fits at 1280x720 and 1280x900. At heights below approximately 701px, the lower links cannot be reached with the pointer while the rail stays pinned; the reader must navigate by keyboard or move near the end of the entire page. Increasing link height from the prior `py-1.5` links expands this existing unconstrained sticky layout into more common short desktop/browser-window sizes.

Reproduction: set a desktop viewport to 1280x600, open `/docs`, and scroll midway through the content. Attempt to use the final Platform navigation links without scrolling to the page end.

Recommended correction: bound the desktop navigation to the viewport and allow internal vertical scrolling with sufficient focus-ring inset, or disable stickiness when the viewport is too short. Preserve the 40px targets and mobile index. Verify pointer and keyboard access to the first and final links at 1280x600, in addition to the existing 900px-high matrix.

Resolution evidence: **unresolved at the reviewed head**. No implementation change was made by this reviewer. The release coordinator received the measured geometry and correction suggestion.

### BB-2: Low / P3 - Mounted tests do not retain coverage of effect lifecycle

Location: `tests/unit/docs-scrollspy-nav.test.tsx:81`.

The committed suite tests the pure resolver and mounted hash/click/ARIA/focus behavior, but mounted cases have no real section elements or controlled animation frames. Consequently, a regression removing scroll/resize registration, frame coalescing, frame cancellation, or listener cleanup could pass these tests. This is a coverage gap, not a demonstrated runtime defect. A temporary review harness executed the actual transpiled component effect and passed all of these behaviors, including missing-section handling. Retaining a small meaningful lifecycle regression would improve protection for the newly introduced client behavior.

Resolution evidence: runtime behavior independently verified in memory, exit 0; durable automated coverage remains unchanged. This finding alone does not block release.

## Verified behavior and correction evidence

- Both route modules remain Server Components. The sole added client boundary receives serializable navigation groups and imports React only. Browser globals are accessed within effects/events. Initial state derives from props on both server and client, so no hydration mismatch is introduced by reading the location during render.
- All 11 product and eight MCP section targets exist. Navigation order follows document order, including the moved MCP connect/keys/overview sections. Native anchor `href` values remain intact and no click handler prevents default navigation. Passive scrolling does not write history or hashes.
- The actual effect's listener functions are removed by identity, and its pending animation frame is cancelled. A single pending frame coalesces scroll and resize events. Missing DOM sections are ignored safely. The hash parser handles malformed percent encoding and rejects unknown ids.
- The generated catalog and count functions are unchanged. Public formatting preserves identifiers, membership, sorting, and schemas. The first-sentence extraction predates this change. The new adapter changes only rendered punctuation, legacy brand references, and service vocabulary. The rendered regression checks every catalog identifier and the normalized phrases.
- The prior factual corrections are present. Independent source checks of `src/lib/mcp/gateway.ts`, transport routes, `src/lib/mcp/capabilities.ts`, application tools, property status validation, and `src/lib/vendor-invoices.ts` support the external preview-only write gate, 900-second proposal TTL, published-listing boundary, 60/minute pre-auth IP and 120/minute credential limits, and optional invoice scheduling. The public guide separates the built-in inbox-housekeeping exception from external approval. No new copy or generated-catalog defect was identified beyond the findings above.

## Independent validation

| Check | Result |
| --- | --- |
| `npx vitest run tests/unit/docs-scrollspy-nav.test.tsx tests/unit/public-mcp-tool-descriptions.test.ts tests/unit/services-vocabulary.test.ts` | Exit 0; 3 files, 10 tests passed |
| `npx eslint 'src/app/(public)/docs/page.tsx' 'src/app/(public)/docs/mcp/page.tsx' src/components/docs/docs-scrollspy-nav.tsx tests/unit/docs-scrollspy-nav.test.tsx tests/unit/public-mcp-tool-descriptions.test.ts` | Exit 0 |
| `git diff origin/main c6d7db81a --check` | Exit 0 |
| Temporary Node/TypeScript VM harness against the actual component effect | Exit 0; valid hash, down/up selection, bottom, resize, missing section, malformed hash, frame coalescing/cancellation, and listener cleanup passed |
| Playwright CLI Chromium matrix against the existing current-source server at `http://localhost:3000` | Exit 0; both routes at 375x900, 768x900, 1280x900 |
| Short-viewport geometry pass | Exit 0; reproduced BB-1 at 1280x600, fits at 1280x720 and 1280x900 |

For every width in the successful browser matrix, every section was exercised in both scrolling directions and selected correctly; absolute document-bottom selection chose `trial` or `security`. Final current-link count remained one. Passive scrolling preserved hash and history length. All targets measured at least 40px; each route had one H1; document width equalled viewport width; no target was missing. MCP rendered all 115 tool rows at each width. Product-page geometry additionally showed no horizontal document overflow at 320x640 and 375x812.

The initial matrix waited for the full load event and timed out (exit 1); the rerun using DOMContentLoaded completed the matrix successfully. A later separate direct-hash/click/focus browser pass timed out while navigating its first route, even using DOMContentLoaded (exit 1), so this review does not claim that additional pass succeeded. Hash initialization, click selection, and keyboard focus are independently supported by the passing unit tests; prior full browser evidence is retained in the dated feature review. The browser console included development Fast Refresh and instrumentation messages, including a full-reload warning, so this review does not claim a warning-free console. No hydration error was identified.

Full repository unit testing, full build, preflight, and release-environment QA are the release coordinator's remaining gates, not successes implied by this bounded review. The earlier focused build and full TypeScript evidence remain attributed to the execution handoff. No data seeding was needed to inspect these static public pages; no authenticated action or production access was performed. No no-mistakes command, commit, push, PR, promotion, or deployment was performed.

## Ship recommendation

**Request the bounded BB-1 layout correction and re-review the affected navigation before shipping.** BB-2 is a non-blocking test-coverage improvement. There are **zero unresolved Critical findings and zero unresolved High findings** at the reviewed head; the mandatory Critical/High landing block is clear. This recommendation does not waive normal release validation or deployment verification.

## Bounded correction re-review - 2026-09-13 21:13 UTC

Reviewed the uncommitted implementation diff after head `c6d7db81ae1486bf400164e328e0a293692c03f0`. The only implementation changes are the desktop navigation classes and one layout regression test. Reviewed Git blob identities:

- `src/components/docs/docs-scrollspy-nav.tsx`: `6b0f3926a1f15a8daea78a9a3fa86157c58e582d`.
- `tests/unit/docs-scrollspy-nav.test.tsx`: `5bd5a3b19784575826f5a92b2a61d93505618b14`.

The navigation now uses a desktop maximum height of `calc(100dvh - 7rem)`, vertical overflow scrolling, contained overscroll, and 4px horizontal padding for its focus treatment. The scrollspy algorithm, hash handling, listener lifecycle, content, catalog, and mobile styles are unchanged.

**BB-1 is resolved.** Independent Chromium evidence against current development source:

- At `/docs`, 1280x600, after scrolling the document to 1500px, the rail measured top **96px**, bottom **584px**, client height **488px**, and scroll height **605px**. It fits within the viewport with a 16px bottom gap.
- Pointer wheel input over the rail moved its internal scroll position to **117px**, revealing the final link at bottom **583.875px**. The document stayed at **1500px**. Additional wheel input at the rail's lower boundary still left the document at **1500px**, verifying overscroll containment. Clicking Free trial changed the native hash to `#trial` and selected the corresponding current link.
- Keyboard traversal through all **11** native links brought each focused link entirely inside the rail. The first link occupied **118.71875px to 158.71875px** at scrollTop 0; the last occupied **543.875px to 583.875px** at scrollTop 117. Every keyboard-focused link had the cobalt ring and offset. The 1280x600 screenshot was independently inspected and shows a readable final link with visible focus styling. Temporary screenshot: `output/playwright/docs-review/bugbot-short-focus.png`.
- At 1280x900, `/docs` remained sticky and its whole rail fit without internal overflow (client and scroll height both **605px**). At 375x812 and 768x900, it remained a normal static mobile/tablet index with visible overflow and no nested scroll requirement. Document widths equalled the viewport in all cases, and minimum link height stayed **40px**.
- `/docs/mcp` passed a separate matrix at **1280x600, 1280x900, 375x812, and 768x900**. The shorter MCP rail fits even at 600px high (top **96px**, bottom **534.15625px**). Mobile/tablet navigation remains static. Every document width equals the viewport. All **115** tool rows and eight anchors remain present. Downward and upward selection across connect/tools/security/keys passed at each size.

Validation commands:

- `npx vitest run tests/unit/docs-scrollspy-nav.test.tsx`: exit **0**, **9 tests passed**.
- `npx eslint src/components/docs/docs-scrollspy-nav.tsx tests/unit/docs-scrollspy-nav.test.tsx`: exit **0**.
- `git diff --check`: exit **0**.
- Corrected pointer/keyboard/layout browser harness: exit **0**. Its first attempt exited 1 because the harness programmatically focused the first link immediately after pointer input and incorrectly required `:focus-visible` before keyboard interaction. Re-entering that link with Shift+Tab/Tab correctly tested keyboard modality and passed all eleven links. This was a harness assumption, not an implementation defect.
- Separate MCP browser regression harness: exit **0**.

BB-2 remains a **non-blocking Low/P3** recommendation: the new class guard protects the chosen layout classes but does not add mounted effect-lifecycle coverage. The earlier independent actual-effect harness remains passing evidence; the correction does not change that effect.

### Updated ship recommendation

**APPROVE the reviewed documentation change plus the bounded correction identified above.** BB-1 is resolved with independent pointer, keyboard, containment, focus, responsive, and test evidence. There are **zero unresolved Critical or High findings**, and no remaining Medium finding. BB-2 does not block release. Normal release gates remain applicable. This re-review changed only this report; no implementation edit, commit, push, deployment, production operation, or no-mistakes invocation was performed by the reviewer.
