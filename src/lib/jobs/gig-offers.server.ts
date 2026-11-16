import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { notifyManagerFromAgent } from "@/lib/agent-notify.server";
import { formatGigUsd, GIG_KIND_LABEL, parseGigReply, type GigKind, type GigReply } from "@/lib/jobs/gig-parse";
import { toGsm7 } from "@/lib/one-number/lead-qualifying";
import { normalizeE164 } from "@/lib/phone-e164";
import { rateLimit } from "@/lib/rate-limit";
import {
  requestBoardJob,
  resolveBoardEligibility,
  serviceIsOpenToNewRequests,
} from "@/lib/service-work-board.server";
import { readVendorTextConsent, VENDOR_CONVERSATION_PURPOSE } from "@/lib/sms/vendor-conversation-consent.server";
import { submitWorkOrderBid } from "@/lib/work-order-bids.server";
import { loadMarketplaceVendorUserIds, resolveWorkOrderPropertyZip } from "@/lib/work-order-marketplace-match.server";
import { workOrderGeneralArea } from "@/lib/work-order-vendor-privacy";

/**
 * PropLane Jobs, the vendor side: automated offers, accept-by-reply, and the "any work near me?" read.
 *
 * What a vendor can see BEFORE a manager confirms them is the board's allowlist and nothing more: the kind of job, the
 * general area (a neighborhood or city, never a street or unit), the time window, the price and a four-character code. The
 * address and the manager's name are released by the existing flow once the manager approves a bid (`acceptWorkOrderBid`).
 *
 * Accepting (a YES reply or the portal) is NOT a hire. It files the same request + SUBMITTED BID at the offered price that
 * the Find work board makes (`requestBoardJob` + `submitWorkOrderBid`); the manager approves one bid, only a submitted
 * bid is approvable, and the approved amount is immutable (`work-order-bids.server.ts`). Nothing here assigns anyone.
 */

export const MAX_GIG_OFFERS_PER_GIG = 8;
export const MAX_GIG_OFFERS_PER_VENDOR_PER_DAY = 3;
export const MAX_GIG_ACCEPTS_PER_GIG = 3;
export const GIG_RADIUS_MI = 25;
export const GIG_OFFER_WINDOW_MS = 48 * 60 * 60 * 1000;

type Db = SupabaseClient;
type Row = Record<string, unknown>;

export type GigRecord = {
  id: string;
  workOrderId: string;
  managerUserId: string;
  workspaceId: string | null;
  kind: GigKind;
  offeredCents: number;
  windowText: string | null;
  code: string;
  status: string;
};

const GIG_COLUMNS = "id, work_order_id, manager_user_id, workspace_id, kind, offered_cents, window_text, code, status";

function toGig(row: Row): GigRecord {
  return {
    id: String(row.id),
    workOrderId: String(row.work_order_id),
    managerUserId: String(row.manager_user_id),
    workspaceId: typeof row.workspace_id === "string" ? row.workspace_id : null,
    kind: row.kind === "tour_showing" || row.kind === "cleaning" ? row.kind : "other",
    offeredCents: Number(row.offered_cents),
    windowText: typeof row.window_text === "string" ? row.window_text : null,
    code: String(row.code),
    status: String(row.status),
  };
}

export async function loadGigById(db: Db, id: string): Promise<GigRecord | null> {
  const { data } = await db.from("gig_posts").select(GIG_COLUMNS).eq("id", id).maybeSingle();
  return data ? toGig(data as Row) : null;
}

export async function loadGigByCode(db: Db, code: string): Promise<GigRecord | null> {
  const { data } = await db.from("gig_posts").select(GIG_COLUMNS).eq("code", code.toUpperCase()).maybeSingle();
  return data ? toGig(data as Row) : null;
}

async function loadServiceRow(db: Db, workOrderId: string): Promise<{ record: { id: string; vendor_user_id: string | null }; row: DemoManagerWorkOrderRow } | null> {
  const { data } = await db.from("portal_work_order_records").select("id, vendor_user_id, row_data").eq("id", workOrderId).maybeSingle();
  if (!data) return null;
  const d = data as { id: unknown; vendor_user_id?: unknown; row_data?: unknown };
  return { record: { id: String(d.id), vendor_user_id: typeof d.vendor_user_id === "string" ? d.vendor_user_id : null }, row: (d.row_data ?? {}) as DemoManagerWorkOrderRow };
}

