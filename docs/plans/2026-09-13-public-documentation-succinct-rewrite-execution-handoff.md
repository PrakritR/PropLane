# Public documentation succinct rewrite: execution handoff

## Goal and plan

Rewrite `/docs` and `/docs/mcp` to be substantially shorter and easier to scan while preserving factual accuracy, anchor compatibility, generated MCP tool coverage, and every external API security guarantee. Highlight the table-of-contents item for the section currently being read.

Plan: `docs/plans/2026-09-13-public-documentation-succinct-rewrite.md`

## Git state

- Starting branch: `keeper/akhil-docs-succinct`
- Current branch: `keeper/akhil-docs-succinct`
- Starting HEAD: `203d5e58f3ad99e6a977d65b1bbdb69115c52711`
- Current HEAD: `203d5e58f3ad99e6a977d65b1bbdb69115c52711`
- No commit, push, merge, pull request, deployment, production access, or ticket was created.

## Decisions

- Keep the existing page components and visual system. Change information architecture and copy, not shared design-system code.
- Lead `/docs` with a three-step start, then role outcomes and task-first workflows.
- Lead `/docs/mcp` with connection actions before protocol background, and state MCP versus REST scope explicitly.
- Consolidate the write workflow in one section while retaining preview-only writes, server-stored input, manager-only confirmation, id-only approval, input revalidation, 15-minute expiry, single use, `410` replay behavior, and unavailable high-risk operations.
- Preserve the live generated MCP catalog. Render only the first sentence of each generated description and normalize legacy service terminology for public display without changing tool identifiers, schemas, counts, or registry data.
- Keep exact REST allowlist semantics, credential isolation, role revalidation, hashed API keys, OAuth revocation, rate limits, status meanings, and the untrusted-content warning.
- Describe the current external catalog as implemented: application decisions, property updates, and listing drafts are available behind the external approval gate. New, pending, and in-review listings still require admin review before publication; previously published listings may switch between live and unlisted.
- Qualify the built-in assistant write promise for its narrow low-risk inbox-housekeeping exception. Keep the universal preview and signed-in manager approval guarantee for every external MCP and REST write.
- Keep maintenance, add-on service requests, and vendor invoice processing distinct. Invoice scheduling is optional before payment.
- Normalize legacy service terminology and em dashes only in generated public tool descriptions. Registry descriptions and tool identifiers remain unchanged.
- Add page-root horizontal clipping because the decorative header glow exceeded the viewport at 375 pixels. Code blocks retain their own horizontal scrolling.
- Keep both pages as Server Components. Mount one shared, narrowly scoped Client Component that receives serializable navigation groups.
- Resolve the active section from ordered DOM geometry on a requestAnimationFrame-coalesced scroll listener. The final section wins within one pixel of the document bottom.
- Initialize from a known URL hash, fall back safely from invalid or malformed hashes, update the active item on the click event, and never write browser history during passive scrolling.
- Keep native anchor navigation. Exactly one link exposes `aria-current="location"`; each link has a route-specific `data-attr`, a 40-pixel target, a visible cobalt focus ring, and a token-based cobalt active state.

## Changed files

- `src/app/(public)/docs/page.tsx`
- `src/app/(public)/docs/mcp/page.tsx`
- `src/components/docs/docs-scrollspy-nav.tsx`
- `tests/unit/docs-scrollspy-nav.test.tsx`
- `tests/unit/public-mcp-tool-descriptions.test.ts`
- `docs/plans/2026-09-13-public-documentation-succinct-rewrite.md` (pre-existing untracked plan, preserved)
- `docs/plans/2026-09-13-public-documentation-succinct-rewrite-execution-handoff.md`

## Word count

The same TypeScript AST method was used before and after. It counts authored JSX text, direct JSX string expressions, visible `title`/`kicker`/`label`/`caption` attributes, metadata and navigation `title`/`description`/`group`/`label` values, and snippet template literals. It excludes imported runtime catalog descriptions. The shared three-word `On this page` label is allocated to each route after extraction into the shared component, so the route comparison remains like for like.

