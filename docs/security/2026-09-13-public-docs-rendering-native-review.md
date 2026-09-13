# Public documentation rendering and native parity review

Date: 2026-09-13, 21:08 UTC

## Scope and recommendation

**HOLD for the bounded short-viewport navigation correction, then re-review that layout before landing. Unresolved Critical: 0. Unresolved High: 0.** The one unresolved Medium finding affects pointer access to the final product-docs table-of-contents links in short desktop windows. No cache, RSC boundary, bundle, routing, deep-link, safe-area, or native-shell regression otherwise blocks this change.

- Branch: `keeper/akhil-docs-succinct`.
- Base: `origin/main`, resolved to `203d5e58f3ad99e6a977d65b1bbdb69115c52711`.
- Reviewed head: `c6d7db81ae1486bf400164e328e0a293692c03f0`.
- Reviewed the complete eight-file base/head diff, with rendering focus on both public docs pages and `DocsScrollspyNav`.
- Read `docs/web-and-native-parity.md`, the local Next.js 16 Server and Client Components, server/client boundary, linking/navigation, and prefetching guidance, the shared public layout, native bridge, platform route registry, and native safe-area CSS.
- No implementation, route registry, native shell, deployment, or production state was changed. This report is the only tracked file added by this reviewer. No commit, push, deployment, or no-mistakes command was performed.

## Findings

### RN-1: Medium - Sticky product-docs index clips its final links in short desktop viewports

Location: `src/components/docs/docs-scrollspy-nav.tsx:127`, with target sizing at line 147 and the 11-link product navigation supplied by `src/app/(public)/docs/page.tsx:14`.

At the `lg` breakpoint the navigation becomes sticky at `top-24` and keeps its intrinsic height. It has no viewport-relative maximum height and no vertical overflow behavior. The new `min-h-10` targets make the 11-link `/docs` rail taller than the 504px available below its 96px sticky offset in a 600px-high desktop viewport. The concurrent measured browser review found a 604.875px rail at 1280x600: its top stayed at 96px, its bottom was 700.875px, and the final Free trial link occupied 660.875px through 700.875px. The rail fit at 1280x720 and 1280x900.

This makes the lower links unavailable to a pointer while the rail remains pinned through the middle of the document. It does not affect the mobile index, and `/docs/mcp` has fewer links, but the shared component allows this failure wherever a desktop rail is taller than the remaining viewport.

Recommended correction: preserve the 40px targets, but either bound the sticky rail to the viewport and give it internal vertical scrolling with focus-ring inset, or disable stickiness for short viewports. Recheck first and final links by pointer and keyboard at 1280x600, plus the existing mobile/tablet/desktop matrix.

Resolution: unresolved at reviewed head `c6d7db81a`. This Medium finding is the reason for the hold recommendation.

### RN-2: Informational - `/docs` remains outside the native universal-link allowlist

Location: `src/lib/platform/parity.ts:14-27` and `src/components/native/native-bridge.tsx:108-111`.

`/docs` and `/docs/mcp` are not in `IN_APP_PATH_PREFIXES` or `IN_APP_PATH_EXACT`, so an external universal-link event for either route is ignored by the native bridge rather than assigned inside the WebView. This is pre-existing: both routes already existed on the base revision, and this change adds no route, push target, or new external deep-link contract. Links followed from within the loaded Next.js application continue to use the shared route normally.

Disposition: no change required for this rewrite. If product intent later requires public documentation universal links to open inside the native shell, register `/docs` as a separate scoped parity change with its own platform tests.

## Rendering, cache, and performance evidence

- Both `src/app/(public)/docs/page.tsx` and `src/app/(public)/docs/mcp/page.tsx` remain Server Components. They do not use browser globals, request-time APIs, uncached fetches, or client directives. The large generated MCP catalog stays in the server module graph.
- The client boundary is limited to `src/components/docs/docs-scrollspy-nav.tsx`. Its props are serializable arrays of authored ids and labels. Browser state, `window`, and `document` access stay inside the effect or click handler. This follows the installed Next.js 16 recommendation to place `"use client"` at the smallest interactive boundary.
- Current source performs at most 11 `getBoundingClientRect()` reads for `/docs` and eight for `/docs/mcp` per processed scroll/resize frame. A passive scroll listener plus one pending `requestAnimationFrame` coalesces event bursts. State updates use a primitive id, so React can bail out when the active id is unchanged. Cleanup cancels the frame and removes all three listeners by function identity.
- The client component imports React only. Existing production artifacts that include the same final scrollspy implementation contain route chunks of 2,802 bytes raw / 1,354 bytes gzip for `/docs` and 3,362 bytes raw / 1,576 bytes gzip for `/docs/mcp`. The catalog implementation does not appear in those client chunks.
- The prior focused production build recorded in the execution handoff completed with both routes statically generated. Current source still contains no runtime request dependency that would change that classification. The production artifact sizes were inspected as supporting boundary evidence; they predate the final prose-only corrections and are not represented as a fresh build of `c6d7db81a`.
- A current-head dev-server request returned HTTP 200 for each route. Server HTML already contained the section headings, real fragment links, and exactly one initial `aria-current="location"`, confirming useful HTML before hydration. Development responses correctly used `no-cache`; they do not establish production CDN policy.
- Page-level `overflow-x-clip`, `min-w-0`, and internal `overflow-x-auto` code blocks prevent wide MCP snippets from widening the document. No new image, font, dependency, async fetch, interval, observer, analytics event, or native plugin cost was added.