/** Open = the service can still be bid on. A gig whose service was hired out or finished is closed on the way past. */
export async function gigIsOpen(db: Db, gig: GigRecord): Promise<boolean> {
  if (gig.status !== "open") return false;
  const service = await loadServiceRow(db, gig.workOrderId);
  if (!service) return false;
  if (serviceIsOpenToNewRequests(service.record, service.row)) return true;
  await db.from("gig_posts").update({ status: "accepted", updated_at: new Date().toISOString() }).eq("id", gig.id).eq("status", "open").then(() => undefined, () => undefined);
  return false;
}

/* ------------------------------------------------------------------------------------------ */
/* Copy: fixed GSM-7 text. No model writes to a vendor.                                       */
/* ------------------------------------------------------------------------------------------ */

export function gigOfferText(input: { kind: GigKind; area: string; whenText: string | null; offeredCents: number; code: string }): string {
  const when = input.whenText ? `, ${input.whenText}` : "";
  return toGsm7(`PropLane job near ${input.area}: ${GIG_KIND_LABEL[input.kind].toLowerCase()}${when}. Pays ${formatGigUsd(input.offeredCents)}. Reply YES ${input.code} to take it or NO to pass. Reply STOP to opt out.`);
}

export function gigListLine(input: { kind: GigKind; area: string; whenText: string | null; offeredCents: number; code: string }): string {
  const bits = [GIG_KIND_LABEL[input.kind], input.area, input.whenText, `pays ${formatGigUsd(input.offeredCents)}`].filter(Boolean);
  return `${input.code} - ${bits.join(", ")}`;
}

/* ------------------------------------------------------------------------------------------ */
/* Fan-out                                                                                    */
/* ------------------------------------------------------------------------------------------ */

export type GigFanOutDeps = {
  /** Test seam: who matches the trade and the area. */
  loadVendorUserIds?: (db: Db, input: { propertyZip: string; category: "tours" | "cleaning" | "general" }) => Promise<string[]>;
  /** Test seam: the one send. */
  send?: (db: Db, input: { toPhone: string; text: string; dedupeKey: string; vendorUserId: string }) => Promise<{ ok: boolean; reason?: string }>;
  now?: () => Date;
};

async function defaultSend(db: Db, input: { toPhone: string; text: string; dedupeKey: string; vendorUserId: string }): Promise<{ ok: boolean; reason?: string }> {
  const { sendTextFromServiceOwner } = await import("@/lib/service/service-manager.server");
  const sent = await sendTextFromServiceOwner(db, {
    toPhone: input.toPhone,
    text: input.text,
    dedupeKey: input.dedupeKey,
    purpose: VENDOR_CONVERSATION_PURPOSE,
    recipientUserId: input.vendorUserId,
    // Quiet hours hold an automated text; a vendor is never woken for a job.
    sendClass: "automated",
  });
  return sent.ok ? { ok: true } : { ok: false, reason: sent.reason };
}

export type GigFanOutResult = { considered: number; sent: number; skipped: Record<string, number> };

/**
 * Text the vendors who can do this job. Eligible = onboarded for the board, a trade that fits, a service area that covers
 * the home's zip, a VERIFIED phone, SMS consent they granted themselves and no STOP. Limits: at most 8 vendors per job, 3
 * gig offers per vendor per rolling day, one offer per (job, vendor) ever. The offer row is written FIRST (unique per gig +
 * vendor), so a retried fan-out or a retried webhook texts nobody twice. Every refusal is a counted skip, never a throw.
 */
