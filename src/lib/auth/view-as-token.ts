/**
 * "View as" support mode: the signed session cookie and the read-only policy.
 *
 * This file is imported by the Next middleware (edge runtime) AND by server
 * code, so it uses WebCrypto only: no `next/headers`, no `server-only`, no
 * Node `crypto`. Everything stateful (who the current user is, the operator
 * allowlist, the audit trail) lives in `view-as.server.ts`.
 *
 * Security shape, in one paragraph: a view-as session is ONE cookie whose value
 * is `base64url(json payload) + "." + base64url(HMAC-SHA256(payload))`. The
 * payload names the admin who started it, the account being viewed, the portal,
 * an absolute expiry (30 minutes) and a session id that ties the cookie to its
 * audit rows. A cookie that fails the signature check, is expired, or names a
 * different admin than the signed-in user is ignored. The cookie is never
 * trusted for WHO is signed in, only for which account the signed-in operator
 * asked to look at. Writes are refused for the whole session by the middleware
 * (`viewAsBlocksRequest`), so a missed read path can show the wrong data but can
 * never change any.
 */

export const VIEW_AS_COOKIE = "axis_view_as";
/** Pre-signing cookie names. Never read any more; still cleared on sign-out and portal switch. */
export const LEGACY_PREVIEW_UID_COOKIE = "axis_admin_preview_uid";
export const LEGACY_PREVIEW_PORTAL_COOKIE = "axis_admin_preview_portal";

/** Sessions are fixed at 30 minutes; there is no "extend". */
export const VIEW_AS_TTL_SECONDS = 30 * 60;
/**
 * The browser keeps the cookie a little past `exp` so the first request after
 * expiry can still be recognised as an expired session (and be ended in the
 * audit trail) instead of silently vanishing.
 */
export const VIEW_AS_COOKIE_GRACE_SECONDS = 5 * 60;

export const VIEW_AS_MIN_SECRET_CHARS = 32;

export type ViewAsPortal = "manager" | "resident" | "vendor";

export type ViewAsPayload = {
  v: 1;
  /** The operator who started the session (must equal the signed-in user on every read). */
  adminId: string;
  /** The account being viewed. */
  targetId: string;
  portal: ViewAsPortal;
  /** Issued at / expires at, epoch seconds. */
  iat: number;
  exp: number;
  /** Ties the cookie to its `admin_view_as_started` / `admin_view_as_ended` audit rows. */
  sid: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** The signing secret, or null when unset or too short. Null means "the feature is off". */
export function readViewAsSecret(env: Record<string, string | undefined> = process.env): string | null {
  const secret = env.PROPLANE_VIEW_AS_SECRET?.trim() ?? "";
  return secret.length >= VIEW_AS_MIN_SECRET_CHARS ? secret : null;
}

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

function isPortal(value: unknown): value is ViewAsPortal {
  return value === "manager" || value === "resident" || value === "vendor";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 128;
}

export async function signViewAsToken(payload: ViewAsPayload, secret: string): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), encoder.encode(body)));
  return `${body}.${toBase64Url(sig)}`;
}

/**
 * Verify signature (constant time, via `subtle.verify`) and shape. Expiry is
 * checked unless `allowExpired` is set, which only the End route and the
 * expiry bookkeeping use: a signed-but-expired token is still proof of WHICH
 * session to close, never of any access.
 */
export async function verifyViewAsToken(
  value: string | null | undefined,
  secret: string | null,
  opts: { nowMs?: number; allowExpired?: boolean } = {},
): Promise<ViewAsPayload | null> {
  if (!value || !secret) return null;
  if (value.length > 2048) return null;
  const dot = value.indexOf(".");
  if (dot <= 0 || dot === value.length - 1 || value.indexOf(".", dot + 1) !== -1) return null;
  const body = value.slice(0, dot);
  const sig = fromBase64Url(value.slice(dot + 1));
  if (!sig || sig.length !== 32) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), sig as BufferSource, encoder.encode(body));
  } catch {
    return null;
  }
  if (!ok) return null;
  const raw = fromBase64Url(body);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (
    p.v !== 1 ||
    !isNonEmptyString(p.adminId) ||
    !isNonEmptyString(p.targetId) ||
    !isNonEmptyString(p.sid) ||
    !isPortal(p.portal) ||
    typeof p.iat !== "number" ||
    typeof p.exp !== "number" ||
    !Number.isFinite(p.iat) ||
    !Number.isFinite(p.exp)
  ) {
    return null;
  }
  // A token can never outlive its fixed window, whatever the payload claims.
  if (p.exp - p.iat > VIEW_AS_TTL_SECONDS) return null;
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (!opts.allowExpired && nowSec >= p.exp) return null;
  return {
    v: 1,
    adminId: p.adminId,
    targetId: p.targetId,
    portal: p.portal,
    iat: p.iat,
    exp: p.exp,
    sid: p.sid,
  };
}

/* -------------------------------------------------------------------------- */
/* Read-only policy (pure; the middleware calls these)                         */
/* -------------------------------------------------------------------------- */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The error code every refusal returns, so a client can tell "read-only" from any other 403. */
export const VIEW_AS_READ_ONLY_ERROR = "read_only_view_as";

/**
 * Collapse what the router collapses: repeated slashes, a trailing slash and
 * percent-encoding (`/signed%2Durl` routes to `signed-url`, so a pattern match
 * on the raw string would be a bypass). Undecodable input is returned as-is.
 */
function normalizePath(pathname: string): string {
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
  return stripped.length > 1 ? stripped.replace(/\/+$/, "") : stripped;
}

