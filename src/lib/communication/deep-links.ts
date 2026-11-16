/**
 * The ONE builder for a link into a conversation or a record that PropLane puts in a message it sends.
 *
 * Every notice about a thread (a manager / staff / owner text, email, push or Team line; a resident's or a vendor's notice)
 * ends on a link built here, so the click opens the EXACT conversation for THAT recipient's role:
 *   manager  -> /portal/communication/active/<thread>
 *   admin    -> /admin/communication/active/<thread>
 *   resident -> /resident/communication/active/<thread>   (never /portal)
 *   vendor   -> /vendor/communication/active/<thread>
 *
 * A link is a name, never authorization: the destination re-checks access and an unauthorized open shows the normal
 * not-found. A signed-out open goes through sign-in and comes back (`signInThenPath`, same-site relative paths only).
 * Pure: no database, no clock. The origin is the canonical one the caller already resolved.
 */
import { normalizePostAuthPath } from "@/lib/auth/normalize-post-auth-path";

export type CommunicationLinkRole = "manager" | "admin" | "resident" | "vendor";

const BASE: Record<CommunicationLinkRole, string> = {
  manager: "/portal",
  admin: "/admin",
  resident: "/resident",
  vendor: "/vendor",
};

/** A thread key as the Communication routes carry it: an id, a `tel:` / `lead:` key. Never a path or a query. */
const THREAD_KEY = /^[A-Za-z0-9][A-Za-z0-9:_.@+-]{0,199}$/;

export function isLinkableThreadKey(key: string | null | undefined): key is string {
  return typeof key === "string" && THREAD_KEY.test(key.trim());
}

/** The list a thread opens in. The Communication route takes `active | unread | archived` before the thread. */
export function communicationListPath(role: CommunicationLinkRole): string {
  return `${BASE[role]}/communication/active`;
}

/** The exact conversation for this role. A missing or unusable key falls back to the role's own Communication list. */
export function communicationThreadPath(role: CommunicationLinkRole, threadKey: string | null | undefined): string {
  const key = (threadKey ?? "").trim();
  return isLinkableThreadKey(key) ? `${communicationListPath(role)}/${encodeURIComponent(key)}` : communicationListPath(role);
}

export function absoluteLink(origin: string, path: string): string {
  return `${origin.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * The in-app path a notice's link (and a push tap) opens. For a managed (PropLane Service) workspace the staff opening it
 * may have another workspace selected, so the path names its workspace and `/open/thread` selects it (only a workspace the
 * viewer can already see).
 */
export function communicationThreadHref(input: {
  role: CommunicationLinkRole;
  threadKey: string | null | undefined;
  workspaceId?: string | null;
}): string {
  const path = communicationThreadPath(input.role, input.threadKey);
  const workspaceId = (input.workspaceId ?? "").trim();
  if (input.role === "manager" && /^[0-9a-f-]{36}$/i.test(workspaceId) && isLinkableThreadKey(input.threadKey)) {
    return `/open/thread?w=${encodeURIComponent(workspaceId)}&p=${encodeURIComponent(path)}`;
  }
  return path;
}

/** The https link a notice carries, on the canonical origin. */
export function communicationThreadUrl(
  origin: string,
  input: { role: CommunicationLinkRole; threadKey: string | null | undefined; workspaceId?: string | null },
): string {
  return absoluteLink(origin, communicationThreadHref(input));
}

/** Sign in, then land on `path` (the sign-in page takes the same-site `next`). An unsafe path lands on the dashboard. */
export function signInThenPath(path: string): string {
  const safe = normalizePostAuthPath(path);
  return `/auth/sign-in?next=${encodeURIComponent(safe)}`;
}

/** A path the `/open/thread` door may send a person to: one role's Communication, same site, nothing else. */
export function isCommunicationDeepPath(path: string | null | undefined): path is string {
  const value = (path ?? "").trim();
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  if (normalizePostAuthPath(value) !== value) return false;
  return /^\/(portal|admin|resident|vendor)\/communication\/(active|unread|archived)(\/[^/?#\s]{1,200})?$/.test(value);
}

/** "Ask PropLane" about a record: the assistant opens pre-loaded with that record. The param carries a reference only. */
export type AskRecordKind = "thread" | "lead" | "service" | "booking" | "charge" | "application" | "property";

const ASK_KINDS: readonly AskRecordKind[] = ["thread", "lead", "service", "booking", "charge", "application", "property"];
const ASK_ID = /^[A-Za-z0-9][A-Za-z0-9:_.@+-]{0,199}$/;

export function askRecordParam(kind: AskRecordKind, id: string): string | null {
  const clean = id.trim();
  return ASK_KINDS.includes(kind) && ASK_ID.test(clean) ? `${kind}:${clean}` : null;
}

/** Parse `?ask=<kind>:<id>`. Anything else is null; the server still re-authorizes the reference before it reads it. */
export function parseAskRecordParam(value: string | null | undefined): { kind: AskRecordKind; id: string } | null {
  const raw = (value ?? "").trim();
  const at = raw.indexOf(":");
  if (at <= 0) return null;
  const kind = raw.slice(0, at) as AskRecordKind;
  const id = raw.slice(at + 1);
  return ASK_KINDS.includes(kind) && ASK_ID.test(id) ? { kind, id } : null;
}

/** The thread link with `?ask=` appended: opens the conversation with the assistant already about it. */
export function askPropLaneUrl(
  origin: string,
  input: { role: CommunicationLinkRole; threadKey: string; workspaceId?: string | null },
): string | null {
  const ask = askRecordParam("thread", input.threadKey);
  if (!ask || !isLinkableThreadKey(input.threadKey)) return null;
  const base = communicationThreadUrl(origin, input);
  const sep = base.includes("/open/thread?") ? "&" : "?";
  return `${base}${sep}ask=${encodeURIComponent(ask)}`;
}

/** The thread key a deep-link href (a direct Communication path or the `/open/thread` door) names, or null. */
export function threadKeyFromHref(href: string | null | undefined): string | null {
  const raw = (href ?? "").trim();
  if (!raw.startsWith("/")) return null;
  let path = raw;
  try {
    const url = new URL(raw, "https://link.invalid");
    if (url.pathname === "/open/thread") path = url.searchParams.get("p") ?? "";
    else path = url.pathname;
  } catch {
    return null;
  }
  const match = /^\/(?:portal|admin|resident|vendor)\/communication\/(?:active|unread|archived)\/([^/?#]+)$/.exec(path);
  if (!match) return null;
  try {
    const key = decodeURIComponent(match[1]!);
    return isLinkableThreadKey(key) ? key : null;
  } catch {
    return null;
  }
}

/**
 * The same href with `ask=thread:<key>` added: "Ask PropLane about this conversation". Null when the href is not a
 * conversation link (a list or a record page has no thread to ask about). The param is a reference the server re-authorizes.
 */
export function askHrefForThreadHref(href: string | null | undefined): string | null {
  const key = threadKeyFromHref(href);
  const ask = key ? askRecordParam("thread", key) : null;
  if (!ask) return null;
  const raw = (href ?? "").trim();
  return `${raw}${raw.includes("?") ? "&" : "?"}ask=${encodeURIComponent(ask)}`;
}
