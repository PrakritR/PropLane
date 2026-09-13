# Public documentation succinct rewrite

## Goal

Rewrite PropLane's two public documentation pages so a reader can understand
the product or connect an agent with less reading. Keep every material product,
security, and authorization boundary accurate. As the reader scrolls, highlight
the table-of-contents link for the section currently being read.

Branch: `keeper/akhil-docs-succinct`

Starting HEAD: `203d5e58f3ad99e6a977d65b1bbdb69115c52711`

## Evidence and writing direction

The current surface is limited to `/docs` and `/docs/mcp`. Both pages use the
same static server-component shell and anchor navigation. A consistent source
text approximation counts about 1,142 tokens on the product page and 1,049 on
the MCP page; the latter also renders a generated tool catalog. The main issues
are repeated explanations, long multi-claim sentences, marketing language
inside task guidance, and sections whose first paragraph delays the action.

Use the task-first patterns visible in the Stripe Get Started and Linear Start
Guide/MCP documentation:

- open each page and section with one sentence that states its purpose;
- use direct verbs and second person for actions;
- keep one concept per sentence and one to three sentences per paragraph;
- use short, parallel lists for choices, steps, and guarantees;
- place limits and approval requirements beside the action they constrain;
- remove filler and repeated claims instead of merely shortening sentences.

PropLane-specific style:

- say `service`, never user-facing `work order`;
- use plain hyphens or punctuation, never em dashes;
- preserve product names, route names, protocol names, status codes, prices,
  and generated tool descriptions exactly where they remain relevant;
- keep claims factual and avoid promises such as universal automation or
  instant synchronization when a simpler description is sufficient.

## Scope and decisions

### Product guide (`src/app/(public)/docs/page.tsx`)

- Tighten page metadata and the opening description.
- Keep the existing workflow coverage and stable section anchors where
  possible so inbound links continue to work.
- Turn Getting started into a short outcome statement followed by three clear
  steps. Link pricing instead of repeating the complete plan table.
- Describe each portal by the tasks its user completes. Avoid implementation
  claims about one codebase or separate logins.
- Reduce each workflow section to its trigger, main flow, and resulting state.
- Keep the AI approval gate, private document access, accounting treatment,
  and co-manager permission model explicit.
- Fold the repeated free-trial explanation into Getting started and retain a
  concise final call to action. Remove the redundant `trial` navigation item
  only if the final CTA no longer needs its own documentation section.

### MCP and API guide (`src/app/(public)/docs/mcp/page.tsx`)

- Tighten page metadata and opening copy.
- Separate connection choices clearly: browser-authorized MCP for the complete
  manager tool surface, and scoped API keys for selected REST tools.
- Put the MCP setup action before protocol background.
- Keep the generated live tool catalog and counts unchanged.
- Explain write approval once in the dedicated section, then use short links or
  reminders elsewhere.
- Preserve the two-step write contract, 15-minute expiry, single-use approval,
  manager-only confirmation, unavailable high-risk tools, status-code meaning,
  rate-limit wording, hashed-key behavior, role revalidation, OAuth revocation,
  and untrusted-content warning.
- Keep code examples valid. Shorten comments only when meaning remains clear.

### Shared structure

Reuse the existing local components and visual shell. Keep both route pages as
Server Components, with one narrowly scoped shared Client Component for the
interactive table of contents. Pass only serializable navigation groups into
that boundary. Do not add a new content framework or change the public design
system, routing, generated MCP catalog, or authenticated product behavior.

The shared table of contents must:

- keep real anchor links and all existing section ids;
- expose exactly one active link with `aria-current="location"`;
- use Blue Steel theme tokens for a visible active state and focus indicator;
- add a stable `data-attr` to each link;
- select sections reliably while scrolling down or up and select the final
  section when the reader reaches the bottom of the page;
- initialize from a valid URL hash when present and fall back safely when a hash
  does not match a section;
- update immediately after an anchor click; and
- avoid modifying browser history during passive scrolling.

## Exclusions

- No changes to internal repository documentation except this plan and phase
  handoff/review artifacts.
- No product behavior, pricing model, API contract, registry, authentication,
  database, migration, analytics, or deployment changes.
- No broad rewrite of marketing, support, security, or portal copy outside the
  two public docs routes.

## Data, security, and observability

There are no data or migration concerns. The table-of-contents state is local
browser state and does not emit analytics or mutate URL history while scrolling.
The MCP page documents a security
boundary, so every shortened statement must be checked against
`docs/agents/mcp-api.md` and the current catalog/gateway behavior. No new user
funnel event is added; stable `data-attr` values support existing autocapture.

## Acceptance criteria

1. `/docs` and `/docs/mcp` retain all material workflows and constraints while
   being materially shorter and easier to scan.
2. Every section begins with its outcome, action, or definition. Lists use
   parallel grammar.
3. Repeated trial, portal, tool-grounding, and write-approval explanations are
   consolidated.
4. No user-facing occurrence of `work order` or an em dash remains in either
   page.
5. Existing section links, CTAs, support links, generated tool catalog, dynamic
   counts, and code samples still render and work. Any removed anchor has no
   remaining internal link.
6. Product claims match the current source-of-truth area documentation and
   current product copy. The rewrite does not invent features or guarantees.
7. Both routes render at desktop and mobile widths without horizontal page
   overflow. Code blocks may scroll within their own container.
8. The authored documentation prose is reduced by at least 20 percent overall,
   measured consistently before and after while excluding the generated tool
   catalog.
9. The shared table of contents highlights exactly one current section on both
   routes, updates in both scroll directions, selects the final section near the
   page bottom, initializes from a valid hash, falls back from an invalid hash,
   and updates immediately on click without passive history writes.
10. Table-of-contents links remain native anchors with visible keyboard focus,
    `aria-current="location"` on only the active link, stable `data-attr`
    values, and token-based Blue Steel active styling.

## Validation matrix

- Static review: inspect the complete diff for meaning changes, parallel list
  grammar, duplicate claims, `work order`, and em dash characters.
- Focused tests: run public navigation/docs-related unit tests plus any MCP
  catalog tests affected by rendering imports. Add deterministic tests for
  downward and upward section selection, final-section behavior, valid hash
  initialization, and invalid hash fallback.
- Quality gates: run TypeScript checking, lint on the changed files if
  supported, and the repository build. Record exact commands and exit codes.
- Browser: seed the normal dev/test environment, pin an available port from
  3000-3014, and open `/docs` and `/docs/mcp` through the sandbox reviewer.
  Check 375px, 768px, and 1280px layouts, every sidebar anchor, keyboard focus,
  click activation, bidirectional scroll activation, final-section activation,
  `aria-current` uniqueness, product/MCP links, CTAs, support links, page and
  code-block overflow, console errors, and the generated tool list.
- Graph: after the TypeScript edits, run `npx graphify hook-rebuild`, then
  `graphify portable-check .graphify` before including any graph artifacts.

## Execution handoff

Read `AGENTS.md`, `docs/agents/AGENTS-akhil.md`, this plan,
`docs/agents/mcp-api.md`, `docs/website-component-standard.md`, and the relevant
Next.js App Router guides under `node_modules/next/dist/docs/`. Confirm the
branch and HEAD have not drifted. Implement and validate the rewrite in this
pooled worktree. Preserve the plan as a durable artifact and return a handoff
with changed files, decisions, word-count evidence, exact command exit codes,
browser evidence, remaining risks, and the current HEAD.
