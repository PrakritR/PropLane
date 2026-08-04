/**
 * Inbound support email → admin portal inbox.
 *
 * Mail sent to the public support address (support@prop-lane.space) is routed to
 * Resend Inbound, which POSTs an `email.received` webhook to
 * `/api/webhooks/email/inbound`. That route verifies the Svix signature and hands
 * the parsed metadata here. We turn it into a `portal_inbox_thread_records` row
 * under the ADMIN scope — the exact rail the public contact-message form already
 * uses (`src/app/api/public/contact-message/route.ts`) — so support mail lands in
 * the founder/admin portal inbox alongside every other unified-inbox thread.
 *
 * Resend inbound webhooks carry metadata only (from/to/subject/id); the body is
 * fetched separately from Resend's received-email API. The thread row is written
 * from the metadata FIRST and the body is filled in by a best-effort second pass,
 * so a slow or failing lookup can never cost us the email nor stall the webhook
 * response; that pass retries a bounded number of times to ride out a blip.
 */
import { buildPortalInboxThreadUpsert } from "@/lib/portal-inbox-thread-upsert";
import { ADMIN_INBOX_SCOPE } from "@/lib/portal-inbox-thread-scope";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const INBOUND_EMAIL_THREAD_ID_PREFIX = "inbound_email_";
/** Hard cap on stored body length — keeps a giant email from bloating the row. */
export const INBOUND_EMAIL_BODY_MAX_CHARS = 20_000;

export type ParsedInboundEmail = {
  emailId: string;
  fromEmail: string;
  fromName: string;
  toEmails: string[];
  subject: string;
  receivedAt: string;
  /** Present only if the provider inlined the body on the webhook (usually not). */
  text?: string;
  html?: string;
};