| Page | Before | After | Change |
| --- | ---: | ---: | ---: |
| `/docs` | 1,208 | 766 | -36.6% |
| `/docs/mcp` | 1,078 | 883 | -18.1% |
| Total | 2,286 | 1,649 | -27.9% |

The correction loop reran one consistent TypeScript AST count against HEAD and the corrected files. It counts authored JSX text, direct string expressions, visible copy attributes, metadata and navigation strings, and snippet literals. It excludes imported generated catalog descriptions and allocates the shared three-word navigation label to each route. The plan requires at least 20% overall reduction.

## Correction loop 1

The fresh reviewer returned five findings. This pass corrected each one without changing gateway, tool, registry, authentication, approval, or scrollspy behavior:

- Replaced the false unavailable-tools statement with the current external capability and publication boundary.
- Documented the built-in assistant's low-risk inbox-housekeeping exception while retaining the universal external approval guarantee.
- Replaced the stale unauthenticated-rate-limit explanation with the shared pre-authentication IP limit, per-credential limit, and fail-closed behavior.
- Separated maintenance, add-on service requests, and vendor invoice states, including optional invoice scheduling.
- Added display-only em dash normalization and a rendered-page regression over the live generated catalog. The test verifies prohibited punctuation and legacy service wording are absent while every tool identifier remains present.

## Correction loop 2

The second fresh review found one remaining public brand leak. This pass changed the authored publication boundary from Axis admin review to PropLane admin review and added case-sensitive, whole-word Axis-to-PropLane normalization in the generated public description adapter. The seven affected first sentences now display PropLane inbox, PropLane vendor portal account, outside PropLane, or PropLane ID. Registry descriptions, schemas, identifiers, catalog membership, and behavior remain unchanged.

The rendered-page regression now rejects standalone Axis branding and positively checks each normalized phrase in addition to punctuation, service vocabulary, and all 115 tool identifiers.

## Validation commands and exit codes