## Web and native parity evidence

- The Capacitor app consumes the same Next.js routes and components. No parallel native UI, portal section, nav registry, push destination, upload path, purchase flow, shell plugin, or native project file changed.
- The public layout hides its web navbar and footer inside the native shell but renders the same docs content. Global native CSS applies safe top padding to the public `<main>` and safe left/right body padding, while both changed pages clip horizontal overflow. There is no fixed docs control at the home-indicator edge and no bottom action requiring an additional safe-area inset.
- Fragment navigation remains a real `<a href="#...">`. The click handler does not prevent default behavior, so browser and WebView scrolling, history, keyboard semantics, and deep fragments remain available. Every declared navigation id has a matching section in document order on both pages.
- The shared component handles valid hashes, rejects unknown or malformed decoded ids, updates on `hashchange`, recomputes geometry on resize, and selects the final section at document bottom. The focused unit suite covers resolver movement, bottom selection, valid/invalid hash behavior, click state, one current item, real anchor hrefs, and keyboard focus styling.
- At mobile widths the navigation remains in normal flow above the content, with 40px minimum targets. At desktop widths it becomes a left rail. RN-1 is the only identified responsive failure.
- The Playwright CLI's default Chrome launch failed because Google Chrome is absent. An installed WebKit session opened, but subsequent CLI inspection timed out under concurrent local test/server load, so this reviewer does not claim a new completed WebKit matrix. The current SSR checks, source analysis, focused tests already recorded for this head, and the separately measured 1280x600 Bugbot reproduction support the disposition above.

## Validation and limits

| Check | Result |
| --- | --- |
| `git diff --check origin/main...c6d7db81a` | Exit 0 |
| Current-head `curl` of `/docs` and `/docs/mcp` on the existing local server | Exit 0; HTTP 200; 156,274-byte and 256,892-byte development HTML responses |
| Server-rendered anchor/section/current-state scan | Passed for both routes |
| Focused Vitest invocation started during a concurrently running full unit suite | No independent final result captured; no success claimed |
| Playwright CLI Chrome launch | Failed because the system Chrome distribution is absent |
| Playwright CLI WebKit follow-up | Inconclusive due command timeouts under concurrent local load |

Full build, full unit/lint aggregation, staging QA, and deployment verification remain release-coordinator gates. No seed or authenticated data was needed for these static public routes.

## Ship recommendation

Do not land `c6d7db81a` unchanged. Apply the bounded RN-1 sticky-rail correction, then re-run short-desktop pointer/keyboard checks at 1280x600 and confirm the ordinary 375/768/1280 layouts remain intact. With that correction verified and the normal release gates green, this rendering/native review has no Critical or High blocker and no additional parity change to request.

## Bounded correction re-review - 2026-09-13, 21:19 UTC

Reviewed the uncommitted correction layered on head `c6d7db81a` in `src/components/docs/docs-scrollspy-nav.tsx` and `tests/unit/docs-scrollspy-nav.test.tsx`. No implementation file was changed by this reviewer.

### Resolution evidence

- The pointer-access portion of RN-1 is resolved. At 1280x600 in Playwright WebKit, the `/docs` rail measured 488px high from y=96 through y=584, with `clientHeight=488`, `scrollHeight=605`, and a 117px internal scroll range. Scrolling the rail to 117 brought the final Free trial link into the scrollport. Document width remained exactly 1280px with no horizontal overflow.
- At 1280x900, the `/docs` rail retained its full 604.875px intrinsic height with no internal scroll range. Document client and scroll widths both remained 1280px.
- At 390x844, the rail remained in normal flow with `position: static`, `overflow-y: visible`, full intrinsic height, and document client and scroll widths both 390px. The desktop overflow behavior did not leak into the mobile layout.
- At 1280x600, `/docs/mcp` retained its full 438.156px height, required no internal scrolling, and produced no page overflow.
- The focused test passed independently: `npm exec -- vitest run tests/unit/docs-scrollspy-nav.test.tsx --reporter=verbose`, exit 0, one file and nine tests.