/** Deterministic thread id keyed off the provider message id → idempotent upsert. */
export function inboundEmailThreadId(emailId: string): string {
  return `${INBOUND_EMAIL_THREAD_ID_PREFIX}${emailId.trim()}`;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Split `"Acme <hi@acme.com>"` → { name: "Acme", email: "hi@acme.com" }. */
export function parseEmailAddress(raw: string): { name: string; email: string } {
  const value = raw.trim();
  const angled = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (angled) {
    const name = angled[1]!.replace(/^["']|["']$/g, "").trim();
    return { name, email: angled[2]!.trim().toLowerCase() };
  }
  return { name: "", email: value.toLowerCase() };
}

function toEmailList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return items
    .map((entry) => parseEmailAddress(asString(entry)).email)
    .filter((email) => email.includes("@"));
}

/**
 * Extract the fields we need from a Resend `email.received` webhook. Returns null
 * for any other event type or a malformed payload so the route can ack-and-ignore
 * without creating a thread.
 */
export function parseInboundEmailWebhook(payload: unknown): ParsedInboundEmail | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;
  if (asString(root.type) !== "email.received") return null;

  const data = (root.data && typeof root.data === "object" ? root.data : {}) as Record<string, unknown>;
  const emailId = asString(data.email_id) || asString(data.id);
  const fromRaw = asString(data.from);
  if (!emailId || !fromRaw) return null;

  const { name, email } = parseEmailAddress(fromRaw);
  if (!email.includes("@")) return null;

  const receivedAt = asString(data.created_at) || asString(root.created_at) || new Date().toISOString();

  return {
    emailId,
    fromEmail: email,
    fromName: name,
    toEmails: toEmailList(data.to),
    subject: asString(data.subject),
    receivedAt,
    text: typeof data.text === "string" ? data.text : undefined,
    html: typeof data.html === "string" ? data.html : undefined,
  };
}

/** Minimal, dependency-free HTML → text: drop scripts/styles, keep line breaks. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|tr|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Clamp to a stored-body ceiling, appending a marker when truncated. */
export function clampBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= INBOUND_EMAIL_BODY_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, INBOUND_EMAIL_BODY_MAX_CHARS)}\n\n… (truncated)`;
}

/**
 * Outcome of one body lookup. The kinds exist so the retry can tell a transient
 * blip (`error`, worth another attempt) from an answer that will never change
 * (`empty` — an attachment-only email; `no-key` — RESEND_API_KEY unset, where no
 * request is issued at all).
 */
export type ResendReceivedEmailBodyResult =
  | { kind: "body"; text: string; headers?: ResendReceivedEmailHeaders }
  | { kind: "empty"; headers?: ResendReceivedEmailHeaders }
  | { kind: "no-key" }
  | { kind: "error" };

/**
 * Headers Resend exposes for a received email, lowercased by name. Each name
 * maps to EVERY value in received order rather than one joined string: a
 * message carries one `Authentication-Results` per hop, and only the topmost
 * (the last receiver to touch it) may be trusted — merging them would hand the
 * sender's own forged line the same weight as the receiver's.
 *
 * Absent/empty is "we know nothing", never a verdict.
 */
export type ResendReceivedEmailHeaders = Record<string, string[]>;

function parseResendReceivedHeaders(raw: unknown): ResendReceivedEmailHeaders {
  const out: ResendReceivedEmailHeaders = {};
  const add = (name: unknown, value: unknown): void => {
    const key = String(name ?? "").trim().toLowerCase();
    const text = typeof value === "string" ? value : value == null ? "" : String(value);
    if (!key || !text.trim()) return;
    (out[key] ??= []).push(text);
  };
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      add(record.name ?? record.key, record.value);
    }
  } else if (raw && typeof raw === "object") {
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(value)) for (const item of value) add(name, item);
      else add(name, value);
    }
  }
  return out;
}

/**
 * Fetch a received email from Resend — body AND headers in ONE round trip.
 * Metadata-only webhooks mean both live behind the received-email API, reached
 * with the same RESEND_API_KEY used for outbound; a caller that needs the
 * headers must never issue a second GET for them.
 *
 * The path follows Resend's documented `receiving` namespace; override the base
 * with RESEND_INBOUND_API_BASE if Resend's routing differs for your account.
 */
export async function fetchResendReceivedEmailBody(emailId: string): Promise<ResendReceivedEmailBodyResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return { kind: "no-key" };
  const base = (process.env.RESEND_INBOUND_API_BASE?.trim() || "https://api.resend.com").replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/emails/receiving/${encodeURIComponent(emailId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      console.warn("inbound-email body fetch failed", emailId, res.status, res.statusText);
      return { kind: "error" };
    }
    const json = (await res.json()) as Record<string, unknown>;
    const data = (json.data && typeof json.data === "object" ? json.data : json) as Record<string, unknown>;
    const headers = parseResendReceivedHeaders(data.headers);
    const text = typeof data.text === "string" ? data.text : "";
    if (text.trim()) return { kind: "body", text, headers };
    const html = typeof data.html === "string" ? data.html : "";
    const converted = html.trim() ? htmlToText(html) : "";
    return converted.trim() ? { kind: "body", text: converted, headers } : { kind: "empty", headers };
  } catch (e) {
    console.warn("inbound-email body fetch errored", emailId, e);
    return { kind: "error" };
  }
}

/**
 * Backoff between body-lookup attempts. Bounded on purpose: the enrichment runs
 * in after(), so a blip should self-heal here rather than wait for a redelivery
 * that — because the webhook already acked 200 — normally never comes. Only a
 * transient `error` is retried; `empty` and `no-key` return immediately so a
 * body-less email or a missing key never costs a sleep or a wasted round trip.
 */
const INBOUND_EMAIL_BODY_RETRY_DELAYS_MS = [500, 1_000];

export async function fetchResendReceivedEmailBodyWithRetry(emailId: string): Promise<ResendReceivedEmailBodyResult> {
  for (let attempt = 0; ; attempt += 1) {
    const result = await fetchResendReceivedEmailBody(emailId);
    if (result.kind !== "error") return result;
    const delay = INBOUND_EMAIL_BODY_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/**
 * Stand-in stored when no body could be resolved yet. It is also the ONLY body
 * value the enrichment pass is allowed to overwrite, which is what keeps a
 * backfill from clobbering a body (or an admin's edits) that already landed.
 */
export const INBOUND_EMAIL_BODY_PLACEHOLDER =
  "(No message body could be retrieved. Open the sender's email to read it.)";

/** Body carried on the webhook itself; "" when the provider sent metadata only. */
export function inlineInboundEmailBody(parsed: ParsedInboundEmail): string {
  if (parsed.text && parsed.text.trim()) return clampBody(parsed.text);
  if (parsed.html && parsed.html.trim()) return clampBody(htmlToText(parsed.html));
  return "";
}

/**
 * Resolve the best available body: inlined text → inlined html → API fetch (with
 * the bounded retry). Yields INBOUND_EMAIL_BODY_PLACEHOLDER when nothing could be
 * retrieved, so a caller compares against it to tell a real body from a miss.
 */
export async function resolveInboundEmailBody(parsed: ParsedInboundEmail): Promise<string> {
  const inline = inlineInboundEmailBody(parsed);
  if (inline) return inline;
  const fetched = await fetchResendReceivedEmailBodyWithRetry(parsed.emailId);
  return fetched.kind === "body" ? clampBody(fetched.text) : INBOUND_EMAIL_BODY_PLACEHOLDER;
}

/**
 * Build the admin-inbox row for an inbound support email. Shape mirrors the
 * `InboxMessage` the admin inbox renders (see demo-admin-partner-inbox.ts) and
 * the contact-message route: scope "admin" (owner-agnostic — visible to every
 * admin/founder), with the external sender stored as the participant.
 *
 * This is INBOUND DISPLAY ONLY. Replying to a support thread in-app appends to
 * `row.thread` and does NOT email the sender back — there is no outbound path
 * for these threads.
 */
export function buildInboundEmailInboxRow(opts: { parsed: ParsedInboundEmail; bodyText: string }) {
  const { parsed, bodyText } = opts;
  return {
    id: inboundEmailThreadId(parsed.emailId),
    name: parsed.fromName || parsed.fromEmail,
    email: parsed.fromEmail,
    participantEmail: parsed.fromEmail,
    topic: parsed.subject || "(no subject)",
    body: bodyText || "(no message body)",
    createdAt: parsed.receivedAt,
    read: false,
    folder: "inbox" as const,
    // "partner" = external contact; roleAllowsThread lets an admin open it.
    senderRole: "partner" as const,
    thread: [] as never[],
    scope: ADMIN_INBOX_SCOPE,
    // Audit metadata only — nothing renders this today.
    channel: "email" as const,
  };
}

/**
 * Postgres unique_violation — the row was already ingested by a prior delivery.
 * Matched on the code alone: PostgREST always populates it, and a substring
 * match on the message could misread an unrelated failure as already-ingested,
 * turning a lost email into a 200.
 */
function isUniqueViolation(error: { code?: string | null }): boolean {
  return error.code === "23505";
}

/**
 * Ingest a parsed inbound email into the admin portal inbox. The row is written
 * FIRST, from webhook metadata alone, so mail survives even if the body lookup
 * hangs or fails — `backfillInboundEmailBody` fills the body in afterwards.
 *
 * Idempotent by construction: the deterministic thread id is inserted, and a
 * unique-violation from a re-delivered webhook is a no-op, so an admin's
 * read/reply state is never clobbered. Any OTHER database error throws so the
 * caller can return a 5xx and let the provider retry rather than silently
 * dropping support mail.
 */
export async function ingestInboundEmail(
  parsed: ParsedInboundEmail,
  db = createSupabaseServiceRoleClient(),
): Promise<{ created: boolean }> {
  const row = buildInboundEmailInboxRow({
    parsed,
    bodyText: inlineInboundEmailBody(parsed) || INBOUND_EMAIL_BODY_PLACEHOLDER,
  });
  const record = buildPortalInboxThreadUpsert(row, { id: "", email: null });
  const { error } = await db.from("portal_inbox_thread_records").insert(record);
  if (!error) return { created: true };
  if (isUniqueViolation(error)) return { created: false };
  throw new Error(error.message);
}

async function readInboundThreadRowData(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  id: string,
  emailId: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await db
    .from("portal_inbox_thread_records")
    .select("row_data")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.warn("inbound-email body backfill read failed", emailId, error.message);
    return null;
  }
  const rowData = (data as { row_data?: unknown } | null)?.row_data;
  if (!rowData || typeof rowData !== "object") return null;
  return rowData as Record<string, unknown>;
}

/**
 * Best-effort second pass that replaces the placeholder body with the real one
 * once Resend's received-email API answers, retrying a few times so a transient
 * blip heals itself.
 *
 * Three steps in a deliberate order: a cheap pre-check so an already-enriched
 * thread costs no Resend round trip at all, then the (slow) lookup, then a FRESH
 * re-read of the row immediately before the write. The lookup sits outside the
 * read→write pair on purpose — parking it in between would leave the snapshot
 * tens of seconds stale by the time it is written back.
 */
export async function backfillInboundEmailBody(
  parsed: ParsedInboundEmail,
  db = createSupabaseServiceRoleClient(),
): Promise<{ updated: boolean }> {
  if (inlineInboundEmailBody(parsed)) return { updated: false };

  const id = inboundEmailThreadId(parsed.emailId);
  const precheck = await readInboundThreadRowData(db, id, parsed.emailId);
  if (!precheck || precheck.body !== INBOUND_EMAIL_BODY_PLACEHOLDER) return { updated: false };

  const body = await resolveInboundEmailBody(parsed);
  if (body === INBOUND_EMAIL_BODY_PLACEHOLDER) return { updated: false };

  const current = await readInboundThreadRowData(db, id, parsed.emailId);
  if (!current || current.body !== INBOUND_EMAIL_BODY_PLACEHOLDER) return { updated: false };

  // The `row_data->>body` filter is the real guard: it makes the write lose to
  // anything that already replaced the placeholder. It does not cover the rest
  // of row_data, so an admin who marks this thread read (or replies) in the
  // sub-second gap between the read above and this update would have that
  // undone — accepted, because it can only happen on a brand-new row before any
  // realistic admin interaction, it is recoverable rather than lost mail, and
  // closing it would need a jsonb-merge RPC and the migration this feature
  // deliberately ships without.
  const { error: updateError } = await db
    .from("portal_inbox_thread_records")
    .update({ row_data: { ...current, body }, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("row_data->>body", INBOUND_EMAIL_BODY_PLACEHOLDER);
  if (updateError) {
    console.warn("inbound-email body backfill failed", parsed.emailId, updateError.message);
    return { updated: false };
  }
  return { updated: true };
}
