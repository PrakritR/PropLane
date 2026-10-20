import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { isMissingSchemaError } from "@/lib/one-number/config.server";
import { redactSensitiveNumbers } from "@/lib/one-number/redact";
import { mintSetupLink } from "@/lib/one-number/onboarding/setup-links.server";
import { appendLineTurn, findOrCreateLineSession, loadLineHistory } from "@/lib/one-number/vendor-jobs/history.server";
import { classifyLineText } from "@/lib/one-number/line-intent";
import { asksForJobs, CONTROL_ONLY_RE, readVendorJobsAsk, tradeLabelFor, type VendorJobsAsk } from "@/lib/one-number/vendor-jobs/intent";
import { composeVendorAnswerReply, composeVendorHelpReply, composeVendorJobsReply, type VendorLineLink } from "@/lib/one-number/vendor-jobs/reply";
import { normalizeE164 } from "@/lib/phone-e164";
import { resolveSeattlePlace } from "@/lib/places/seattle-places";
import { profilePhoneVariants } from "@/lib/sms-consent";
import { parseNameFromInboundText } from "@/lib/sms/inbound-text-classification";
import { phoneKeyOf } from "@/lib/sms/phone-key";
import { buildVendorLineContext } from "@/lib/tools/vendor-line-context";
import { listOpenJobsNearTool } from "@/lib/tools/domains/vendor-line";
import { VENDOR_TRADE_OPTIONS } from "@/lib/work-order-taxonomy";

/**
 * A vendor texting the PropLane line (W24): "hey is there any available jobs in the area to do".
 *
 *  - Everyone who reads as a vendor gets a reply: the open jobs they can do (`list_open_jobs_near`, the Find work
 *    board's own public view, nearest the place they name), plus ONE link: a vendor with an account gets the Find work
 *    page, a stranger gets their phone-bound vendor sign-up link (`mintSetupLink`).
 *  - A stranger is captured in `sms_vendor_leads` (status pending, one live row per phone) for platform admin. Nothing
 *    here writes the service owner's `manager_vendor_records`, a workspace, or a dispatch rule.
 *  - Every turn is saved (`history.server.ts`) and the last turns are read back on the next text, so "Ballard" after
 *    "any jobs?" is answered with the trade they named earlier.
 * No model runs here: the copy is fixed, the numbers are the job list's.
 */

export const SIGNUP_LINK_WINDOW_MS = 6 * 60 * 60 * 1000;

export type VendorLineTurn = {
  handled: boolean;
  reply: string | null;
  vendorUserId: string | null;
  leadId: string | null;
};

const NOT_HANDLED: VendorLineTurn = { handled: false, reply: null, vendorUserId: null, leadId: null };

type Row = Record<string, unknown>;
type LeadProfile = {
  trade?: string;
  area?: string;
  areaText?: string;
  name?: string;
  source?: string;
  firstText?: string;
  linkMintedAt?: string;
  [key: string]: unknown;
};

export { phoneKeyOf };

/** The vendor account whose VERIFIED phone this is (one owner only), or null. Never a roster row, never the text. */
export async function resolveVendorAccountByPhone(db: SupabaseClient, phoneE164: string): Promise<{ userId: string } | null> {
  try {
    const { data, error } = await db
      .from("profiles")
      .select("id, phone, phone_verified_at")
      .in("phone", profilePhoneVariants(phoneE164))
      .not("phone_verified_at", "is", null)
      .limit(5);
    if (error) return null;
    const owners = [
      ...new Set(((data ?? []) as Row[]).filter((r) => normalizeE164(String(r.phone ?? "")) === phoneE164).map((r) => String(r.id))),
    ];
    if (owners.length !== 1) return null;
    const { data: vendor } = await db.from("vendor_business_profiles").select("user_id").eq("user_id", owners[0]!).maybeSingle();
    return vendor ? { userId: owners[0]! } : null;
  } catch {
    return null;
  }
}

async function findLiveLead(db: SupabaseClient, phoneKey: string): Promise<{ id: string; status: string; profile: LeadProfile } | null> {
  const { data, error } = await db
    .from("sms_vendor_leads")
    .select("id, status, profile")
    .eq("phone_key", phoneKey)
    .in("status", ["collecting", "pending"])
    .maybeSingle();
  if (error || !data) return null;
  const row = data as Row;
  const profile = row.profile && typeof row.profile === "object" && !Array.isArray(row.profile) ? (row.profile as LeadProfile) : {};
  return { id: String(row.id), status: String(row.status), profile };
}

