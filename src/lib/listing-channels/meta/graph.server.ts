import "server-only";

import { resolveShareableAppOrigin } from "@/lib/app-url";

/**
 * Thin client for Meta's Graph API. Official endpoints only: the OAuth dialog, the token exchange,
 * Page photo posts and Instagram Content Publishing. No scraping, no headless browser.
 */
export const META_OAUTH_SCOPES = [
  "pages_manage_posts",
  "pages_read_engagement",
  "pages_show_list",
  "instagram_basic",
  "instagram_content_publish",
] as const;

export function metaGraphVersion(): string {
  return process.env.META_GRAPH_VERSION?.trim() || "v21.0";
}

export function metaAppCredentials(): { appId: string; appSecret: string } | null {
  const appId = process.env.META_APP_ID?.trim();
  const appSecret = process.env.META_APP_SECRET?.trim();
  return appId && appSecret ? { appId, appSecret } : null;
}

/** The redirect URI registered in the Meta app: this deployment's own callback (override for local dev). */
export function metaRedirectUri(requestOrigin: string): string {
  const override = process.env.META_REDIRECT_ORIGIN?.trim().replace(/\/$/, "");
  return `${override || resolveShareableAppOrigin(requestOrigin).replace(/\/$/, "")}/api/integrations/meta/callback`;
}

export class MetaGraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null,
  ) {
    super(message);
    this.name = "MetaGraphError";
  }

  /** A revoked or expired token: retrying will not help; the manager has to reconnect. */
  get needsReconnect(): boolean {
    return this.code === 190 || this.code === 102 || this.status === 401;
  }
}

type GraphParams = Record<string, string | undefined>;

async function graph<T>(method: "GET" | "POST" | "DELETE", path: string, params: GraphParams): Promise<T> {
  const url = new URL(`https://graph.facebook.com/${metaGraphVersion()}/${path.replace(/^\//, "")}`);
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (method === "GET") url.searchParams.set(key, value);
    else body.set(key, value);
  }
  const res = await fetch(url, {
    method,
    ...(method === "GET" ? {} : { body, headers: { "Content-Type": "application/x-www-form-urlencoded" } }),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number } } & Record<string, unknown>;
  if (!res.ok || json.error) {
    throw new MetaGraphError(json.error?.message ?? `Meta Graph API ${res.status}`, res.status, json.error?.code ?? null);
  }
  return json as T;
}

export function buildMetaOAuthDialogUrl(args: { appId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: args.appId,
    redirect_uri: args.redirectUri,
    state: args.state,
    response_type: "code",
    scope: META_OAUTH_SCOPES.join(","),
  });
  return `https://www.facebook.com/${metaGraphVersion()}/dialog/oauth?${params.toString()}`;
}

export async function exchangeMetaCode(args: { code: string; redirectUri: string }): Promise<string> {
  const creds = metaAppCredentials();
  if (!creds) throw new MetaGraphError("Meta is not configured.", 503, null);
  const short = await graph<{ access_token: string }>("GET", "oauth/access_token", {
    client_id: creds.appId,
    client_secret: creds.appSecret,
    redirect_uri: args.redirectUri,
    code: args.code,
  });
  const long = await graph<{ access_token: string }>("GET", "oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: creds.appId,
    client_secret: creds.appSecret,
    fb_exchange_token: short.access_token,
  });
  return long.access_token;
}

export type MetaManagedPage = {
  id: string;
  name: string;
  accessToken: string;
  igAccountId: string | null;
  igUsername: string | null;
};

export async function fetchMetaIdentity(userToken: string): Promise<{ id: string; name: string }> {
  const me = await graph<{ id: string; name?: string }>("GET", "me", { fields: "id,name", access_token: userToken });
  return { id: me.id, name: me.name ?? "" };
}

/** Pages the person manages, each with its own (non-expiring, when derived from a long-lived user token) token. */
export async function fetchMetaManagedPages(userToken: string): Promise<MetaManagedPage[]> {
  const res = await graph<{
    data?: { id: string; name: string; access_token: string; instagram_business_account?: { id: string; username?: string } }[];
  }>("GET", "me/accounts", {
    fields: "id,name,access_token,instagram_business_account{id,username}",
    access_token: userToken,
  });
  return (res.data ?? []).map((page) => ({
    id: page.id,
    name: page.name,
    accessToken: page.access_token,
    igAccountId: page.instagram_business_account?.id ?? null,
    igUsername: page.instagram_business_account?.username ?? null,
  }));
}

