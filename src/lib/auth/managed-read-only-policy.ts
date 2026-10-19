/**
 * Managed (PropLane Service) workspaces are view-only for their client. Pure policy, edge-safe
 * (no server imports): the middleware, the inbox route and the tests all read it from here.
 * The rule itself (which workspaces are locked) lives in `managed_read_only_workspace_ids()` and
 * its TS mirror `managed-read-only.server.ts`; docs/agents/owner-management.md § View-only.
 */

export const MANAGED_READ_ONLY_CODE = "read_only_managed";
export const MANAGED_READ_ONLY_MESSAGE = "This workspace is managed by PropLane. It's view-only.";
export const MANAGED_READ_ONLY_TOOL_MESSAGE =
  "This workspace is managed by PropLane, so it's view-only. Message the team or get a plan to make changes.";

export const MANAGED_READ_ONLY_BODY = { error: MANAGED_READ_ONLY_MESSAGE, code: MANAGED_READ_ONLY_CODE } as const;

/**
 * Write requests a locked client may still make, by path prefix (the path itself or anything
 * below it). Everything else under /api is refused. Her own account, buying a plan, her own
 * money, her other portals, the assistant (its write tools are gated in the tool layer) and
 * the managed-workspace Team chat / Assistant inbox threads (restricted inside that route).
 */
export const MANAGED_READ_ONLY_ALLOWED_PATHS: readonly string[] = [
  // sign-out, sign-in helpers, portal switch, delete-my-account, password
  "/api/auth",
  "/api/profile",
  // buying a plan: Stripe checkout / billing portal / Connect (her own account) and Apple / RevenueCat
  "/api/stripe",
  "/api/revenuecat",
  "/api/manager/subscription",
  "/api/manager/plan-addons",
  "/api/manager/payment-methods",
  "/api/manager/signup-intent",
  "/api/manager/pricing-oauth-continue",
  "/api/number-subscription",
  // her own money and the fee-policy sign
  "/api/owner/finances",
  "/api/owner/messages",
  "/api/portal/proplane-balance/withdraw",
  // her other portals
  "/api/resident",
  "/api/vendor",
  // assistant chats and the confirm gate (every write tool is refused in scopeManagerTool)
  "/api/agent",
  // workspace switch (rename / delete / move are refused inside the route)
  "/api/workspaces",
  // telemetry and feedback
  "/api/native/register-push-token",
  "/api/portal-bug-feedback",
  "/api/bug-feedback-attachments",
  // the inbox: only the Team chat and her own Assistant thread, enforced in the route
  "/api/portal-inbox-threads",
  // not a signed-in write by her: public forms and machine callers
  "/api/public",
  "/api/webhooks",
  "/api/twilio",
  "/api/cron",
  "/api/internal",
];

/** Collapse what the router collapses: repeated slashes, trailing slash, percent-encoding. */
export function normalizeApiPath(pathname: string): string {
  let decoded = pathname;
  for (let i = 0; i < 3; i += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  const stripped = decoded.replace(/\/{2,}/g, "/");
  return (stripped.length > 1 ? stripped.replace(/\/+$/, "") : stripped).toLowerCase();
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isManagedReadOnlyAllowedPath(pathname: string): boolean {
  const p = normalizeApiPath(pathname);
  return MANAGED_READ_ONLY_ALLOWED_PATHS.some((allowed) => p === allowed || p.startsWith(`${allowed}/`));
}

/** True for a write to /api/* that is not on the allowlist: the only requests the lock has to look at. */
export function managedReadOnlyCandidate(method: string, pathname: string): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  const p = normalizeApiPath(pathname);
  if (p !== "/api" && !p.startsWith("/api/")) return false;
  return !isManagedReadOnlyAllowedPath(p);
}

/**
 * Block or let through a candidate write for a user whose locked workspaces are `lockedIds`.
 * The `proplane-workspace` cookie decides which workspace the request is acting in; a cookie
 * naming an unlocked workspace passes, a locked one or no cookie (the default workspace) does not.
 */
export function managedReadOnlyBlocks(lockedIds: readonly string[], cookieWorkspaceId: string | null | undefined): boolean {
  if (lockedIds.length === 0) return false;
  const cookie = cookieWorkspaceId?.trim();
  if (!cookie) return true;
  return lockedIds.includes(cookie);
}

const TEAM_THREAD_PREFIX = "team-thread:";

/**
 * Inbox thread ids a locked client may write: the Team chat of THIS workspace
 * (`team-thread:<owner>:ws:<workspace>`) and her own Assistant thread.
 */
export function managedReadOnlyInboxThreadAllowed(id: string, workspaceId: string, ownerUserId: string): boolean {
  const t = id.trim();
  if (!t) return false;
  if (t.startsWith("agent_notice_")) return true;
  return t === `${TEAM_THREAD_PREFIX}${ownerUserId.trim()}:ws:${workspaceId.trim()}`;
}

/**
 * Every thread id an inbox POST body names (`id`, `ids`, `row.id`, `rows[].id`, `sources[].id`), or
 * null for an action that names no thread but still writes (dismissing contacts), which a locked
 * client may not do.
 */
export function managedReadOnlyInboxWrites(body: {
  action?: string;
  id?: unknown;
  ids?: unknown;
  row?: { id?: unknown } | null;
  rows?: { id?: unknown }[] | null;
  sources?: { id?: unknown }[] | null;
}): string[] | null {
  if (body.action === "dismissContacts" || body.action === "clearDismissedContacts") return null;
  const out: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.trim()) out.push(value.trim());
    else out.push("");
  };
  if (body.id !== undefined) push(body.id);
  if (Array.isArray(body.ids)) body.ids.forEach(push);
  if (body.row && typeof body.row === "object") push(body.row.id);
  if (Array.isArray(body.rows)) body.rows.forEach((r) => push(r?.id));
  if (Array.isArray(body.sources)) body.sources.forEach((r) => push(r?.id));
  return out;
}