/** One live lead per phone (a partial unique index): create or merge, status pending. */
async function captureLead(
  db: SupabaseClient,
  input: { phoneKey: string; existing: Awaited<ReturnType<typeof findLiveLead>>; patch: LeadProfile; now: Date },
): Promise<{ id: string; profile: LeadProfile } | null> {
  const clean: LeadProfile = Object.fromEntries(Object.entries(input.patch).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  if (input.existing) {
    const profile = { ...input.existing.profile, ...clean };
    const { error } = await db
      .from("sms_vendor_leads")
      .update({ status: "pending", profile, updated_at: input.now.toISOString() })
      .eq("id", input.existing.id);
    return error ? { id: input.existing.id, profile: input.existing.profile } : { id: input.existing.id, profile };
  }
  const inserted = await db
    .from("sms_vendor_leads")
    .insert({ phone_key: input.phoneKey, status: "pending", profile: clean })
    .select("id, profile")
    .maybeSingle();
  if (inserted.data) return { id: String((inserted.data as Row).id), profile: clean };
  if (inserted.error?.code === "23505") {
    const again = await findLiveLead(db, input.phoneKey);
    if (again) return captureLead(db, { ...input, existing: again });
  }
  if (inserted.error && !isMissingSchemaError(inserted.error)) console.error("vendor line lead capture failed", inserted.error.code ?? "unknown");
  return null;
}

export type VendorLineDeps = { now?: () => Date; origin?: string };

export async function handlePropLaneVendorText(
  db: SupabaseClient,
  input: {
    /** The platform service owner whose line was texted; history and the inbox thread live under it. Null = no history. */
    ownerUserId: string | null;
    phoneE164: string;
    body: string;
    messageSid: string;
    /** `service_line`: every text from a known vendor or lead is answered. `shared`: only a jobs / link ask is. */
    mode: "service_line" | "shared";
    /** The caller already decided this sender is a vendor (the shared-line onboarding did). */
    force?: boolean;
  },
  deps: VendorLineDeps = {},
): Promise<VendorLineTurn> {
  const phone = normalizeE164(input.phoneE164);
  const body = redactSensitiveNumbers(String(input.body ?? "")).text.slice(0, 1000);
  if (!phone || !body.trim() || CONTROL_ONLY_RE.test(body)) return NOT_HANDLED;
  const now = (deps.now ?? (() => new Date()))();
  const phoneKey = phoneKeyOf(phone);

  // Looking for a place to live is never a vendor turn, however this phone was read before. Intent is decided per
  // MESSAGE (captain, Oct 19): a live `sms_vendor_leads` row has no expiry, so without this escape one "handyman
  // here" locked that phone out of the catalog search for good.
  if (classifyLineText(body).kind === "housing_search") return NOT_HANDLED;

  const ask = readVendorJobsAsk(body);
  const [account, lead] = await Promise.all([resolveVendorAccountByPhone(db, phone), findLiveLead(db, phoneKey)]);
  const known = Boolean(account || lead);
  const triggered =
    input.force === true ||
    ask.vendorish ||
    // On the PropLane line a stranger naming a trade ("handyman here", "cleaner") is a vendor: answered, never silently listed.
    (input.mode === "service_line" && ask.tradeSelfId) ||
    (known && (input.mode === "service_line" || ask.wantsJobs || ask.wantsLink));
  if (!triggered) return NOT_HANDLED;

  const history = input.ownerUserId ? await loadLineHistory(db, { ownerUserId: input.ownerUserId, phoneE164: phone }) : { sessionId: null, messages: [] };
  // A retried webhook says exactly what it said the first time.
  const prior = input.messageSid ? history.messages.find((m) => m.sid === `${input.messageSid}:reply`) : undefined;
  if (prior) return { handled: true, reply: prior.content, vendorUserId: account?.userId ?? null, leadId: lead?.id ?? null };
  const firstReply = !history.messages.some((m) => m.role === "assistant");

  const { trade, areaText, unknownArea } = effectiveContext(ask, lead?.profile ?? {}, history.messages);
  const tradeLabel = tradeLabelFor(trade);
  const boardTrade = tradeLabel && tradeLabel !== "Other" && (VENDOR_TRADE_OPTIONS as readonly string[]).includes(tradeLabel) ? tradeLabel : null;

  // Stranger: capture the lead (pending) before anything else can fail.
  let savedLead: { id: string; profile: LeadProfile } | null = lead ? { id: lead.id, profile: lead.profile } : null;
  if (!account) {
    savedLead = await captureLead(db, {
      phoneKey,
      existing: lead,
      now,
      patch: {
        source: "propline_line",
        trade: trade ?? undefined,
        area: (areaText ? resolveSeattlePlace(areaText)?.label : null) ?? ask.unknownArea ?? lead?.profile.area ?? undefined,
        areaText: ask.areaText ? ask.areaText.slice(0, 200) : undefined,
        name: lead?.profile.name ?? parseNameFromInboundText(body) ?? undefined,
        firstText: lead?.profile.firstText ?? body.slice(0, 200),
      },
    });
  }

  const ctx = buildVendorLineContext(db, { landlordId: input.ownerUserId ?? "", senderPhone: phone, vendorUserId: account?.userId ?? null });
  // A question about PropLane itself ("how do I get paid?") is answered, unless the text also asks for jobs or names a place.
  const answerTopic = ask.question && !asksForJobs(body) && !ask.areaText ? ask.question : null;
  const wantsList = !answerTopic && (ask.wantsJobs || ask.vendorish || Boolean(boardTrade) || Boolean(areaText));
  let reply: string;
  const link = await chooseLink(db, {
    account, phoneKey, lead: savedLead, wantsLink: ask.wantsLink, now, origin: deps.origin,
  });
  if (answerTopic) {
    const origin = (deps.origin ?? resolveEmailLinkBaseUrl()).replace(/\/$/, "");
    reply = composeVendorAnswerReply({ firstReply, topic: answerTopic, link: link.link, payoutsUrl: `${origin}/vendor/financials/payouts` });
  } else if (wantsList) {
    let listed: Awaited<ReturnType<typeof listOpenJobsNearTool.handler>> | null = null;
    try {
      listed = await listOpenJobsNearTool.handler(ctx, { ...(boardTrade ? { trade: boardTrade as (typeof VENDOR_TRADE_OPTIONS)[number] } : {}), ...(areaText ? { area: areaText } : {}) });
    } catch (error) {
      console.error("vendor line job list failed", error instanceof Error ? error.message : "unknown");
    }
    reply = listed
      ? composeVendorJobsReply({
          firstReply,
          jobs: unknownArea && !areaText ? [] : listed.jobs,
          total: unknownArea && !areaText ? 0 : listed.total,
          placeLabel: listed.place?.label ?? null,
          tradeLabel: boardTrade,
          filteredByArea: listed.filteredByArea,
          unknownArea: unknownArea && !areaText ? unknownArea : null,
          link: link.link,
        })
      : composeVendorHelpReply({ firstReply, link: link.link });
  } else {
    reply = composeVendorHelpReply({ firstReply, link: link.link });
  }

  if (savedLead && link.mintedAt) {
    await db
      .from("sms_vendor_leads")
      .update({ profile: { ...savedLead.profile, linkMintedAt: link.mintedAt }, updated_at: now.toISOString() })
      .eq("id", savedLead.id)
      .then(() => undefined, () => undefined);
  }
  if (input.ownerUserId) {
    const sessionId = history.sessionId ?? (await findOrCreateLineSession(db, { ownerUserId: input.ownerUserId, phoneE164: phone, vendorUserId: account?.userId ?? null }));
    if (sessionId) await appendLineTurn(db, { sessionId, ownerUserId: input.ownerUserId, inbound: body, reply, messageSid: input.messageSid, now });
  }
  return { handled: true, reply, vendorUserId: account?.userId ?? null, leadId: savedLead?.id ?? null };
}

/** This text, backed by the lead's saved facts and then the last texts of the chat: what trade, and what area. */
function effectiveContext(
  ask: VendorJobsAsk,
  profile: LeadProfile,
  messages: { role: string; content: string }[],
): { trade: string | null; areaText: string | null; unknownArea: string | null } {
  let trade = ask.trade ?? null;
  let areaText = ask.areaText;
  const unknownArea = ask.unknownArea;
  if (!trade && profile.trade) trade = profile.trade;
  if (!areaText && typeof profile.areaText === "string") areaText = profile.areaText;
  if (!trade || !areaText) {
    for (const message of [...messages].reverse()) {
      if (message.role !== "user") continue;
      const past = readVendorJobsAsk(message.content);
      if (!trade && past.trade) trade = past.trade;
      if (!areaText && past.areaText) areaText = past.areaText;
      if (trade && areaText) break;
    }
  }
  return { trade, areaText, unknownArea };
}

async function chooseLink(
  db: SupabaseClient,
  input: {
    account: { userId: string } | null;
    phoneKey: string;
    lead: { id: string; profile: LeadProfile } | null;
    wantsLink: boolean;
    now: Date;
    origin?: string;
  },
): Promise<{ link: VendorLineLink; mintedAt: string | null }> {
  const origin = (input.origin ?? resolveEmailLinkBaseUrl()).replace(/\/$/, "");
  if (input.account) return { link: { kind: "findwork", url: `${origin}/vendor/work-orders/find-work` }, mintedAt: null };
  const last = input.lead?.profile.linkMintedAt ? Date.parse(input.lead.profile.linkMintedAt) : NaN;
  const fresh = Number.isFinite(last) && input.now.getTime() - last < SIGNUP_LINK_WINDOW_MS;
  // One link per window: it is in the earlier text unless they ask for another.
  if (fresh && !input.wantsLink) return { link: { kind: "earlier" }, mintedAt: null };
  const minted = await mintSetupLink(db, {
    kind: "vendor",
    phoneKey: input.phoneKey,
    context: { source: "direct", ...(input.lead ? { vendorLeadId: input.lead.id } : {}) },
    origin: input.origin,
    now: input.now,
  });
  if (minted.ok) return { link: { kind: "signup", url: minted.url }, mintedAt: input.now.toISOString() };
  return { link: minted.reason === "rate_limited" ? { kind: "busy" } : { kind: "none" }, mintedAt: null };
}

/** A live lead that came in through the PropLane line's jobs flow (so later texts stay in it, not in the intake questions). */
export async function isPropLaneLineVendorLead(db: SupabaseClient, phoneKey: string): Promise<boolean> {
  try {
    return (await findLiveLead(db, phoneKey))?.profile.source === "propline_line";
  } catch {
    return false;
  }
}
