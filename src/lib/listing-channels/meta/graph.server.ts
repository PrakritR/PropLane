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