export async function fanOutGigOffers(db: Db, gigId: string, deps: GigFanOutDeps = {}): Promise<GigFanOutResult> {
  const now = (deps.now ?? (() => new Date()))();
  const skipped: Record<string, number> = {};
  const skip = (why: string) => { skipped[why] = (skipped[why] ?? 0) + 1; };
  const result: GigFanOutResult = { considered: 0, sent: 0, skipped };

  const gig = await loadGigById(db, gigId);
  if (!gig || !(await gigIsOpen(db, gig))) return result;
  const service = await loadServiceRow(db, gig.workOrderId);
  if (!service) return result;
  const zip = await resolveWorkOrderPropertyZip(db as never, service.row);
  if (!zip) { skip("no_zip"); return result; }
  const category = service.row.category === "tours" ? "tours" : service.row.category === "cleaning" ? "cleaning" : "general";
  const area = workOrderGeneralArea(service.row);

  const vendorIds = (await (deps.loadVendorUserIds ?? ((d, i) => loadMarketplaceVendorUserIds(d as never, { propertyZip: i.propertyZip, publishRadiusMi: GIG_RADIUS_MI, category: i.category })))(db, { propertyZip: zip, category } as never).catch(() => [] as string[]))
    .filter((id) => id !== gig.managerUserId);
  result.considered = vendorIds.length;
  if (vendorIds.length === 0) return result;

  const { data: priorOffers } = await db.from("gig_offers").select("vendor_user_id").eq("gig_id", gig.id);
  const alreadyOffered = new Set(((priorOffers ?? []) as Row[]).map((r) => String(r.vendor_user_id)));
  const slots = MAX_GIG_OFFERS_PER_GIG - alreadyOffered.size;
  if (slots <= 0) return result;

  const { data: profiles } = await db
    .from("profiles")
    .select("id, phone, phone_verified_at, sms_consent_at, sms_opt_out_at, full_name")
    .in("id", vendorIds.filter((id) => !alreadyOffered.has(id)));
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const text = gigOfferText({ kind: gig.kind, area, whenText: gig.windowText, offeredCents: gig.offeredCents, code: gig.code });

  let used = 0;
  for (const profile of (profiles ?? []) as Row[]) {
    if (used >= slots) { skip("cap_reached"); continue; }
    const vendorUserId = String(profile.id);
    const phone = normalizeE164(String(profile.phone ?? ""));
    if (!phone || !profile.phone_verified_at) { skip("no_verified_phone"); continue; }
    if (!profile.sms_consent_at || profile.sms_opt_out_at) { skip("no_consent"); continue; }
    const { count } = await db.from("gig_offers").select("id", { count: "exact", head: true }).eq("vendor_user_id", vendorUserId).gt("sent_at", since);
    if ((count ?? 0) >= MAX_GIG_OFFERS_PER_VENDOR_PER_DAY) { skip("vendor_daily_cap"); continue; }
    if (!(await rateLimit(`gig-offer-vendor:${vendorUserId}`, 6, 24 * 60 * 60 * 1000)).ok) { skip("rate_limited"); continue; }
    // Fail closed on the consent ledger: STOP anywhere is final, and an unreadable ledger texts nobody.
    const ledger = await readVendorTextConsent(db, { managerUserId: await serviceOwnerId(db), vendorUserId, phone }).catch(() => null);
    if (!ledger?.ok || ledger.state === "opted_out" || ledger.state === "revoked") { skip("stopped_or_unreadable"); continue; }

    const { data: inserted, error } = await db
      .from("gig_offers")
      .insert({ gig_id: gig.id, vendor_user_id: vendorUserId, channel: "sms", status: "sent", sent_at: now.toISOString() })
      .select("id")
      .maybeSingle();
    if (error || !inserted) { skip("already_offered"); continue; }
    used += 1;
    const sent = await (deps.send ?? defaultSend)(db, { toPhone: phone, text, dedupeKey: `gig-offer:${gig.id}:${vendorUserId}`, vendorUserId }).catch(() => ({ ok: false, reason: "send_failed" }));
    if (sent.ok) result.sent += 1;
    else {
      skip("send_refused");
      await db.from("gig_offers").update({ status: "failed" }).eq("id", String((inserted as Row).id)).then(() => undefined, () => undefined);
    }
  }
  return result;
}

async function serviceOwnerId(db: Db): Promise<string> {
  const { readPlatformServiceOwnerId } = await import("@/lib/service/service-catalog.server");
  const id = await readPlatformServiceOwnerId(db);
  if (!id) throw new Error("no_service_owner");
  return id;
}

/* ------------------------------------------------------------------------------------------ */
/* Accepting                                                                                  */
/* ------------------------------------------------------------------------------------------ */

export type GigAcceptResult =
  | { ok: true; already: boolean; gig: GigRecord }
  | { ok: false; reason: "not_found" | "closed" | "not_a_vendor" | "full" | "rate_limited" | "failed"; gig?: GigRecord };