/** A photo post with the listing text as its caption: `POST /{page-id}/photos`. Returns the post id. */
export async function publishMetaPagePhoto(args: { pageId: string; token: string; photoUrl: string; caption: string }): Promise<string> {
  const res = await graph<{ id: string; post_id?: string }>("POST", `${args.pageId}/photos`, {
    url: args.photoUrl,
    caption: args.caption,
    published: "true",
    access_token: args.token,
  });
  return res.post_id ?? res.id;
}

export async function deleteMetaPost(args: { postId: string; token: string }): Promise<void> {
  await graph<{ success?: boolean }>("DELETE", args.postId, { access_token: args.token });
}

/** Instagram Content Publishing: create a media container, then publish it. Needs a photo. */
export async function publishInstagramPhoto(args: { igAccountId: string; token: string; photoUrl: string; caption: string }): Promise<string> {
  const container = await graph<{ id: string }>("POST", `${args.igAccountId}/media`, {
    image_url: args.photoUrl,
    caption: args.caption,
    access_token: args.token,
  });
  const published = await graph<{ id: string }>("POST", `${args.igAccountId}/media_publish`, {
    creation_id: container.id,
    access_token: args.token,
  });
  return published.id;
}

/** A Reels container failed processing (status_code ERROR/EXPIRED) or never finished: retrying the same file will not help. */
export class MetaReelError extends Error {
  readonly retryable = false;
  constructor(message: string) {
    super(message);
    this.name = "MetaReelError";
  }
}

export type PublishReelDeps = { sleep?: (ms: number) => Promise<void>; pollMs?: number; capMs?: number };

/**
 * Instagram Reels: POST /{ig}/media (media_type=REELS, video_url, caption), poll /{container}?fields=status_code
 * until FINISHED (ERROR/EXPIRED throw MetaReelError), then POST /{ig}/media_publish. Returns the media id.
 * video_url must be publicly reachable. TODO(inferred): the full status_code list (IN_PROGRESS, PUBLISHED) is not on the reference page.
 */
export async function publishInstagramReel(
  args: { igAccountId: string; token: string; videoUrl: string; caption: string },
  deps: PublishReelDeps = {},
): Promise<string> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? 5_000;
  const capMs = deps.capMs ?? 5 * 60_000;
  const container = await graph<{ id: string }>("POST", `${args.igAccountId}/media`, {
    media_type: "REELS",
    video_url: args.videoUrl,
    caption: args.caption,
    share_to_feed: "true",
    access_token: args.token,
  });
  let waited = 0;
  for (;;) {
    const st = await graph<{ status_code?: string; status?: string }>("GET", container.id, { fields: "status_code", access_token: args.token });
    if (st.status_code === "FINISHED") break;
    if (st.status_code === "ERROR" || st.status_code === "EXPIRED") {
      throw new MetaReelError(`Instagram could not process the reel (${st.status_code}${st.status ? `: ${st.status}` : ""})`);
    }
    if (waited >= capMs) throw new MetaReelError("Instagram reel processing timed out after 5 minutes");
    await sleep(pollMs);
    waited += pollMs;
  }
  const published = await graph<{ id: string }>("POST", `${args.igAccountId}/media_publish`, {
    creation_id: container.id,
    access_token: args.token,
  });
  return published.id;
}

export type InstagramMediaInsights = {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saved: number | null;
  raw: Record<string, number>;
};

/**
 * GET /{media}/insights?metric=views,likes,comments,shares,saved,reach. Lifetime values. `views` is the documented play-count
 * metric for Reels (`plays` is not listed). TODO(inferred): a metric Meta rejects for a media type fails the whole call.
 */
export async function fetchInstagramMediaInsights(mediaId: string, token: string): Promise<InstagramMediaInsights> {
  const res = await graph<{ data?: Array<{ name: string; values?: Array<{ value?: number }> }> }>("GET", `${mediaId}/insights`, {
    metric: "views,likes,comments,shares,saved,reach",
    access_token: token,
  });
  const raw: Record<string, number> = {};
  for (const m of res.data ?? []) {
    const v = m.values?.[0]?.value;
    if (typeof v === "number") raw[m.name] = v;
  }
  return { views: raw.views ?? null, likes: raw.likes ?? null, comments: raw.comments ?? null, shares: raw.shares ?? null, saved: raw.saved ?? null, raw };
}
