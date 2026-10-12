import type { Metadata } from "next";
import Link from "next/link";
import { SitePageHero, SiteSection } from "@/components/marketing/site/primitives";
import { SitePage } from "@/components/marketing/site/site-page";
import { BLOG_POSTS, formatBlogDate } from "@/lib/blog/posts";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: { absolute: "The PropLane blog" },
  description:
    "Plain-language notes on where a property manager's time and money go, with every number tied to its source.",
  alternates: { canonical: "/blog" },
  openGraph: {
    type: "website",
    url: "https://proplane.ai/blog",
    siteName: "PropLane",
    title: "The PropLane blog",
    description:
      "Plain-language notes on where a property manager's time and money go, with every number tied to its source.",
  },
};

/** Prerendered at build; nothing on this page reads a request. */
export const dynamic = "force-static";

const CARD = "rounded-2xl border border-[var(--site-line,#dbe4ef)] bg-white/85 shadow-[0_18px_44px_-30px_rgba(19,43,71,0.3)]";

export default function BlogIndexPage() {
  return (
    <SitePage>
      <SitePageHero
        id="blog-title"
        eyebrow="Blog"
        title="The PropLane blog"
        lede="Where a property manager's time and money go, with every number tied to its source."
      />
      <SiteSection ariaLabel="Posts" className="pt-0 sm:pt-0 lg:pt-0">
        <ul className="mx-auto grid max-w-[64rem] gap-5 md:grid-cols-2">
          {BLOG_POSTS.map((post) => (
            <li key={post.slug}>
              <Link
                href={`/blog/${post.slug}`}
                data-attr={`blog-card-${post.slug}`}
                className={cn(
                  CARD,
                  "flex h-full flex-col p-6 transition-[border-color,transform] duration-100 hover:-translate-y-0.5 hover:border-[#8fb0d4] sm:p-7",
                )}
              >
                <p className="text-[12px] font-extrabold uppercase tracking-[0.16em] text-[color:var(--site-accent,#2863f0)]">
                  {post.category}
                </p>
                <h2 className="site-display mt-3 flex-1 text-[22px] font-bold leading-snug tracking-tight text-[color:var(--site-ink,#17181a)]">
                  {post.title}
                </h2>
                <p className="mt-5 text-[13.5px] text-muted">
                  <time dateTime={post.date}>{formatBlogDate(post.date)}</time>
                  <span aria-hidden> · </span>
                  {post.readMinutes} min read
                </p>
              </Link>
            </li>
          ))}
        </ul>
      </SiteSection>
    </SitePage>
  );
}
