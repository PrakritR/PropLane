> This file is the source of truth for its area — READ IT BEFORE changing code
> in this area.

# AI search visibility (`/llms.txt`, robots, sitemap, JSON-LD)

What PropLane hands a search engine or an AI assistant that crawls the public
site. It owns the four public crawl surfaces below and nothing else — which
hosts may be crawled at all is owned by
[`deployment-workflow.md`](deployment-workflow.md) § Search indexing, what a
public listing payload may contain by
[`lease-generation.md`](lease-generation.md) § Part 1, and what a blog post may
claim by [`blog.md`](blog.md).

Code: `src/lib/seo/llms.ts` (the plain-text site maps), `src/lib/seo/json-ld.ts`
(structured data), `src/lib/seo/public-catalog.server.ts` (the shared catalog
read), `src/app/llms.txt/route.ts`, `src/app/llms-full.txt/route.ts`,
`src/app/robots.ts`, `src/app/sitemap.ts`.
Guards: `tests/unit/llms-txt.test.ts`, `tests/unit/robots-ai-bots.test.ts`,
`tests/unit/robots-route.test.ts`, `tests/unit/blog-sitemap.test.ts`,
`tests/unit/crawl-public-catalog.test.ts`,
`tests/unit/evidence-ai-search-1013.test.ts`.

## Never a second copy of a fact

Everything these surfaces publish is **derived** from the module that already
owns it: plan prices and included-resident counts from `RATE_CARD`
(`src/lib/billing/rate-card.ts`), the annual floors and their saving from the
same card via `annualDiscountPercent` (never a restated "two months free"), the
trial length from `MANAGER_SUBSCRIPTION_TRIAL_DAYS`, posts from `BLOG_POSTS`,
listing facts from `publicListingProjection`'s output, the App Store link from
`iosAppDownloadUrl()`. A number typed into `llms.ts` or `json-ld.ts` by hand is
a drift bug — an AI assistant quoting a stale price is the whole failure mode
this rule exists for. `LLMS_SUMMARY` is the one product summary, reused as the
`SoftwareApplication` description.

## `/llms.txt` and `/llms-full.txt`

llmstxt.org shape: `# PropLane`, a `>` summary, then `## Docs · Product ·
Pricing · Blog · Optional` sections of `- [Title](absolute url): note` lines.
`/llms-full.txt` is the same pages plus the plan sheet and **every blog post as
plain text**, figures with their source, and each post's full source list —
`toPlainText` strips markup but keeps a link's label, so no half-rendered
markdown reaches a reader. It drops `<` and `>` as characters and never matches
`<...>` as a tag: a tag-shaped regex needs the closing `>`, so an unterminated
`<script src=x` would survive it (that is the whole point of CodeQL's
js/incomplete-multi-character-sanitization).

Both are `text/plain; charset=utf-8`, `revalidate = 3600` with
`LLMS_CACHE_CONTROL` on the response, and need no database, so neither can fail
a crawl. Links are absolute on `llmsOrigin()`: the configured canonical app URL,
else a real public app URL, else `PRODUCTION_APP_ORIGIN` — a `*.vercel.app`
candidate is skipped so a preview build never advertises itself.

## `robots.txt` — AI crawlers are named, not implied

`PRIVATE_PATHS` (`/portal/ /resident/ /vendor/ /admin/ /api/ /auth/ /invite/
/mcp/`) is disallowed in **every** rule the canonical host serves. There are two
of them: `*`, and `AI_CRAWLERS` listed one by one (GPTBot, ChatGPT-User,
OAI-SearchBot, ClaudeBot, anthropic-ai, PerplexityBot, Google-Extended). The
named rule is redundant with `*` today on purpose: it states the intent
explicitly and survives a future narrowing of `*`. Adding a crawler means
adding it to `AI_CRAWLERS`, never writing a third rule. Non-canonical hosts
still serve `Disallow: /` (see deployment-workflow § Search indexing).

## `sitemap.xml` carries the live listings

Static marketing paths, `/blog` plus one entry per post (clamped `lastModified`
— blog.md § Serving the pages), and **one URL per live public listing** read
through `getCrawlPublicListings()`. A catalog failure is caught: the sitemap
still lists every static page rather than 500ing a crawl. Its URLs are built on
its own `BASE` (the canonical production host), not `llmsOrigin()`: every
non-canonical host is `Disallow: /` wholesale (deployment-workflow § Search
indexing), so the only URLs worth advertising are canonical ones.

## JSON-LD

- Home (`src/app/(public)/page.tsx`): one `@graph` with `Organization` and
  `SoftwareApplication`, three `Offer`s built from the rate card. `sameAs`
  carries only a profile PropLane owns and the repo can prove: `proplaneSameAs`
  accepts an `apps.apple.com` URL and nothing else, so a TestFlight override of
  the download link publishes no `sameAs` rather than a wrong one.
- Public listing page: one `Accommodation` built by `listingJsonLd` from the
  **public projection only**. Every optional fact is emitted only when the
  stored blob actually has it and of the right type: publishing `petsAllowed:
  false` off an unanswered question is a fabricated listing fact, the same rule
  as never fabricating a photo. `addressLocality` is the submission's legal
  `city` — never the browse-only `neighborhood` label — and `streetAddress` is
  the street line alone (`listingSubmissionStreetLine`, the decision leases
  already use), because the stored address normally ends in its own ", City, ST
  ZIP" and a crawler must not read the locality twice. A page whose catalog read
  fails renders with no structured data at all.
- Both serialize through `jsonLdString`, which escapes `<` so no field can close
  the `<script>` tag.

## One catalog read an hour, shared

`getCrawlPublicListings()` (`public-catalog.server.ts`) memoizes
`getPublicListings()` for an hour with an in-flight guard, because the sitemap
advertises every listing URL and a crawl would otherwise pay that 500-row read
plus its per-manager send-number, work-email, profile, workspace-settings and
pipeline resolutions once per page — unbounded Supabase egress on the free
plan. The TTL matches the `revalidate = 3600` the sitemap and the listing page
already declare, so nothing is served staler than its own ISR window, and a
failed read is never cached.
