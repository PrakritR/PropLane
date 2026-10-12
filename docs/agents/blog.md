# The public blog (`/blog`)

Authoritative copy for the public blog: what a post may claim, how a post is
shaped, and how the pages are served. Read it before adding or editing a post.

Code: `src/lib/blog/posts.ts` (the posts),
`src/components/marketing/blog/inline-text.tsx` (`renderInline`),
`src/app/(public)/blog/page.tsx` + `src/app/(public)/blog/[slug]/page.tsx`.
Guards: `tests/unit/blog-posts.test.ts`, `tests/unit/blog-pages.test.tsx`,
`tests/unit/blog-sitemap.test.ts`.

## Editorial contract — a number is quoted as its source states it

- **Every figure is quoted as its source states it, and the sentence names the
  source.** A vendor survey is called a vendor survey in the sentence that uses
  it; no number is laundered into "research shows".
- **One source per claim**, and **every stat tile points at a source** whose URL
  is `https://`. `BlogStat.sourceIndex` is the index into the post's own
  `sources`, rendered as the `#source-N` footnote link.
- **The 2021 and 2024 Rental Housing Finance Surveys are never blended.** These
  posts use 2021 only; the 2024 figures are deliberately absent.
- **Nothing is attributed to NARPM that NARPM did not publish.**
- **At most one sentence names PropLane**, it sits in the last section, and it
  links to `/`. The blog is not a product page.
- Voice: no exclamation marks, no emoji, and the product vocabulary rule holds —
  it is a "service", never a "work order" (root `AGENTS.md`).

## Shape of a post

- Posts are typed data in one file, newest first, no CMS. Slugs are kebab-case
  and unique; dates are ISO `yyyy-mm-dd` and the list stays sorted by them.
- At least three sources (title, publisher, year ≥ 2019, unique https URL) and
  at least three stat tiles.
- 900–1,300 words of body, ending on a **"What to do about it"** section.
- `description` is the meta description, 200 characters or fewer.
- The only inline markup inside a paragraph is `[label](/path)`, read only by
  `renderInline`; today the one allowed target is `/`.

## Serving the pages

- Index and posts are `force-static` with `dynamicParams = false`:
  `generateStaticParams` prerenders one page per post and any other slug 404s.
- Each post page sets its own canonical and `article` OpenGraph metadata.
- `src/app/sitemap.ts` lists `/blog` plus one entry per post. A post's date may
  be ahead of today (staggered publish calendar), so a post's `lastModified` is
  clamped to now — crawlers distrust a future `lastmod`.
- The blog is reachable from the public navbar Resources menu and the footer.