/** The first confirmed-or-not moment a vendor says yes. Idempotent per (job, vendor); same core for SMS and the portal. */
export async function acceptGigOffer(
  db: Db,
  input: { vendorUserId: string; gigId?: string; code?: string; channel: "sms" | "portal" },
  deps: { now?: () => Date; origin?: string } = {},
): Promise<GigAcceptResult> {
  const now = (deps.now ?? (() => new Date()))();
  const gig = input.gigId ? await loadGigById(db, input.gigId) : input.code ? await loadGigByCode(db, input.code) : null;
  if (!gig) return { ok: false, reason: "not_found" };

  const { data: existing } = await db.from("gig_offers").select("id, status").eq("gig_id", gig.id).eq("vendor_user_id", input.vendorUserId).maybeSingle();
  if (existing && (existing as Row).status === "accepted") return { ok: true, already: true, gig };

  if (!(await gigIsOpen(db, gig))) return { ok: false, reason: "closed", gig };
  const eligibility = await resolveBoardEligibility(db as never, input.vendorUserId);
  if (!eligibility.ok) return { ok: false, reason: "not_a_vendor", gig };

  const { count: accepted } = await db.from("gig_offers").select("id", { count: "exact", head: true }).eq("gig_id", gig.id).eq("status", "accepted");
  if ((accepted ?? 0) >= MAX_GIG_ACCEPTS_PER_GIG) return { ok: false, reason: "full", gig };
  if (!(await rateLimit(`gig-accept:${input.vendorUserId}`, 12, 60 * 60 * 1000)).ok) return { ok: false, reason: "rate_limited", gig };

  const service = await loadServiceRow(db, gig.workOrderId);
  const ref = (service?.row as { publishRef?: string } | undefined)?.publishRef;
  if (!service || !ref) return { ok: false, reason: "closed", gig };

  // The existing door: a request on the board (roster row held, `sent` offer), then a submitted bid at the OFFERED price.
  const requested = await requestBoardJob(db as never, { userId: input.vendorUserId, role: "vendor" }, { ref, choice: "bid" });
  if (!requested.ok) return { ok: false, reason: requested.status === 429 ? "rate_limited" : "closed", gig };

  const { data: profile } = await db.from("profiles").select("email, full_name").eq("id", input.vendorUserId).maybeSingle();
  const startIso = await windowStartIso(db, gig, now);
  const bid = await submitWorkOrderBid(
    db as never,
    { userId: input.vendorUserId, email: String((profile as Row | null)?.email ?? "").toLowerCase(), fullName: String((profile as Row | null)?.full_name ?? ""), admin: false, role: "vendor" },
    { workOrderId: gig.workOrderId, amountCents: gig.offeredCents, materialsCents: 0, proposedTime: startIso, note: `Accepted the PropLane job at the offered ${formatGigUsd(gig.offeredCents)}${gig.windowText ? ` (${gig.windowText})` : ""}.` },
  );
  if (!bid.ok) return { ok: false, reason: "failed", gig };

  await db.from("gig_offers").upsert(
    { gig_id: gig.id, vendor_user_id: input.vendorUserId, channel: input.channel, status: "accepted", answered_at: now.toISOString() },
    { onConflict: "gig_id,vendor_user_id" },
  );
  await notifyManagerOfAcceptance(db, { gig, vendorUserId: input.vendorUserId, vendorName: String((profile as Row | null)?.full_name ?? ""), origin: deps.origin }).catch((error: unknown) =>
    console.error("gig acceptance notice failed", error instanceof Error ? error.message : "unknown"));
  return { ok: true, already: false, gig };
}

async function windowStartIso(db: Db, gig: GigRecord, now: Date): Promise<string> {
  // The posting stored only the words; the bid needs an instant. A concrete one is kept on the service row at post time.
  const service = await loadServiceRow(db, gig.workOrderId);
  const iso = (service?.row as { gigStartIso?: string } | undefined)?.gigStartIso;
  if (iso && !Number.isNaN(Date.parse(iso)) && Date.parse(iso) > now.getTime()) return iso;
  return new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
}

