import "server-only";

import type { RedditThread } from "./types";

export const REDDIT_SUBREDDITS = ["Landlord", "realestateinvesting", "propertymanagement"] as const;
export const REDDIT_KEYWORDS = [
  "rent collection",
  "tenant screening",
  "maintenance request",
  "late rent",
  "lease renewal",
  "property manager",
  "landlord software",
  "roommates",
  "room rental",
] as const;
export const REDDIT_MAX_AGE_DAYS = 7;
export const REDDIT_MIN_UPS = 3;
const USER_AGENT = "PropLane growth/1.0";

type RawChild = { data?: Record<string, unknown> };

/** Pure: turn a Reddit search listing into filtered threads (fresh, SFW, at least REDDIT_MIN_UPS upvotes). */
export function parseRedditListing(json: unknown, nowMs: number = Date.now()): RedditThread[] {
  const children = (json as { data?: { children?: RawChild[] } } | null)?.data?.children;
  if (!Array.isArray(children)) return [];
  const out: RedditThread[] = [];
  for (const c of children) {
    const d = c?.data;
    if (!d || typeof d.id !== "string" || typeof d.title !== "string") continue;
    const createdUtc = Number(d.created_utc ?? 0);
    const ups = Number(d.ups ?? d.score ?? 0);
    if (d.over_18 === true) continue;
    if (!createdUtc || nowMs - createdUtc * 1000 > REDDIT_MAX_AGE_DAYS * 86_400_000) continue;
    if (ups < REDDIT_MIN_UPS) continue;
    const permalink = typeof d.permalink === "string" ? d.permalink : null;
    if (!permalink) continue;
    out.push({
      id: d.id,
      title: d.title,
      url: `https://www.reddit.com${permalink}`,
      subreddit: typeof d.subreddit === "string" ? d.subreddit : "",
      ups,
      numComments: Number(d.num_comments ?? 0),
      createdUtc,
      selftext: typeof d.selftext === "string" ? d.selftext.slice(0, 600) : "",
    });
  }
  return out;
}

/**
 * Read-only public search, no auth, no posting. One search per subreddit (all keywords OR'd into a single
 * query) so a run makes 3 requests total; results are deduped by thread id and sorted by engagement.
 */
export async function fetchRedditThreads(
  fetchImpl: typeof fetch = fetch,
  nowMs: number = Date.now(),
  subreddits: readonly string[] = REDDIT_SUBREDDITS,
  keywords: readonly string[] = REDDIT_KEYWORDS,
): Promise<RedditThread[]> {
  const q = keywords.map((k) => `"${k}"`).join(" OR ");
  const seen = new Map<string, RedditThread>();
  for (const sub of subreddits) {
    const url = `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(q)}&restrict_sr=1&sort=new&t=week&limit=50`;
    try {
      const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
      if (!res.ok) {
        console.warn(`growth-engage: reddit r/${sub} responded ${res.status}`);
        continue;
      }
      for (const t of parseRedditListing(await res.json(), nowMs)) if (!seen.has(t.id)) seen.set(t.id, t);
    } catch (e) {
      console.warn(`growth-engage: reddit r/${sub} failed: ${e instanceof Error ? e.message : "error"}`);
    }
  }
  return [...seen.values()].sort((a, b) => b.ups + b.numComments * 2 - (a.ups + a.numComments * 2));
}