/**
 * The only two non-read requests a view-as session may make: ending itself, and
 * signing out. Everything else (portal switching, every record write, every
 * server action) is refused until the operator ends the session.
 */
export function isViewAsExitRequest(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  const p = normalizePath(pathname);
  if (m === "DELETE" && p === "/api/admin/preview") return true;
  if (m === "POST" && p === "/api/auth/sign-out") return true;
  return false;
}

/** True when a request must be refused because a valid view-as session is active. */
export function viewAsBlocksRequest(method: string, pathname: string): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  return !isViewAsExitRequest(method, pathname);
}

/**
 * GET routes that hand out private document bytes or mint signed URLs. A
 * view-as session lists metadata but never opens the file: viewing someone's
 * lease or ID would otherwise be an unlogged download. Refused for the whole
 * session rather than logged per fetch (the approved decision).
 */
const PRIVATE_BYTES_PATTERNS: RegExp[] = [
  /^\/api\/manager-documents\/[^/]+\/signed-url$/,
  /^\/api\/resident\/shared-documents\/[^/]+\/signed-url$/,
  /^\/api\/vendor\/shared-documents\/[^/]+\/signed-url$/,
  /^\/api\/vendor\/documents\/signed-url$/,
  /^\/api\/vendor\/documents\/file$/,
  /^\/api\/vendor\/onboarding\/documents\/signed-url$/,
  /^\/api\/portal\/inbox-attachments$/,
  /^\/api\/portal\/application-photos$/,
  /^\/api\/sms-media$/,
  /^\/api\/recovered-assets\/[^/]+$/,
  /^\/api\/bug-feedback-attachments$/,
  /^\/api\/manager-applications\/[^/]+\/(pdf|receipt)$/,
  /^\/api\/screening\/background-check\/document$/,
  /^\/api\/share\/documents\/[^/]+$/,
  /^\/api\/share\/leases\/[^/]+\/pdf$/,
  // Built from rows rather than storage, so the service-role storage proxy
  // never sees them: an owner statement, the formal-document exports (rent
  // receipts, verification letters) and every report download are the same
  // private download — a resident-naming PDF or CSV leaving the account.
  /^\/api\/owner\/statements\/pdf$/,
  /^\/api\/owner\/documents\/[^/]+\/signed-url$/,
  /^\/api\/reports\/formal-documents\/export$/,
  /^\/api\/reports\/owner-statement\/formal-export$/,
  /^\/api\/reports\/1099-nec\/export$/,
  /^\/api\/reports\/deposit-disposition\/export$/,
  /^\/api\/reports\/operational-export$/,
  /^\/api\/reports\/[^/]+\/export$/,
  /^\/api\/portal\/tours-export$/,
  /^\/api\/vendor\/export$/,
];

/**
 * The same refusal where a QUERY PARAMETER, not the path, asks for the file:
 * `?format=csv` turns the vendor statement and the property worksheet into a
 * ledger built from rows, while the JSON read on that same path (the list, the
 * `summary=1` stamp) is ordinary metadata a session may see. A path pattern
 * cannot tell those two apart, so the format decides.
 */
const PRIVATE_BYTES_FORMATS = new Set(["csv", "pdf"]);
const PRIVATE_BYTES_FORMAT_PATHS: RegExp[] = [
  /^\/api\/vendor\/payouts\/statement$/,
  /^\/api\/reports\/property-worksheet$/,
];

export function viewAsDeniesPrivateBytes(
  method: string,
  pathname: string,
  search: string | URLSearchParams = "",
): boolean {
  if (!SAFE_METHODS.has(method.toUpperCase())) return false;
  const p = normalizePath(pathname).toLowerCase();
  if (PRIVATE_BYTES_PATTERNS.some((re) => re.test(p))) return true;
  if (!PRIVATE_BYTES_FORMAT_PATHS.some((re) => re.test(p))) return false;
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  return PRIVATE_BYTES_FORMATS.has((params.get("format") ?? "").trim().toLowerCase());
}

/**
 * Paths where the signed-in operator is still themselves, so the admin console
 * keeps working (read-only) while a session is open and End can always reach its
 * own route. Everything else resolves as the viewed account.
 */
const REAL_IDENTITY_PREFIXES = ["/admin", "/api/admin", "/api/auth"];

export function viewAsKeepsRealIdentity(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const p = normalizePath(pathname);
  return REAL_IDENTITY_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

/** Origin must name the host this request was served on (CSRF guard for the state-changing verbs). */
export function isSameOrigin(headers: Pick<Headers, "get">): boolean {
  const origin = headers.get("origin");
  if (!origin) return false;
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** The operator allowlist (comma-separated auth user ids). Empty or unset means nobody. */
export function parseViewAsOperatorIds(env: Record<string, string | undefined> = process.env): Set<string> {
  return new Set(
    (env.PROPLANE_VIEW_AS_OPERATOR_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export function isViewAsOperatorId(userId: string, env: Record<string, string | undefined> = process.env): boolean {
  const id = userId.trim();
  return Boolean(id) && parseViewAsOperatorIds(env).has(id);
}

export const VIEW_AS_REASON_MIN = 3;
export const VIEW_AS_REASON_MAX = 300;

/** Reason text the operator typed: collapsed whitespace, 3..300 chars, or null. */
export function normalizeViewAsReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim().replace(/\s+/g, " ");
  if (text.length < VIEW_AS_REASON_MIN || text.length > VIEW_AS_REASON_MAX) return null;
  return text;
}