export async function declineGigOffer(db: Db, input: { vendorUserId: string; gigId: string }, now: Date = new Date()): Promise<void> {
  await db.from("gig_offers").update({ status: "declined", answered_at: now.toISOString() }).eq("gig_id", input.gigId).eq("vendor_user_id", input.vendorUserId).eq("status", "sent").then(() => undefined, () => undefined);
}

async function notifyManagerOfAcceptance(db: Db, input: { gig: GigRecord; vendorUserId: string; vendorName: string; origin?: string }): Promise<void> {
  const origin = (input.origin ?? resolveEmailLinkBaseUrl()).replace(/\/$/, "");
  const service = await loadServiceRow(db, input.gig.workOrderId);
  const first = input.vendorName.trim().split(/\s+/)[0] || "A vendor";
  const url = `${origin}/portal/services/${input.gig.workOrderId}`;
  const what = `${GIG_KIND_LABEL[input.gig.kind].toLowerCase()}${input.gig.windowText ? ` (${input.gig.windowText})` : ""}`;
  const text = `${first} took your ${what} at ${formatGigUsd(input.gig.offeredCents)}. Approve them to confirm (reply "approve ${first}" here, or open it): ${url}`;
  await notifyManagerFromAgent(db, {
    landlordId: input.gig.managerUserId,
    subject: `${first} took your ${what}`,
    text,
    url,
    category: "maintenance",
    notify: { push: true, sms: true },
    idempotencyKey: `gig-accept:${input.gig.id}:${input.vendorUserId}`,
    propertyId: service?.row.propertyId ?? null,
    workspaceId: input.gig.workspaceId,
  });
}

/* ------------------------------------------------------------------------------------------ */
/* A vendor's text: YES / NO with or without the code                                         */
/* ------------------------------------------------------------------------------------------ */

export type GigReplyTurn = { handled: false } | { handled: true; reply: string; vendorUserId: string | null };

export const GIG_REPLY_COPY = {
  accepted: (g: GigRecord) => `Got it. I told the manager you will take it for ${formatGigUsd(g.offeredCents)}. If they pick you I will text you the address and details.`,
  already: "You already took this one. I will text you as soon as the manager confirms.",
  closed: "Sorry, that job is already taken or closed. Text me 'any work' to see what else is open.",
  full: "Enough vendors have already taken that one. Text me 'any work' to see what else is open.",
  declined: "No problem, I will not ask about that one again.",
  notVendor: (link: string) => `To take PropLane jobs you need a free vendor account. Create it here: ${link}`,
  which: (lines: string[]) => `Which job? Reply YES and the code:\n${lines.join("\n")}`,
  rateLimited: "Too many tries just now. Please try again in a bit.",
  failed: "I could not save that just now. Please try again in a minute, or take it in Find work.",
} as const;

/** Open offers this vendor was texted, newest first, still within their window. */
async function openOffersFor(db: Db, vendorUserId: string, now: Date): Promise<GigRecord[]> {
  const since = new Date(now.getTime() - GIG_OFFER_WINDOW_MS).toISOString();
  const { data } = await db.from("gig_offers").select("gig_id, status, sent_at").eq("vendor_user_id", vendorUserId).eq("status", "sent").gt("sent_at", since).order("sent_at", { ascending: false }).limit(10);
  const out: GigRecord[] = [];
  for (const offer of (data ?? []) as Row[]) {
    const gig = await loadGigById(db, String(offer.gig_id));
    if (gig && (await gigIsOpen(db, gig))) out.push(gig);
  }
  return out;
}

export async function hasOpenGigOffer(db: Db, vendorUserId: string, now: Date = new Date()): Promise<boolean> {
  return (await openOffersFor(db, vendorUserId, now)).length > 0;
}

/**
 * The vendor's text is a reply to a job offer. `vendorUserId` is the account whose VERIFIED phone texted (read by the
 * caller, never from the text); null = a stranger, who is invited to sign up. A bare YES needs exactly one open offer.
 */