- `npm run seed:env`: exit `0`; existing dev/test environment files were retained.
- `npm run test:seed`: exit `1` in the sandbox due DNS isolation.
- `npm run test:seed` with approved network access: exit `1`; it reached the dev/test Supabase project, seeded the admin and manager stages, then stopped on the repository's placeholder Stripe test key. No production target was used.
- `ln -s /Users/akhilvemuri/coding/AXIS-2/node_modules node_modules`: exit `0`; used the matching dependency tree because this worktree initially lacked dependencies.
- The first `npm run build`: exit `1`; Turbopack rejected a dependency symlink outside the worktree filesystem root.
- `unlink node_modules`: exit `0`.
- `cp -a /Users/akhilvemuri/coding/AXIS-2/node_modules node_modules`: exit `0`; replaced the symlink with a local ignored dependency copy for validation.
- `npm run sandbox:pin -- 3000`: exit `0`.
- `npx playwright install chromium`: exit `0`.
- `npx playwright install chrome`: exit `1`; the system Chrome installer required an unavailable sudo password. Browser QA used the installed Playwright Chromium build.
- `npx vitest run tests/unit/mcp-api-key-auth.test.ts tests/unit/mcp-jsonrpc.test.ts tests/unit/mcp-oauth-deny.test.ts tests/unit/mcp-oauth-metadata.test.ts tests/unit/mcp-oauth-revocation.test.ts tests/unit/mcp-tool-scope.test.ts tests/unit/manager-api-keys-route.test.ts tests/unit/manager-api-keys-panel.test.tsx tests/unit/tools/pending-actions.test.ts tests/unit/agent-pending-actions-route.test.ts tests/unit/rate-limit.test.ts tests/unit/public-navbar-resources-menu.test.tsx tests/unit/public-get-started-role-picker.test.ts`: exit `0`; 13 files and 49 tests passed.
- `npm test -- tests/unit/docs-scrollspy-nav.test.tsx`: exit `0`; the delegate's initial seven focused tests passed.
- `npx vitest run tests/unit/docs-scrollspy-nav.test.tsx`: exit `0`; eight focused resolver, hash, click, ARIA, native-link, and keyboard-focus tests passed after integration.
- `npx vitest run tests/unit/docs-scrollspy-nav.test.tsx tests/unit/mcp-api-key-auth.test.ts tests/unit/mcp-jsonrpc.test.ts tests/unit/mcp-oauth-deny.test.ts tests/unit/mcp-oauth-metadata.test.ts tests/unit/mcp-oauth-revocation.test.ts tests/unit/mcp-tool-scope.test.ts tests/unit/manager-api-keys-route.test.ts tests/unit/manager-api-keys-panel.test.tsx tests/unit/tools/pending-actions.test.ts tests/unit/agent-pending-actions-route.test.ts tests/unit/rate-limit.test.ts tests/unit/public-navbar-resources-menu.test.tsx tests/unit/public-get-started-role-picker.test.ts`: exit `0`; 14 files and 57 tests passed in the final run.
- Correction loop: `npx vitest run tests/unit/public-mcp-tool-descriptions.test.ts tests/unit/docs-scrollspy-nav.test.tsx tests/unit/services-vocabulary.test.ts tests/unit/mcp-api-key-auth.test.ts tests/unit/mcp-jsonrpc.test.ts tests/unit/mcp-oauth-deny.test.ts tests/unit/mcp-oauth-metadata.test.ts tests/unit/mcp-oauth-revocation.test.ts tests/unit/mcp-tool-scope.test.ts tests/unit/manager-api-keys-route.test.ts tests/unit/manager-api-keys-panel.test.tsx tests/unit/tools/pending-actions.test.ts tests/unit/agent-pending-actions-route.test.ts tests/unit/rate-limit.test.ts tests/unit/public-navbar-resources-menu.test.tsx`: exit `0`; 15 files and 53 tests passed.
- Final focused rerun after the capability-copy refinement: `npx vitest run tests/unit/public-mcp-tool-descriptions.test.ts`: exit `0`; one file and one test passed.
- Correction loop 2 focused run: `npx vitest run tests/unit/public-mcp-tool-descriptions.test.ts`: exit `0`; one file and one test passed before the positive phrase assertions were added. The final rerun is recorded below.
- Correction loop 2 relevant suite: `npx vitest run tests/unit/public-mcp-tool-descriptions.test.ts tests/unit/docs-scrollspy-nav.test.tsx tests/unit/services-vocabulary.test.ts tests/unit/mcp-api-key-auth.test.ts tests/unit/mcp-jsonrpc.test.ts tests/unit/mcp-tool-scope.test.ts tests/unit/mcp-oauth-revocation.test.ts tests/unit/tools/pending-actions.test.ts tests/unit/agent-pending-actions-route.test.ts tests/unit/rate-limit.test.ts`: exit `0`; 10 files and 43 tests passed.
- Correction loop 2 final focused run with all brand assertions: `npx vitest run tests/unit/public-mcp-tool-descriptions.test.ts`: exit `0`; one file and one test passed.
- `npx eslint 'src/app/(public)/docs/page.tsx' 'src/app/(public)/docs/mcp/page.tsx'`: exit `0`.
- `npx eslint 'src/components/docs/docs-scrollspy-nav.tsx' 'tests/unit/docs-scrollspy-nav.test.tsx' 'src/app/(public)/docs/page.tsx' 'src/app/(public)/docs/mcp/page.tsx'`: exit `0` in the final run.
- Correction loop: `npx eslint 'src/app/(public)/docs/page.tsx' 'src/app/(public)/docs/mcp/page.tsx' 'src/components/docs/docs-scrollspy-nav.tsx' 'tests/unit/docs-scrollspy-nav.test.tsx' 'tests/unit/public-mcp-tool-descriptions.test.ts'`: exit `0`.
- Correction loop 2 changed-file lint used the same command: exit `0`.
- `npx tsc --noEmit`: exit `134`; Node exhausted its default heap.
- `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit`: exit `0`.
- Correction loop rerun: `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit`: exit `0`.
- Correction loop 2 rerun: `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit`: exit `0`.
- The second `npm run build`: exit `1`; compilation succeeded, then the full-project type checker exhausted Node's default heap.
- `NODE_OPTIONS=--max-old-space-size=8192 npm run build`: exit `130`; the long full build was externally interrupted without a diagnostic.
- `NODE_OPTIONS=--max-old-space-size=8192 npm run build -- --webpack`: exit `130`; the long full build was externally interrupted without a diagnostic.
- `NODE_OPTIONS=--max-old-space-size=8192 npx next build --webpack --debug-build-paths='app/(public)/docs/**'`: exit `0`; compilation, full TypeScript checking, and static generation of `/docs` and `/docs/mcp` completed.
- The same focused build command was rerun after scrollspy integration: exit `0`; both routes remained statically generated while the nested navigation component hydrated on the client.
- `git diff --check`: exit `0`.
- Correction loop rerun: `git diff --check`: exit `0`.
- Correction loop 2 rerun: `git diff --check`: exit `0`.
- Static prohibited-copy scan of both page files for an em dash and legacy service wording: exit `0`, with no matches.
- Correction loop authored-source scan for literal em dashes across both page files and the new test: exit `0`, with no matches. The rendered-page regression also passed against all 115 generated tool identifiers.
- TypeScript AST word-count script: exit `0`; results are recorded above.
- `npx graphify hook-rebuild`: exit `1` in the sandbox because npm registry DNS was unavailable.
- `npx graphify hook-rebuild` with approved network access: exit `1` because npm could not determine an executable for the published package. The installed global `graphify` does not expose `hook-rebuild`, and this worktree has no `.graphify/graph.json`; no graph artifacts were changed.
- Correction loop rerun of `npx graphify hook-rebuild`: exit `1` because npm could not determine an executable. The worktree still has no graph state to refresh, and no graph artifact was changed.
- Correction loop 2 rerun of `npx graphify hook-rebuild`: exit `1` for the same unavailable executable. No graph artifact was changed.
- `npm run sandbox:open -- /docs` with host access: exit `0`.

