import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SITE_MEASURE, SiteEyebrow, SiteHeading } from "@/components/marketing/site/primitives";
import { SitePage } from "@/components/marketing/site/site-page";
import { renderInline } from "@/components/marketing/blog/inline-text";
import { BLOG_POSTS, formatBlogDate, getBlogPost } from "@/lib/blog/posts";
import { cn } from "@/lib/utils";

/** Every post is prerendered; an unknown slug is a 404, never rendered on demand. */
export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return BLOG_POSTS.map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const post = getBlogPost(slug);
  if (!post) return {};
  return {
    title: post.title,
    description: post.description,
    alternates: { canonical: `/blog/${post.slug}` },
    openGraph: {
      type: "article",
      url: `https://proplane.ai/blog/${post.slug}`,
      siteName: "PropLane",
      title: post.title,
      description: post.description,
      publishedTime: post.date,
    },
  };
}

const CARD = "rounded-2xl border border-[var(--site-line,#dbe4ef)] bg-white/85 shadow-[0_18px_44px_-30px_rgba(19,43,71,0.3)]";

function BackLink({ className }: { className?: string }) {
  return (
    <Link href="/blog" data-attr="blog-back" className={cn("text-[14px] font-bold text-primary", className)}>
      ← All posts
    </Link>
  );
}

export default async function BlogPostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = getBlogPost(slug);
  if (!post) notFound();

  return (
    <SitePage>
      <article className={cn(SITE_MEASURE, "pb-16 pt-10 sm:pb-20 sm:pt-14 lg:pb-24")}>
        <div className="mx-auto max-w-[44rem]">
          <BackLink />
          <header className="mt-8">
            <SiteEyebrow>{post.category}</SiteEyebrow>
            <SiteHeading as="h1" id="post-title" className="mt-3 text-[clamp(2rem,4.6vw,3.2rem)] leading-[1.1]">
              {post.title}
            </SiteHeading>
            <p className="mt-4 text-[14px] text-muted">
              <time dateTime={post.date}>{formatBlogDate(post.date)}</time>
              <span aria-hidden> · </span>
              {post.readMinutes} min read
            </p>
          </header>
        </div>

        <ul
          aria-label="Key figures"
          className="mx-auto mt-10 grid max-w-[64rem] grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4"
        >
          {post.stats.map((stat, i) => (
            <li key={`${stat.value}-${i}`} className={cn(CARD, "flex flex-col p-4 sm:p-5")}>
              <p className="site-display text-[clamp(1.5rem,3vw,2.1rem)] font-bold leading-none tracking-tight text-[color:var(--site-ink,#17181a)]">
                {stat.value}
              </p>
              <p className="mt-2 flex-1 text-[13.5px] leading-snug text-muted">{stat.label}</p>
              <a
                href={`#source-${stat.sourceIndex + 1}`}
                className="mt-3 text-[12px] font-bold text-primary"
                aria-label={`Source ${stat.sourceIndex + 1}: ${post.sources[stat.sourceIndex]?.publisher ?? ""}`}
              >
                Source {stat.sourceIndex + 1}
              </a>
            </li>
          ))}
        </ul>

        <div className="mx-auto mt-12 max-w-[44rem]">
          {post.sections.map((section, i) => (
            <section key={section.heading ?? `s-${i}`} className={i === 0 ? undefined : "mt-10"}>
              {section.heading ? (
                <h2 className="site-display mb-4 text-[clamp(1.4rem,2.4vw,1.8rem)] font-bold leading-snug tracking-tight text-[color:var(--site-ink,#17181a)]">
                  {section.heading}
                </h2>
              ) : null}
              <div className="space-y-4">
                {section.paragraphs.map((paragraph, j) => (
                  <p key={j} className="text-[16.5px] leading-[1.75] text-foreground">
                    {renderInline(paragraph)}
                  </p>
                ))}
              </div>
            </section>
          ))}

          <section aria-labelledby="sources-title" className="mt-14 border-t border-[#c9d8e9] pt-8">
            <h2
              id="sources-title"
              className="site-display text-[clamp(1.4rem,2.4vw,1.8rem)] font-bold leading-snug tracking-tight text-[color:var(--site-ink,#17181a)]"
            >
              Sources
            </h2>
            <ol className="mt-5 space-y-4">
              {post.sources.map((source, i) => (
                <li
                  key={source.url}
                  id={`source-${i + 1}`}
                  className="grid scroll-mt-24 grid-cols-[1.75rem_minmax(0,1fr)] gap-x-2 text-[14.5px] leading-relaxed text-muted"
                >
                  <span className="font-bold text-foreground">{i + 1}.</span>
                  <span className="min-w-0">
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold text-primary underline underline-offset-2 [overflow-wrap:anywhere]"
                    >
                      {source.title}
                    </a>
                    <span className="block">
                      {source.publisher}, {source.year}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <BackLink className="mt-12 inline-block" />
        </div>
      </article>
    </SitePage>
  );
}
