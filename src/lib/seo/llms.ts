import { PRODUCTION_APP_ORIGIN } from "@/lib/app-url";
import { RATE_CARD, formatRateCardUsd } from "@/lib/billing/rate-card";
import { BLOG_POSTS, formatBlogDate, type BlogPost } from "@/lib/blog/posts";

/**
 * Plain-text site maps for AI assistants (llmstxt.org). Facts come from the
 * same modules the marketing pages read (rate card, blog posts); nothing here
 * is a number of its own.
 */

/** Canonical origin for absolute URLs: configured canonical, else a real public app URL, else production. */
export function llmsOrigin(env: NodeJS.ProcessEnv = process.env): string {
  for (const raw of [env.NEXT_PUBLIC_CANONICAL_APP_URL, env.NEXT_PUBLIC_APP_URL]) {
    const value = raw?.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.hostname.endsWith(".vercel.app")) continue;
      return url.origin;
    } catch {
      /* try the next candidate */
    }
  }
  return PRODUCTION_APP_ORIGIN;
}

const usd = formatRateCardUsd;

export const LLMS_SUMMARY =
  `PropLane is property management software for shared houses and room rentals. ` +
  `It runs listings, applications, tours, leases, rent collection and payments, bookings (including Airbnb calendar sync), ` +
  `a work phone number and work email for each workspace, and separate resident and vendor portals, with an AI assistant ` +
  `that drafts work and never sends without the manager's approval. Built in Seattle. ` +
  `Pricing: Free for ${RATE_CARD.free.includedDoors} residents, Pro at ${usd(RATE_CARD.pro.floorMonthlyCents)}/month ` +
  `(${RATE_CARD.pro.includedDoors} residents included), Business at ${usd(RATE_CARD.business.floorMonthlyCents)}/month ` +
  `(${RATE_CARD.business.includedDoors} residents included); 14-day trial on paid plans, no card required.`;

type Entry = { title: string; path: string; note: string };

const DOCS: Entry[] = [
  { title: "Docs", path: "/docs", note: "How to manage applications, leases, rent, services, books, documents and your team." },
  { title: "MCP server and API", path: "/docs/mcp", note: "Connect an AI agent to PropLane with browser-authorized MCP or a scoped REST API key." },
];

const PRODUCT: Entry[] = [
  { title: "Home", path: "/", note: "What PropLane does, from first tour to fixed faucet." },
  { title: "Why PropLane", path: "/why-proplane", note: "The AI assistant does the relaying between residents, vendors and owners; you approve what matters." },
  { title: "For managers and landlords", path: "/partner", note: "List, screen, lease and collect from one queue on web and iPhone." },
  { title: "Vendors", path: "/vendors", note: "Get matched to jobs by text, bid from your phone, and get paid through PropLane." },
  { title: "PropLane for iPhone", path: "/app", note: "The approval queue on your phone." },
  { title: "Browse homes", path: "/rent/browse", note: "Public rental listings on PropLane." },
  { title: "Security", path: "/security", note: "How resident, applicant and property data is protected." },
];

const PRICING: Entry[] = [
  { title: "Pricing", path: "/pricing", note: `Free for ${RATE_CARD.free.includedDoors} residents; Pro ${usd(RATE_CARD.pro.floorMonthlyCents)}/mo; Business ${usd(RATE_CARD.business.floorMonthlyCents)}/mo.` },
];

const OPTIONAL: Entry[] = [
  { title: "About", path: "/about", note: "Built by property managers in Seattle who run their own rentals on it." },
  { title: "Contact", path: "/contact", note: "Talk to the team or book a demo." },
  { title: "Support", path: "/support", note: "Help for residents and property managers." },
  { title: "Reviews", path: "/reviews", note: "Reviews from managers, residents and vendors, with their permission." },
  { title: "Privacy Policy", path: "/privacy", note: "How information is collected, used and protected." },
  { title: "Terms of Service", path: "/tos", note: "Terms governing use of PropLane." },
];

function section(origin: string, heading: string, entries: Entry[]): string {
  const lines = entries.map((e) => `- [${e.title}](${origin}${e.path === "/" ? "/" : e.path}): ${e.note}`);
  return `## ${heading}\n\n${lines.join("\n")}\n`;
}

function header(): string {
  return `# PropLane\n\n> ${LLMS_SUMMARY}\n`;
}

export function buildLlmsTxt(origin: string = llmsOrigin(), posts: readonly BlogPost[] = BLOG_POSTS): string {
  const blog: Entry[] = [
    { title: "Blog", path: "/blog", note: "Research-backed notes on running rentals; every figure cites its source." },
    ...posts.map((p) => ({ title: p.title, path: `/blog/${p.slug}`, note: p.description })),
  ];
  return [
    header(),
    section(origin, "Docs", DOCS),
    section(origin, "Product", PRODUCT),
    section(origin, "Pricing", PRICING),
    section(origin, "Blog", blog),
    section(origin, "Optional", OPTIONAL),
  ].join("\n");
}

/** Markdown reduced to plain text: inline links keep their label, emphasis marks drop. */
export function toPlainText(input: string): string {
  return input
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/[*_`#>]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function blogPostText(origin: string, post: BlogPost): string {
  const out: string[] = [`### ${post.title}`, `${origin}/blog/${post.slug} (${formatBlogDate(post.date)}, ${post.category})`, "", toPlainText(post.description), ""];
  for (const s of post.sections) {
    if (s.heading) out.push(toPlainText(s.heading), "");
    for (const p of s.paragraphs) out.push(toPlainText(p), "");
  }
  if (post.stats.length) {
    out.push("Figures:");
    for (const st of post.stats) {
      const src = post.sources[st.sourceIndex];
      out.push(`- ${st.value} ${st.label}${src ? ` (source: ${src.publisher}, ${src.title}, ${src.year}, ${src.url})` : ""}`);
    }
    out.push("");
  }
  out.push("Sources:");
  for (const src of post.sources) out.push(`- ${src.title}, ${src.publisher}, ${src.year}: ${src.url}`);
  return out.join("\n");
}

export function buildLlmsFullTxt(origin: string = llmsOrigin(), posts: readonly BlogPost[] = BLOG_POSTS): string {
  const pages = [...DOCS, ...PRODUCT, ...PRICING, ...OPTIONAL]
    .map((e) => `### ${e.title}\n${origin}${e.path}\n\n${e.note}\n`)
    .join("\n");
  const plans =
    `### Plans\n\n` +
    `- Free: $0, ${RATE_CARD.free.includedDoors} residents, applications, tours and rent collection.\n` +
    `- Pro: ${usd(RATE_CARD.pro.floorMonthlyCents)}/month, ${RATE_CARD.pro.includedDoors} residents included, then ${usd(RATE_CARD.pro.perExtraDoorMonthlyCents ?? 0)} per extra resident.\n` +
    `- Business: ${usd(RATE_CARD.business.floorMonthlyCents)}/month, ${RATE_CARD.business.includedDoors} residents included, then ${usd(RATE_CARD.business.perExtraDoorMonthlyCents ?? 0)} per extra resident.\n` +
    `- Annual billing is two months free. Paid plans have a 14-day trial with no card required.\n`;
  return [
    header(),
    `## Pages\n\n${pages}`,
    `## Pricing\n\n${plans}`,
    `## Blog\n\n${posts.map((p) => blogPostText(origin, p)).join("\n\n")}\n`,
  ].join("\n");
}

export const LLMS_CACHE_CONTROL = "public, max-age=3600, s-maxage=3600";
