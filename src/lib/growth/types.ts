/**
 * Growth engine — shared types (the build contract).
 *
 * PropLane's own social content pipeline: ideas → Claude drafts → (assets/render) →
 * admin review → scheduled publish → insights → learned lines. Admin-only; never
 * touches customer data. See docs/agents/growth-engine.md.
 */

export const GROWTH_PLATFORMS = ["instagram", "tiktok", "youtube", "linkedin", "x", "threads", "facebook"] as const;
export type GrowthPlatform = (typeof GROWTH_PLATFORMS)[number];

export const GROWTH_FORMATS = ["reel", "carousel", "image", "text"] as const;
export type GrowthFormat = (typeof GROWTH_FORMATS)[number];

export const GROWTH_ANGLES = ["positioning", "feature", "tips", "local", "founder"] as const;
export type GrowthAngle = (typeof GROWTH_ANGLES)[number];

/** Post lifecycle. Transitions are enforced in src/lib/growth/post-state.ts. */
export const GROWTH_POST_STATUSES = [
  "idea",
  "drafted",
  "review",
  "approved",
  "scheduled",
  "publishing",
  "published",
  "failed",
  "archived",
] as const;
export type GrowthPostStatus = (typeof GROWTH_POST_STATUSES)[number];

/** Formats the renderer produces media for; `text` has none. */
export const RENDER_FORMATS: GrowthFormat[] = ["reel", "carousel", "image"];
/** The statuses the nightly `--pending` render run looks at, so a studio request is never silently dropped. */
export const RENDER_STATUSES: GrowthPostStatus[] = ["review", "approved", "scheduled"];

export const GROWTH_PUBLICATION_STATUSES = ["pending", "published", "failed", "paused"] as const;
export type GrowthPublicationStatus = (typeof GROWTH_PUBLICATION_STATUSES)[number];

/** Which code path publishes. `log` writes to the DB only (proofs, local dev, no keys). */
export const GROWTH_PUBLISHER_IDS = ["log", "late", "upload_post", "meta"] as const;
export type GrowthPublisherId = (typeof GROWTH_PUBLISHER_IDS)[number];

export type GrowthScene = {
  /**
   * Stable id for this scene, minted by `sceneListSchema` / `newSceneId` and kept across edits.
   * Assets are keyed on it (`meta.sceneId`), so removing a scene never re-points another's media.
   * Optional only for rows saved before ids existed; those fall back to `index`.
   */
  id?: string;
  index: number;
  /** generated = AI video; template = Remotion-only; shot = Playwright product recording; still = image card */
  kind: "generated" | "template" | "shot" | "still";
  startMs: number;
  endMs: number;
  /** On-screen caption text for this scene. */
  text: string;
  /** Generation prompt (generated) or recording target (shot: route + action), free text in Phase 1. */
  direction: string;
};

export type GrowthCaptions = Partial<Record<GrowthPlatform, string>>;

export type GrowthIdea = {
  id: string;
  title: string;
  angle: GrowthAngle;
  format: GrowthFormat;
  notes: string | null;
  /** Re-weighted nightly by the learn step. 1 = neutral. */
  weight: number;
  source: "seed" | "learned" | "manual";
  usedCount: number;
  createdAt: string;
  updatedAt: string;
};

export type GrowthPost = {
  id: string;
  ideaId: string | null;
  status: GrowthPostStatus;
  format: GrowthFormat;
  title: string;
  hook: string | null;
  script: string | null;
  scenes: GrowthScene[];
  captions: GrowthCaptions;
  platforms: GrowthPlatform[];
  scheduledFor: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  publishedAt: string | null;
  createdBy: "claude" | "admin";
  reviewNote: string | null;
  /** The learned line(s) that shaped this draft, for the Analytics tab. */
  learnedFrom: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GrowthAsset = {
  id: string;
  postId: string;
  kind: "image" | "video" | "voice" | "clip" | "shot";
  storagePath: string;
  publicUrl: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  meta: Record<string, unknown>;
  createdAt: string;
};

export type GrowthAccount = {
  id: string;
  platform: GrowthPlatform;
  handle: string;
  publisher: GrowthPublisherId;
  /** The vendor's account/profile id (Late profile id, Meta IG account id, ...). Never a token. */
  vendorAccountId: string | null;
  status: "connected" | "expiring" | "disconnected" | "paused";
  tokenExpiresAt: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type GrowthPublication = {
  id: string;
  postId: string;
  platform: GrowthPlatform;
  accountId: string | null;
  status: GrowthPublicationStatus;
  publisher: GrowthPublisherId;
  vendorPostId: string | null;
  platformPostId: string | null;
  platformUrl: string | null;
  error: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  publishedAt: string | null;
};

export type GrowthMetric = {
  id: string;
  publicationId: string;
  capturedAt: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  followersSnapshot: number | null;
  raw: Record<string, unknown>;
};

export type GrowthLearned = {
  id: string;
  line: string;
  evidence: Record<string, unknown>;
  createdAt: string;
};

/** Input to a publisher driver. Media are public URLs (Supabase storage, public bucket `growth`). */
export type PublishInput = {
  post: GrowthPost;
  platform: GrowthPlatform;
  account: GrowthAccount;
  caption: string;
  media: Array<{ url: string; kind: "image" | "video"; width?: number | null; height?: number | null }>;
};

export type PublishResult =
  | { ok: true; vendorPostId: string | null; platformPostId: string | null; platformUrl: string | null }
  | { ok: false; error: string; retryable: boolean };

export interface GrowthPublisher {
  id: GrowthPublisherId;
  publish(input: PublishInput): Promise<PublishResult>;
  /** Optional: pull metrics for published items. */
  fetchMetrics?(pubs: GrowthPublication[]): Promise<Array<Omit<GrowthMetric, "id">>>;
}

/** What Claude must return from the draft step. Parsed and validated in draft.server.ts. */
export type DraftOutput = {
  title: string;
  hook: string;
  script: string;
  scenes: GrowthScene[];
  captions: GrowthCaptions;
  platforms: GrowthPlatform[];
};