## Browser QA

Server: `npm run dev -- -p 3000`

Review URL: `http://localhost:3000/docs`

Routes exercised with a real Chromium browser:

- `/docs` at 1280 by 900, 768 by 900, and 375 by 812.
- `/docs/mcp` at 1280 by 900, 768 by 900, and 375 by 812.
- Linked routes `/pricing`, `/auth/create-account`, `/contact?tab=schedule`, `/docs/mcp`, and `/support` returned `200`.
- `/portal/profile` correctly redirected an unauthenticated visitor to `/auth/sign-in?next=%2Fportal%2Fprofile`.

Edges exercised:

- One H1 on each page.
- Mobile navigation remains before content.
- Every `/docs` anchor exists and updates the hash: `getting-started`, `portals`, `applications`, `leases`, `rent`, `maintenance`, `accounting`, `documents`, `ai-assistant`, `team`, and `trial`.
- Every `/docs/mcp` anchor exists and updates the hash: `connect`, `keys`, `overview`, `tools`, `actions`, `rest`, `limits`, and `security`. Desktop anchor landings settle at the 96-pixel scroll margin.
- Document width equals viewport width at 1280, 768, and 375 pixels on both routes.
- Downward and upward geometry transitions selected the expected sections on both routes at all three widths. Scrolling to the absolute bottom selected `trial` on `/docs` and `security` on `/docs/mcp`.
- A click selected its target by the next microtask and remained selected after smooth scrolling. One native hash entry was added by the click; subsequent passive scrolling did not change `history.length`.
- Direct loads of `/docs?qa=valid#team` and `/docs/mcp?qa=valid#rest` selected the matching links and landed each target at the 96-pixel scroll margin. Fresh invalid-hash loads selected the first section without throwing.
- Exactly one TOC link had `aria-current="location"` after initialization, click, downward scroll, upward scroll, and bottom selection. All 19 links had route-specific `data-attr` values and matching section targets.
- Keyboard traversal focused an MCP TOC anchor and rendered the cobalt 2-pixel ring plus ring offset. Every mobile TOC target measured 40 pixels high.
- The active state used the current Blue Steel `--primary` token for text and border plus a 10% token wash for its background. The desktop rail remained sticky.
- All four MCP code blocks use internal horizontal scrolling. At 375 pixels their client width is 333 pixels and their scroll widths are 568, 426, 576, and 388 pixels.
- The generated catalog rendered 37 read tools and 78 action tools, 115 total. Both groups were sorted and contained no duplicate tool names.
- Generated public prose contained no legacy service wording.
- Browser console reported zero errors and zero warnings on both routes.