export async function handleGigReplyText(
  db: Db,
  input: { vendorUserId: string | null; body: string; signupLink?: () => Promise<string | null> },
  deps: { now?: () => Date; origin?: string } = {},
): Promise<GigReplyTurn> {
  const now = (deps.now ?? (() => new Date()))();
  const reply: GigReply | null = parseGigReply(input.body);
  if (!reply) return { handled: false };

  if (!input.vendorUserId) {
    // A stranger can only be answering a code (a bare YES is nobody's reply). Invite them; never accept.
    if (!reply.code || !(await loadGigByCode(db, reply.code))) return { handled: false };
    const link = (await input.signupLink?.().catch(() => null)) ?? `${(deps.origin ?? resolveEmailLinkBaseUrl()).replace(/\/$/, "")}/auth/create-account`;
    return { handled: true, reply: toGsm7(GIG_REPLY_COPY.notVendor(link)), vendorUserId: null };
  }

  let gig: GigRecord | null = null;
  if (reply.code) {
    gig = await loadGigByCode(db, reply.code);
    if (!gig) return { handled: false };
  } else {
    const open = await openOffersFor(db, input.vendorUserId, now);
    if (open.length === 0) return { handled: false };
    if (open.length > 1 && reply.action === "accept") {
      return { handled: true, reply: toGsm7(GIG_REPLY_COPY.which(open.slice(0, 3).map((g) => `${g.code}: ${GIG_KIND_LABEL[g.kind]}, ${formatGigUsd(g.offeredCents)}`))), vendorUserId: input.vendorUserId };
    }
    gig = open[0]!;
  }

  if (reply.action === "decline") {
    await declineGigOffer(db, { vendorUserId: input.vendorUserId, gigId: gig.id }, now);
    return { handled: true, reply: toGsm7(GIG_REPLY_COPY.declined), vendorUserId: input.vendorUserId };
  }
  const result = await acceptGigOffer(db, { vendorUserId: input.vendorUserId, gigId: gig.id, channel: "sms" }, deps);
  if (result.ok) return { handled: true, reply: toGsm7(result.already ? GIG_REPLY_COPY.already : GIG_REPLY_COPY.accepted(result.gig)), vendorUserId: input.vendorUserId };
  const text =
    result.reason === "closed" || result.reason === "not_found" ? GIG_REPLY_COPY.closed
    : result.reason === "full" ? GIG_REPLY_COPY.full
    : result.reason === "rate_limited" ? GIG_REPLY_COPY.rateLimited
    : result.reason === "not_a_vendor" ? GIG_REPLY_COPY.notVendor(`${(deps.origin ?? resolveEmailLinkBaseUrl()).replace(/\/$/, "")}/vendor/profile`)
    : GIG_REPLY_COPY.failed;
  return { handled: true, reply: toGsm7(text), vendorUserId: input.vendorUserId };
}

/* ------------------------------------------------------------------------------------------ */
/* The read: open priced jobs near a vendor, general area only                                */
/* ------------------------------------------------------------------------------------------ */

export type OpenGigLine = { code: string; kind: GigKind; kindLabel: string; area: string; when: string; pays: string; line: string };

/** Map the board's own (area-filtered, trade-filtered) projection onto the priced jobs among it. Never carries a street, unit, id or name. */
export async function openGigLinesFor(
  db: Db,
  jobs: { serviceId?: string; area: string; when: string }[],
): Promise<{ lines: OpenGigLine[]; serviceIds: Set<string> }> {
  const ids = jobs.map((j) => j.serviceId).filter((v): v is string => Boolean(v));
  const serviceIds = new Set<string>();
  if (ids.length === 0) return { lines: [], serviceIds };
  const { data } = await db.from("gig_posts").select(GIG_COLUMNS).in("work_order_id", ids).eq("status", "open");
  const byService = new Map(((data ?? []) as Row[]).map((r) => [String(r.work_order_id), toGig(r)]));
  const lines: OpenGigLine[] = [];
  for (const job of jobs) {
    const gig = job.serviceId ? byService.get(job.serviceId) : undefined;
    if (!gig) continue;
    serviceIds.add(gig.workOrderId);
    const when = gig.windowText || (job.when !== "Anytime" ? job.when : "");
    lines.push({
      code: gig.code,
      kind: gig.kind,
      kindLabel: GIG_KIND_LABEL[gig.kind],
      area: job.area,
      when,
      pays: formatGigUsd(gig.offeredCents),
      line: gigListLine({ kind: gig.kind, area: job.area, whenText: when || null, offeredCents: gig.offeredCents, code: gig.code }),
    });
  }
  return { lines, serviceIds };
}
