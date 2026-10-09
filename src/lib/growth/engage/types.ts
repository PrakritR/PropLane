export const ENGAGE_PLATFORMS = ["instagram", "tiktok", "linkedin", "youtube", "x", "reddit", "facebook"] as const;
export type EngagePlatform = (typeof ENGAGE_PLATFORMS)[number];
export const WATCH_KINDS = ["engage", "follow", "collab"] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];
export const ENGAGE_STATUSES = ["open", "done", "skipped"] as const;
export type EngageStatus = (typeof ENGAGE_STATUSES)[number];

export type WatchlistEntry = {
  id: string;
  platform: EngagePlatform;
  handle: string;
  url: string | null;
  topic: string | null;
  kind: WatchKind;
  notes: string | null;
  active: boolean;
  createdAt: string;
};

export type EngageItem = {
  id: string;
  forDate: string;
  source: "reddit" | "watchlist" | "manual";
  platform: string;
  target: string;
  url: string;
  why: string | null;
  draft: string | null;
  status: EngageStatus;
  evidence: Record<string, unknown>;
  createdAt: string;
};

export type GrowthKeyword = { id: string; keyword: string; reply: string | null; link: string | null; active: boolean; createdAt: string };

export type RedditThread = {
  id: string;
  title: string;
  url: string;
  subreddit: string;
  ups: number;
  numComments: number;
  createdUtc: number;
  selftext: string;
};