## Remaining risks

- The normal dev/test seed could not complete because the checked-in environment resolves to a placeholder Stripe test key. Public docs do not depend on seeded rows, and browser validation covered the real routes, but this environment issue remains outside the documentation scope.
- The repository-required graph refresh still could not run after the scrollspy TypeScript changes because registry DNS was unavailable. An earlier network-enabled attempt also established that the available npm package has no executable and the installed global CLI lacks `hook-rebuild`. There was no existing graph state to refresh.
- A focused production build passed. Two long full-build attempts were externally interrupted after increasing the heap, so the focused build plus independent full TypeScript check, lint, and tests are the completed build evidence.

## Exact fresh Astra reviewer prompt

```text
You are the fresh Astra reviewer for Akhil's feature cycle in the AXIS-2 repository.

Repository: /Users/akhilvemuri/.treehouse/AXIS-2-ea44f0/7/AXIS-2
Branch: keeper/akhil-docs-succinct
Starting and current HEAD: 203d5e58f3ad99e6a977d65b1bbdb69115c52711
Plan: docs/plans/2026-09-13-public-documentation-succinct-rewrite.md
Execution handoff: docs/plans/2026-09-13-public-documentation-succinct-rewrite-execution-handoff.md

Perform the independent review phase. Read AGENTS.md, docs/agents/AGENTS-akhil.md, the canonical docs/agents/akhil-feature-cycle.md if available, the plan, the execution handoff, docs/agents/mcp-api.md, docs/website-component-standard.md, and the Next.js App Router guides named by the plan before reviewing. Inspect the actual git diff and current source. Do not rely only on the handoff claims.

Review for factual product accuracy, succinctness, scanability, preservation of all existing anchors, responsive behavior, valid links and code examples, generated catalog completeness, and exact MCP security and authorization guarantees. Verify that both page modules remain Server Components and only the shared table of contents is a Client Component. Independently exercise valid and invalid hash initialization, immediate native-anchor click selection, downward and upward scroll selection, final-section selection at document bottom, passive-scroll history stability, exactly one `aria-current="location"`, route-specific `data-attr` values, visible token-based active and keyboard focus states, 40-pixel targets, and 375/768/1280 layouts without page overflow. Pay special attention to OAuth 2.1 with dynamic registration and PKCE S256, scoped REST allowlists, credential isolation, role revalidation, hashed keys, preview-only writes, server-stored input, manager-only confirmation, id-only approval, stored-input revalidation, 15-minute expiry, single use and 410 replay behavior, unavailable high-risk tools, exact status and rate-limit wording, OAuth revocation, and untrusted-content treatment. Confirm user-facing copy says service and contains no em dash. Verify the word-count method excludes generated tool descriptions and that the overall reduction remains at least 20 percent.

Run proportionate read-only checks or tests as needed. Do not invoke no-mistakes. Do not file tickets, edit files, commit, push, open a pull request, merge, deploy, or touch production. Return findings first in severity order with exact file and line references. If there are no findings, say APPROVE and list the evidence you independently verified. Explicitly distinguish repository or environment limitations from implementation defects.
```