### Remaining RN-1 edge: Medium - final-link focus ring is vertically clipped

The correction adds `lg:px-1`, which provides the exact 4px horizontal inset needed by the two-pixel ring plus two-pixel offset. It simultaneously sets `lg:py-0` on the new `overflow-y-auto` scroll container. The final link therefore remains flush with the bottom of the scrollport.

Independent WebKit geometry at 1280x600 after scrolling the `/docs` rail to its maximum:

- Navigation: y=96 through y=584.
- Free trial link: y=543.875 through y=583.875.
- Computed keyboard focus treatment: a two-pixel background offset plus a four-pixel primary outer box shadow.
- Result: approximately four pixels of the outer focus treatment extend beyond the overflow clip at y=584.

The same edge reproduces on `/docs/mcp` without an internal scroll range: the Security link ends at y=534.156, exactly where the `overflow-y-auto` navigation ends. A focused navigation screenshot showed the lower corners and bottom portion of the primary ring cropped. This is a regression from the prior `overflow: visible` desktop rail and does not satisfy the requested no-focus-clipping condition.

Bounded correction: add vertical scrollport inset sufficient for the four-pixel focus treatment, while preserving the current viewport cap and 40px targets. The max-height calculation may need to account for that inset so the outer rail still ends by y=584. Extend the focused class regression to assert the vertical inset, then recheck first/final keyboard focus at 1280x600 and a normal-height desktop viewport.

### Native parity clarification

The correction introduces no mobile or native-shell route regression. Manual `data-native="ios"` tagging retained a 390px document width and the mobile rail stayed in normal flow. The earlier report's statement that generic public `<main>` safe padding applies should be narrowed: `PublicMainTransition` wraps `<main>` in a `<div>`, so the pre-existing selector `html[data-native] .axis-page-frame > main` does not match these routes. The docs pages still supply their own 64px top and 20px side insets, and the reviewed correction does not change them. This is pre-existing shared-layout behavior, not a regression caused by the bounded fix.

### Updated ship recommendation

**HOLD for one more bounded focus-inset correction and re-review. Unresolved Critical: 0. Unresolved High: 0.** The original pointer-clipping defect is resolved and normal-height/mobile layouts show no regression, but RN-1 remains Medium until the final-link keyboard focus ring is fully visible inside the desktop overflow container.

## Final bounded correction re-review - 2026-09-13, 21:24 UTC

Reviewed the final uncommitted correction layered on head `c6d7db81a`. The desktop rail now uses `lg:pb-1` with `lg:pt-0`; the focused unit guard asserts the bottom inset. No implementation file was changed by this reviewer.

### Final resolution evidence

- `/docs` at 1280x600 in Playwright WebKit: the rail remained y=96 through y=584 with `clientHeight=488`, `scrollHeight=609`, and a 121px usable internal scroll range. At maximum rail scroll, the focused Free trial link occupied y=539.875 through y=579.875, leaving 4.125px between the link and the overflow boundary.
- The Free trial link was the active element, matched `:focus-visible`, and retained the computed two-pixel background offset plus four-pixel cobalt outer focus shadow. The available 4.125px clearance contains that treatment rather than clipping it.
- `/docs/mcp` at 1280x600: the rail required no internal scrolling and ended at y=538.156. The focused Security link ended at y=534.156, leaving exactly 4px. It was active, matched `:focus-visible`, and retained the same visible cobalt focus shadow.
- Neither desktop route widened the page: document client and scroll widths both measured 1280px, and each rail's client and scroll widths both measured 208px.
- `/docs/mcp` at 390x844 remained `position: static` with `overflow-y: visible`, the original 16px mobile bottom padding, a 40px final target, and document client and scroll widths both 390px. The desktop cap, overflow, and four-pixel padding remain breakpoint-scoped.
- The earlier 1280x900 `/docs` check remains valid: the full-height rail fits without an internal scroll range, and the final four-pixel inset now also protects its last keyboard target.
- Independent focused validation: `npm exec -- vitest run tests/unit/docs-scrollspy-nav.test.tsx --reporter=verbose`, exit 0, one file and nine tests. `git diff --check` across the implementation, focused test, and this report also exited 0. The release coordinator separately reports changed-file ESLint passing; this reviewer did not rerun that identical check.

### Final disposition

RN-1 is **resolved**. The correction preserves the 40px targets, restores pointer access in short desktop viewports, fully contains the keyboard focus treatment, produces no horizontal page or rail overflow, and leaves normal-height and mobile behavior intact. RN-2 remains informational and pre-existing.

**APPROVE the bounded rendering and web/native-parity correction for landing. Unresolved Critical: 0. Unresolved High: 0. Unresolved Medium: 0.** Normal repository preflight, aggregate validation, staging QA, and deployment verification remain separate release gates.
