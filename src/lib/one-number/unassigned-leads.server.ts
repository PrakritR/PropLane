import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { MockProperty } from "@/data/types";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { isMissingSchemaError, loadSharedLineConfig, workspaceOnSharedLine } from "@/lib/one-number/config.server";
import type { SharedLineConfig, SharedLineInbound } from "@/lib/one-number/contracts";
import { extractLeadFieldsWithModel } from "@/lib/one-number/lead-extract.server";
import {
  buildOfferBubbles,
  buildOfferText,
  countFittingRooms,
  MAX_STRANGER_OFFERS,
  type OfferBubble,
  matchOffers,
  NO_MATCH_TEXT,
  offerFromRow,
  parseOfferPick,
} from "@/lib/one-number/lead-match";
import {
  applyAnswer,
  mergeModelFields,
  missingSteps,
  NEUTRAL_REPLY,
  nextQuestion,
  pacificToday,
  toGsm7,
  touchesProtectedTopic,
  WELCOME,
  withoutProtectedClauses,
  type LeadOffer,
  type LeadProfile,
} from "@/lib/one-number/lead-qualifying";
import { redactSensitiveNumbers } from "@/lib/one-number/redact";
import { findWorkspaceProspectCandidate, propertyLabel } from "@/lib/one-number/router-lookups.server";
import { saveSharedLineRoute } from "@/lib/one-number/session.server";
import {
  HOLD_REPLY,
  lookingForLine,
  offerLabel,
  PAID_NUMBER_UNAVAILABLE_REPLY,
  paidInterestReply,
  switchQuestion,
} from "@/lib/one-number/home-lock";
import { loadHome, ownerFirstName, recordPaidInterest, tagLockedHouse, workspaceIsService, writeLookingForTurn } from "@/lib/one-number/home-lock.server";
import { matchListingsNamedIn, streetLine } from "@/lib/one-number/house-redirect";
import { lineTierOf, type LineListing } from "@/lib/one-number/line-tier";
import { paidWorkNumberFor } from "@/lib/one-number/self-serve-line.server";
import { alertWorkspaceTeam } from "@/lib/one-number/team-alerts.server";
import { upsertManagerSmsContact } from "@/lib/sms/manager-sms-contacts.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { resolveHouseRedirect } from "@/lib/one-number/house-redirect.server";
import { getLineOfferListings } from "@/lib/one-number/line-catalog.server";

export type UnassignedLeadTurn = {
  leadId: string | null;
  /** Text to send back on the shared line, or null when nothing should go out. */
  reply: string | null;
  /** Set once the prospect picked or toured a room: the router re-routes them there. */
  assignedWorkspaceId: string | null;
  /** Every real listing photo the reply carries (one per offered room), as MMS. */
  mediaUrls?: string[];
  /** The reply as separate texts (one per offered room with its own photo, then how to pick); `reply` is them joined. */
  bubbles?: OfferBubble[];
};

/** A lead's stored text never keeps a card, bank or SSN number (the one redaction, `redact.ts`). */
function redactLeadBody(body: string): string {
  return redactSensitiveNumbers(body).text.slice(0, 1000);
}

export type LeadDeps = {
  now?: () => Date;
  /** Live public listings (the hourly projected catalog), each tagged with its tier when the line is shared. */
  listings?: () => Promise<LineListing[]>;
  /** The work number the home's manager PAYS for (never the shared line), or null. */
  paidNumberOf?: (listing: MockProperty) => Promise<string | null>;
  /** A workspace owner's first name, or null. */
  firstNameOf?: (ownerUserId: string) => Promise<string | null>;
  /** Fallback answer reader. Receives text already stripped of protected clauses. */
  extract?: (input: { text: string; today: string }) => Promise<Partial<LeadProfile> | null>;
  origin?: () => string;
  /** Reply for a text naming one home PropLane does not manage (its team's own number or public page), or null. */
  houseRedirect?: (text: string) => Promise<string | null>;
};

type Row = Record<string, unknown>;
export type LeadRow = { id: string; phoneKey: string; status: string; profile: LeadProfile; lastInboundAt: string | null; updatedAt: string };

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const EMPTY_TURN: UnassignedLeadTurn = { leadId: null, reply: null, assignedWorkspaceId: null };

function toLead(row: Row): LeadRow {
  const profile = row.profile && typeof row.profile === "object" && !Array.isArray(row.profile) ? (row.profile as LeadProfile) : {};
  return {
    id: str(row.id),
    phoneKey: str(row.phone_key),
    status: str(row.status),
    profile,
    lastInboundAt: row.last_inbound_at ? str(row.last_inbound_at) : null,
    updatedAt: str(row.updated_at),
  };
}

const LEAD_COLUMNS = "id, phone_key, status, profile, last_inbound_at, updated_at";

/** E.164 for a stored phone key (10 digits for NANP). */
export function e164FromPhoneKey(phoneKey: string): string {
  const digits = phoneKey.replace(/\D/g, "");
  return normalizeE164(digits.length === 10 ? `+1${digits}` : `+${digits}`) ?? `+${digits}`;
}

/**
 * `missing` = the lead tables are not there yet (code before the migration): nothing is stored and nothing is said.
 * `unavailable` = they are there and the read or insert failed, which is a first text we still owe an answer.
 */
type LeadLookup = { kind: "lead"; lead: LeadRow } | { kind: "missing" } | { kind: "unavailable" };

export async function findOrCreateOpenLead(db: SupabaseClient, phoneKey: string, nowIso: string): Promise<LeadLookup> {
  const read = () => db.from("sms_unassigned_leads").select(LEAD_COLUMNS).eq("phone_key", phoneKey).eq("status", "open").maybeSingle();
  const first = await read();
  if (first.error) return isMissingSchemaError(first.error) ? { kind: "missing" } : { kind: "unavailable" };
  if (first.data) return { kind: "lead", lead: toLead(first.data as Row) };
  const created = await db
    .from("sms_unassigned_leads")
    .insert({ phone_key: phoneKey, status: "open", profile: {}, last_inbound_at: nowIso })
    .select(LEAD_COLUMNS)
    .maybeSingle();
  if (created.data) return { kind: "lead", lead: toLead(created.data as Row) };
  // A concurrent first text won the unique open-phone index: take its row.
  if (created.error?.code === "23505") {
    const again = await read();
    if (again.data) return { kind: "lead", lead: toLead(again.data as Row) };
    return again.error && isMissingSchemaError(again.error) ? { kind: "missing" } : { kind: "unavailable" };
  }
  if (created.error && isMissingSchemaError(created.error)) return { kind: "missing" };
  return { kind: "unavailable" };
}

/**
 * The reply a first text on the PropLane line gets when the turn itself could not be produced (the lead store was
 * unavailable, the turn insert failed, an unexpected throw). Deterministic - the welcome plus the first qualifying
 * question - so a stranger's first text is never answered with silence, and a retry says exactly the same thing.
 */
export function firstTextFallbackReply(): string {
  const question = nextQuestion({});
  return toGsm7(`${WELCOME}${question ? ` ${question.text}` : ""}`);
}

export async function storedReplyFor(db: SupabaseClient, leadId: string, messageSid: string): Promise<string | null> {
  const { data } = await db
    .from("sms_unassigned_lead_turns")
    .select("body")
    .eq("lead_id", leadId)
    .eq("message_sid", `reply:${messageSid}`)
    .maybeSingle();
  const body = str((data as Row | null)?.body);
  return body || null;
}

export async function saveProfile(db: SupabaseClient, lead: LeadRow, profile: LeadProfile, extra: Record<string, unknown> = {}): Promise<void> {
  const now = new Date().toISOString();
  await db.from("sms_unassigned_leads").update({ profile, updated_at: now, ...extra }).eq("id", lead.id).eq("status", "open");
}

export async function recordReply(db: SupabaseClient, leadId: string, messageSid: string, body: string, mediaUrls: string[]): Promise<void> {
  await db.from("sms_unassigned_lead_turns").insert({
    lead_id: leadId,
    direction: "outbound",
    body,
    message_sid: messageSid ? `reply:${messageSid}` : null,
    media: mediaUrls.length ? { urls: mediaUrls } : null,
  });
}

const PICK_PROMPT = (n: number) =>
  `Reply ${n === 1 ? "1" : n === 2 ? "1 or 2" : n === 3 ? "1, 2 or 3" : "1, 2, 3 or 4"} to pick a room, or TOUR to see one.`;

type FlowResult = { profile: LeadProfile; reply: string; mediaUrls: string[]; bubbles?: OfferBubble[]; assign?: { propertyId: string; roomId: string; tier?: LeadOffer["tier"] } };

async function matchAndOffer(profile: LeadProfile, deps: Required<Pick<LeadDeps, "now" | "listings" | "origin">>): Promise<FlowResult> {
  const today = pacificToday(deps.now());
  let listings: MockProperty[];
  try {
    listings = await deps.listings();
  } catch {
    // A failed catalog read is not "no room": say so and search again on the next text.
    return {
      profile: { ...profile, stage: "qualifying", asked: "refine" },
      reply: "I could not check rooms just now. Text me again in a minute and I will try again.",
      mediaUrls: [],
    };
  }
  // One PropLane-managed, one free-manager and one paid-manager home when each has a fit, never two from one manager.
  const picks = matchOffers(listings, profile, today);
  if (picks.length === 0) {
    return { profile: { ...profile, stage: "no_match", asked: null, offers: [] }, reply: NO_MATCH_TEXT, mediaUrls: [] };
  }
  const rows = picks.map((p) => p.row);
  const offers = picks.map((p, i) => offerFromRow(p.row, i + 1, p.tier));
  const bubbles = buildOfferBubbles(offers, rows, deps.origin());
  return {
    profile: { ...profile, stage: "offered", asked: "pick", offers },
    // The joined text is what a retry and the inbox log show; the bubbles are what the prospect receives.
    reply: buildOfferText(offers, deps.origin()),
    mediaUrls: bubbles.flatMap((b) => (b.mediaUrl ? [b.mediaUrl] : [])),
    bubbles,
  };
}

async function readAnswer(
  profile: LeadProfile,
  text: string,
  deps: Required<Pick<LeadDeps, "now" | "extract">>,
): Promise<{ profile: LeadProfile; neutral: boolean; changed: boolean }> {
  const result = applyAnswer(profile, text, deps.now());
  let next = result.profile;
  let changed = result.changed.length > 0;
  if (!changed) {
    const safe = redactLeadBody(result.neutral ? withoutProtectedClauses(text) : text);
    if (safe.trim().length >= 2) {
      const fields = await deps.extract({ text: safe, today: pacificToday(deps.now()) }).catch(() => null);
      if (fields && Object.keys(fields).length > 0) {
        next = mergeModelFields(next, fields, profile.asked);
        changed = JSON.stringify(next) !== JSON.stringify(result.profile);
      }
    }
  }
  return { profile: next, neutral: result.neutral, changed };
}

/**
 * One turn of the lead conversation. Pure over (profile, text) plus the catalog; the caller persists.
 * Order of questions is fixed (`missingSteps`); an answer to a later question volunteered early is kept.
 */
async function runFlow(
  profile: LeadProfile,
  text: string,
  first: boolean,
  deps: Required<LeadDeps>,
): Promise<FlowResult> {
  const stage = profile.stage ?? "qualifying";

  if (stage === "offered") {
    const offers = profile.offers ?? [];
    const pick = parseOfferPick(text, offers);
    if (pick.kind === "pick") {
      return { profile, reply: "", mediaUrls: [], assign: { propertyId: pick.offer.propertyId, roomId: pick.offer.roomId, tier: pick.offer.tier } };
    }
    if (pick.kind === "which") return { profile, reply: `Which one? ${PICK_PROMPT(offers.length)}`, mediaUrls: [] };
    if (pick.kind === "decline") {
      return {
        profile: { ...profile, stage: "qualifying", asked: "refine", offers: [] },
        reply: "No problem. Send a new budget, area or move-in date and I will search again.",
        mediaUrls: [],
      };
    }
    const read = await readAnswer({ ...profile, asked: "refine" }, text, deps);
    if (read.changed) return matchAndOffer({ ...read.profile, offers: [] }, deps);
    return { profile, reply: `${read.neutral || touchesProtectedTopic(text) ? `${NEUTRAL_REPLY} ` : ""}${PICK_PROMPT(offers.length)}`, mediaUrls: [] };
  }

  if (stage === "no_match") {
    const read = await readAnswer({ ...profile, asked: "refine" }, text, deps);
    if (read.changed) return matchAndOffer({ ...read.profile, offers: [] }, deps);
    return {
      profile,
      reply: `${read.neutral ? `${NEUTRAL_REPLY} ` : ""}I will text you once if a room opens up. Send a new budget or area to search again.`,
      mediaUrls: [],
    };
  }

  // Qualifying (including a first text).
  const read = await readAnswer(profile, text, deps);
  const next: LeadProfile = { ...read.profile, stage: "qualifying" };
  let question = nextQuestion(next);
  // Keep asking while more than 4 rooms fit. Everything that can narrow the search is asked (budget, move-in, area, room
  // type); the headcount never filters, so once those are in and 4 or fewer rooms fit, the offers go out without it.
  if (question && missingSteps(next).every((step) => step === "household")) {
    const fits = await deps.listings().then((all) => countFittingRooms(all, next, pacificToday(deps.now()))).catch(() => null);
    if (fits !== null && fits >= 1 && fits <= MAX_STRANGER_OFFERS) question = null;
  }
  if (!question) {
    const offered = await matchAndOffer(next, deps);
    if (!first) return offered;
    // The very first reply carries the business name and the STOP notice, in front of the first room.
    const bubbles = offered.bubbles?.map((b, i) => (i === 0 ? { ...b, body: toGsm7(`${WELCOME} ${b.body}`) } : b));
    return { ...offered, reply: `${WELCOME} ${offered.reply}`, ...(bubbles ? { bubbles } : {}) };
  }
  next.asked = question.step;
  const parts: string[] = [];
  if (first) parts.push(WELCOME);
  if (read.neutral) parts.push(NEUTRAL_REPLY);
  else if (!first && !read.changed) parts.push("Sorry, I did not get that.");
  parts.push(question.text);
  return { profile: next, reply: parts.join(" "), mediaUrls: [] };
}

/**
 * Step 7 of the router: a new prospect with no entry code is qualified in the platform
 * "Unassigned leads" queue, one question at a time, then matched to live public rooms. Nothing in
 * the reply is model-written. The stored turn is redacted (card / bank / SSN numbers never land).
 * Fails closed: with the tables missing, nothing is stored and nothing is said.
 */
export async function handleUnassignedLeadInbound(
  db: SupabaseClient,
  inbound: SharedLineInbound,
  depsIn: LeadDeps = {},
): Promise<UnassignedLeadTurn> {
  // The homes the line shows: managed homes in per_workspace mode; in shared mode (the 206 is every free manager's number)
  // also every self-serve home without a personal number (`line-catalog.server.ts`).
  const listings = depsIn.listings ?? (() => getLineOfferListings(db));
  const deps: Required<LeadDeps> = {
    now: depsIn.now ?? (() => new Date()),
    // A stranger on the PropLane line is shown the homes the line serves (see `getLineCatalogListings`) and no one else's.
    listings,
    paidNumberOf:
      depsIn.paidNumberOf ??
      (async (l: MockProperty) => (l.managerUserId ? paidWorkNumberFor(db, { ownerUserId: l.managerUserId, workspaceId: l.workspaceId ?? null }) : null)),
    firstNameOf: depsIn.firstNameOf ?? ((ownerUserId: string) => ownerFirstName(db, ownerUserId)),
    extract: depsIn.extract ?? extractLeadFieldsWithModel,
    origin: depsIn.origin ?? resolveEmailLinkBaseUrl,
    houseRedirect: depsIn.houseRedirect ??
      (async (text: string) => {
        const shared = await loadSharedLineConfig(db).catch(() => null);
        return resolveHouseRedirect(db, text, { serviceListings: listings, shared });
      }),
  };
  // Set as soon as a lead row is in hand, so the catch below can tell a first text from a conversation in progress.
  let known: LeadRow | null = null;
  try {
    const nowIso = deps.now().toISOString();
    const found = await findOrCreateOpenLead(db, inbound.phoneKey, nowIso);
    // The tables are not there yet: nothing is stored and nothing is said. Any other failure still owes a first reply.
    if (found.kind === "missing") return EMPTY_TURN;
    if (found.kind === "unavailable") return { leadId: null, reply: firstTextFallbackReply(), assignedWorkspaceId: null };
    const lead = found.lead;
    known = lead;

    const inboundTurn = await db
      .from("sms_unassigned_lead_turns")
      .insert({
        lead_id: lead.id,
        direction: "inbound",
        body: redactLeadBody(inbound.body),
        message_sid: inbound.messageSid || null,
        media: inbound.mediaCount > 0 ? { count: inbound.mediaCount } : null,
      })
      .select("id")
      .maybeSingle();
    const firstTurn = lead.profile.stage === undefined;
    if (inboundTurn.error?.code === "23505") {
      // A webhook retry: say exactly what was said the first time. A first turn whose reply was never recorded (the
      // first worker died between the two writes) still gets the deterministic welcome rather than silence.
      const stored = await storedReplyFor(db, lead.id, inbound.messageSid);
      const reply = stored ?? (firstTurn ? firstTextFallbackReply() : null);
      if (!stored && reply) await recordReply(db, lead.id, inbound.messageSid, reply, []);
      return { leadId: lead.id, reply, assignedWorkspaceId: null };
    }
    if (inboundTurn.error) {
      if (isMissingSchemaError(inboundTurn.error)) return EMPTY_TURN;
      console.error("unassigned lead turn failed", inboundTurn.error.code ?? "unknown");
      if (!firstTurn) return EMPTY_TURN;
      const reply = firstTextFallbackReply();
      await recordReply(db, lead.id, inbound.messageSid, reply, []);
      return { leadId: lead.id, reply, assignedWorkspaceId: null };
    }
    const triggerTurnId = str((inboundTurn.data as Row | null)?.id);
    await db.from("sms_unassigned_leads").update({ last_inbound_at: nowIso, updated_at: nowIso }).eq("id", lead.id);

    // A stranger whose first text named nothing got the one "Which home?" reply: the next text is the first real one.
    const first = firstTurn || lead.profile.stage === "hold";
    // A new inquiry on the PropLane line: tell the service manager's phone once (best effort, never blocks the reply).
    if (firstTurn) {
      void import("@/lib/service/service-manager-alerts.server")
        .then((m) => m.alertServiceManagerOfInquiry(db, { phone: inbound.phoneKey, body: inbound.body }))
        .catch(() => undefined);
    }
    // One specific home that PropLane does not manage: point to its team's own number (or its public page).
    const houseRedirect = await deps.houseRedirect(inbound.body);
    if (houseRedirect) {
      const reply = toGsm7(first ? `${WELCOME} ${houseRedirect}` : houseRedirect);
      await recordReply(db, lead.id, inbound.messageSid, reply, []);
      return { leadId: lead.id, reply, assignedWorkspaceId: null };
    }
    const ctx: LockContext = { inboundSid: inbound.messageSid, triggerTurnId, first };

    // A text that names exactly one home (street, house name or listing title) locks the line to that home; two homes ask which.
    const catalog = await deps.listings().catch(() => null);
    if (catalog) {
      const named = matchListingsNamedIn(inbound.body, catalog);
      if (named.kind === "one") return lockLeadToListing(db, lead, named.listing, named.listing.id, undefined, ctx, deps);
      if (named.kind === "several") {
        const asked = askWhichHome(inbound.body, catalog);
        if (asked) {
          await saveProfile(db, lead, { ...lead.profile, stage: "offered", asked: "pick", offers: asked.offers });
          await recordReply(db, lead.id, inbound.messageSid, asked.reply, []);
          return { leadId: lead.id, reply: asked.reply, assignedWorkspaceId: null };
        }
      }
    }

    const flow = await runFlow(lead.profile, inbound.body, first, deps);

    if (flow.assign) {
      const listing = catalog?.find((p) => p.id === flow.assign!.propertyId);
      return lockLeadToListing(db, lead, listing, flow.assign.propertyId, flow.assign.tier, ctx, deps);
    }

    const reply = toGsm7(flow.reply);
    await saveProfile(db, lead, flow.profile);
    await recordReply(db, lead.id, inbound.messageSid, reply, flow.mediaUrls);
    return {
      leadId: lead.id,
      reply,
      assignedWorkspaceId: null,
      ...(flow.mediaUrls.length ? { mediaUrls: flow.mediaUrls } : {}),
      ...(flow.bubbles && flow.bubbles.length > 1 ? { bubbles: flow.bubbles } : {}),
    };
  } catch (error) {
    // Masked: neither a number nor the body reaches a log.
    // Outside production the first stack frames are kept: a bare "TypeError" hid a broken offer step.
    console.error("unassigned lead turn failed", error instanceof Error ? error.name : "unknown", process.env.NODE_ENV !== "production" && error instanceof Error ? error.stack?.split("\n").slice(0, 4).join(" | ") : "");
    // A first text is never left unanswered: the deterministic welcome goes out and is recorded against this
    // inbound sid, so a Twilio retry replays it instead of asking again.
    if (known && known.profile.stage !== undefined) return EMPTY_TURN;
    const reply = firstTextFallbackReply();
    if (known) await recordReply(db, known.id, inbound.messageSid, reply, []).catch(() => undefined);
    return { leadId: known?.id ?? null, reply, assignedWorkspaceId: null };
  }
}

// ---------------------------------------------------------------------------
// Home lock: a pick, or a text naming one home, locks the line to that home and its manager
// ---------------------------------------------------------------------------

type LockContext = { inboundSid: string; triggerTurnId: string; first: boolean };

const GONE_REPLY = "That room is no longer available. Send a new budget or area and I will search again.";

/** Several homes named in one text: "Which one? 1) ... 2) ...", with the homes stored as offers so a number picks one. */
function askWhichHome(text: string, catalog: readonly LineListing[]): { reply: string; offers: LeadOffer[] } | null {
  const hits = catalog.filter((l) => matchListingsNamedIn(text, [l]).kind === "one").slice(0, MAX_STRANGER_OFFERS);
  if (hits.length < 2) return null;
  const offers: LeadOffer[] = hits.map((l, i) => ({ n: i + 1, propertyId: l.id, roomId: "", label: streetLine(l.address) || l.title, rent: null, availability: "", tier: lineTierOf(l) }));
  return { reply: switchQuestion(offers.map((o) => offerLabel(o))), offers };
}

/**
 * Lock a stranger to ONE home. A PropLane-managed or free-manager home hands the lead to that workspace (the text itself
 * then continues into that workspace's own conversation); a PAID manager's home gives their number, on interest.
 */
async function lockLeadToListing(
  db: SupabaseClient,
  lead: LeadRow,
  listing: LineListing | undefined,
  propertyId: string,
  offerTier: LeadOffer["tier"],
  ctx: LockContext,
  deps: Required<LeadDeps>,
): Promise<UnassignedLeadTurn> {
  const tier = listing ? lineTierOf(listing) : (offerTier ?? "managed");
  if (tier === "paid" && listing) return paidInterestTurn(db, lead, listing, ctx, deps);
  const assigned = await assignLeadToHouse(db, { leadId: lead.id, propertyId, excludeTurnIds: ctx.triggerTurnId ? [ctx.triggerTurnId] : [], by: "prospect" }, deps);
  if (assigned.ok) return { leadId: lead.id, reply: null, assignedWorkspaceId: assigned.workspaceId };
  // The room is gone or not assignable: say so and offer to search again.
  const reply = toGsm7(GONE_REPLY);
  await saveProfile(db, lead, { ...lead.profile, stage: "qualifying", asked: "refine", offers: [] });
  await recordReply(db, lead.id, ctx.inboundSid, reply, []);
  return { leadId: lead.id, reply, assignedWorkspaceId: null };
}

/**
 * A prospect wants a PAID manager's home: the reply names the home, the manager's first name and their own work number
 * ("12 Ravenna Pl is listed by Marcus. To learn more or book a tour, text Marcus at (206) 555-0142."). Only the interest
 * text and this reply are written into that manager's workspace Communication, so the conversation carries on there when
 * the prospect texts the manager. The lead leaves Unassigned and the phone is locked to the home. A manager whose number
 * cannot be named is not described and not locked.
 */
export async function paidInterestTurn(
  db: SupabaseClient,
  lead: Pick<LeadRow, "id" | "phoneKey" | "profile">,
  listing: Pick<MockProperty, "id" | "managerUserId" | "workspaceId" | "address" | "title">,
  ctx: { inboundSid: string; first?: boolean },
  deps: Pick<Required<LeadDeps>, "now" | "paidNumberOf" | "firstNameOf">,
): Promise<UnassignedLeadTurn> {
  const number = await deps.paidNumberOf(listing as MockProperty).catch(() => null);
  const config = await loadSharedLineConfig(db);
  const home = number ? await loadHome(db, listing.id, config) : null;
  if (!number || !home) {
    const reply = toGsm7(number ? GONE_REPLY : PAID_NUMBER_UNAVAILABLE_REPLY);
    await recordReply(db, lead.id, ctx.inboundSid, reply, []);
    return { leadId: lead.id, reply, assignedWorkspaceId: null };
  }
  const firstName = (await deps.firstNameOf(home.ownerUserId).catch(() => null)) ?? "";
  const reply = paidInterestReply({ label: home.label, firstName, number });
  const at = deps.now().toISOString();
  await recordReply(db, lead.id, ctx.inboundSid, reply, []);
  const claimed = await db
    .from("sms_unassigned_leads")
    .update({ status: "assigned", assigned_workspace_id: home.workspaceId, assigned_property_id: home.propertyId, assigned_at: at, profile: { ...lead.profile, stage: "assigned", asked: null }, updated_at: at })
    .eq("id", lead.id)
    .eq("status", "open")
    .select("id");
  if (!claimed.error && claimed.data?.length) {
    const phoneE164 = e164FromPhoneKey(lead.phoneKey);
    await recordPaidInterest(db, {
      home,
      phoneE164,
      linePhone: config.sharedNumber ?? phoneE164,
      interestText: `I'm interested in ${home.label}.`,
      replyText: reply,
      key: `${lead.id}:${home.propertyId}`,
      at,
    });
    await saveSharedLineRoute(db, lead.phoneKey, { workspaceId: home.workspaceId, role: "prospect", lockedPropertyId: home.propertyId });
  }
  return { leadId: lead.id, reply: ctx.first ? toGsm7(`${WELCOME} ${reply}`) : reply, assignedWorkspaceId: null };
}

/**
 * A stranger's first text named nothing specific ("hi", "who is this"): ONE reply asking which home, and the text waits in
 * Admin > Unassigned (an open lead in the `hold` stage), never in any workspace's Communication. Their next text is
 * checked again: a home named locks them to it, anything else goes on as before.
 */
export async function handleHoldInbound(db: SupabaseClient, inbound: SharedLineInbound, depsIn: Pick<LeadDeps, "now"> = {}): Promise<UnassignedLeadTurn> {
  const nowIso = (depsIn.now?.() ?? new Date()).toISOString();
  const found = await findOrCreateOpenLead(db, inbound.phoneKey, nowIso);
  if (found.kind !== "lead") return { leadId: null, reply: toGsm7(HOLD_REPLY), assignedWorkspaceId: null };
  const lead = found.lead;
  const inboundTurn = await db
    .from("sms_unassigned_lead_turns")
    .insert({ lead_id: lead.id, direction: "inbound", body: redactLeadBody(inbound.body), message_sid: inbound.messageSid || null, media: inbound.mediaCount > 0 ? { count: inbound.mediaCount } : null })
    .select("id")
    .maybeSingle();
  if (inboundTurn.error?.code === "23505") {
    const stored = await storedReplyFor(db, lead.id, inbound.messageSid);
    return { leadId: lead.id, reply: stored ?? toGsm7(HOLD_REPLY), assignedWorkspaceId: null };
  }
  const reply = toGsm7(HOLD_REPLY);
  await saveProfile(db, lead, { ...lead.profile, stage: "hold", asked: null });
  await db.from("sms_unassigned_leads").update({ last_inbound_at: nowIso, updated_at: nowIso }).eq("id", lead.id);
  await recordReply(db, lead.id, inbound.messageSid, reply, []);
  return { leadId: lead.id, reply, assignedWorkspaceId: null };
}

/** The stage of the phone's open lead (`hold` after the one "Which home?" reply), or null when it has none. */
export async function openLeadStage(db: SupabaseClient, phoneKey: string): Promise<string | null> {
  const { data } = await db.from("sms_unassigned_leads").select("profile").eq("phone_key", phoneKey).eq("status", "open").maybeSingle();
  if (!data) return null;
  const profile = (data as Row).profile as LeadProfile | null;
  return profile?.stage ?? "qualifying";
}

/** Does this text name exactly one home the line offers (any tier)? Used before the role question: a named home needs no question. */
export async function textNamesOneHome(db: SupabaseClient, text: string, depsIn: Pick<LeadDeps, "listings"> = {}): Promise<boolean> {
  try {
    const catalog = await (depsIn.listings ?? (() => getLineOfferListings(db)))();
    const named = matchListingsNamedIn(text, catalog);
    return named.kind !== "none";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/**
 * May a prospect on the PropLane line be handed to this workspace? A PropLane-managed workspace always; in `shared` mode
 * (the 206 is every free manager's work number) also any workspace that answers on the shared line, i.e. one without a
 * personal number. A workspace with a personal number is never handed a lead from the 206 (its homes are not in the
 * catalog; the router redirects). Fails closed.
 */
async function workspaceServedOnLine(db: SupabaseClient, workspaceId: string, config: SharedLineConfig): Promise<boolean> {
  if (await workspaceIsService(db, workspaceId)) return true;
  return workspaceOnSharedLine(config, workspaceId);
}

export type AssignResult =
  | { ok: true; workspaceId: string; ownerUserId: string; label: string }
  | { ok: false; error: "lead_not_open" | "house_not_found" | "workspace_not_found" | "unavailable" };

function profileLine(profile: LeadProfile): string {
  const bits: string[] = [];
  if (profile.budgetMax) bits.push(`budget $${profile.budgetMax}`);
  if (profile.moveInDate) bits.push(`move-in ${profile.moveInDate}`);
  if (profile.leaseMonths !== undefined) bits.push(profile.leaseMonths === 0 ? "month to month" : `${profile.leaseMonths} mo`);
  if (profile.area) bits.push(profile.area);
  return bits.join(", ");
}

/**
 * Hand a lead to ONE workspace. The house is read from the database (never from the offer the lead was
 * shown), must be live, and decides the workspace and its owner. The claim is a conditional update on
 * `status = 'open'`, so a lead is assigned exactly once. The history then enters that workspace's own
 * prospect conversation (opened by a one-line "Looking for" summary, never the browsing transcript), the phone's session
 * points there and locks to the home, and only that team is alerted.
 */
export async function assignLeadToHouse(
  db: SupabaseClient,
  input: { leadId: string; propertyId?: string; workspaceId?: string; excludeTurnIds?: string[]; by: "prospect" | "admin" },
  depsIn: Pick<LeadDeps, "now"> = {},
): Promise<AssignResult> {
  const now = depsIn.now ?? (() => new Date());
  const leadRes = await db.from("sms_unassigned_leads").select(LEAD_COLUMNS).eq("id", input.leadId).maybeSingle();
  if (leadRes.error) return { ok: false, error: "unavailable" };
  if (!leadRes.data || str((leadRes.data as Row).status) !== "open") return { ok: false, error: "lead_not_open" };
  const lead = toLead(leadRes.data as Row);

  let workspaceId = "";
  let houseLabel = "";
  const propertyId = str(input.propertyId);
  if (propertyId) {
    const houseRes = await db
      .from("manager_property_records")
      .select("id, workspace_id, manager_user_id, status, property_data, row_data")
      .eq("id", propertyId)
      .maybeSingle();
    const house = houseRes.data as Row | null;
    if (houseRes.error || !house || str(house.status) !== "live") return { ok: false, error: "house_not_found" };
    workspaceId = str(house.workspace_id);
    if (!workspaceId) {
      // A legacy row not stamped yet belongs to its manager's default workspace.
      const owned = await db.from("portal_workspaces").select("id").eq("owner_user_id", str(house.manager_user_id)).eq("is_default", true).maybeSingle();
      workspaceId = str((owned.data as Row | null)?.id);
    }
    houseLabel = propertyLabel(house.property_data) || propertyLabel(house.row_data);
  } else {
    // Admin placing a stranger's thread straight into a PropLane Service workspace (no house yet).
    workspaceId = str(input.workspaceId);
    if (input.by !== "admin" || !workspaceId) return { ok: false, error: "house_not_found" };
  }
  // A prospect on the PropLane line is only ever handed to a workspace the line serves (managed, or in shared mode one
  // without a personal number): the offers they picked from are drawn from that catalog alone, so a pick that names
  // anything else did not come from this flow.
  // A workspace named without a house is a service workspace by definition of that admin action.
  // A prospect's pick of a HOUSE may also land in a workspace the shared line serves; an admin naming a workspace with no
  // house (and a prospect trying to) is a PropLane Service workspace only.
  const config = await loadSharedLineConfig(db);
  const served = input.by === "prospect" && propertyId ? await workspaceServedOnLine(db, workspaceId, config) : await workspaceIsService(db, workspaceId);
  if ((input.by === "prospect" || !propertyId) && !served) {
    return { ok: false, error: propertyId ? "house_not_found" : "workspace_not_found" };
  }
  const prospect = workspaceId ? await findWorkspaceProspectCandidate(db, workspaceId) : null;
  if (!prospect) return { ok: false, error: "workspace_not_found" };
  const label = houseLabel || prospect.label;

  const at = now().toISOString();
  const claimed = await db
    .from("sms_unassigned_leads")
    .update({
      status: "assigned",
      assigned_workspace_id: prospect.workspaceId,
      assigned_property_id: propertyId || null,
      assigned_at: at,
      profile: { ...lead.profile, stage: "assigned", asked: null },
      updated_at: at,
    })
    .eq("id", lead.id)
    .eq("status", "open")
    .select("id");
  if (claimed.error) return { ok: false, error: "unavailable" };
  if (!claimed.data?.length) return { ok: false, error: "lead_not_open" };

  const phoneE164 = e164FromPhoneKey(lead.phoneKey);
  const linePhone = config.sharedNumber ?? phoneE164;
  // The browsing transcript is NOT copied: it holds the other managers' homes the prospect was offered. The locked manager's
  // conversation opens with one "Looking for" line, then only the texts about their own home.
  const looking = lookingForLine(lead.profile);
  if (looking) {
    await writeLookingForTurn(db, {
      ownerUserId: prospect.ownerUserId,
      workspaceId: prospect.workspaceId,
      phoneE164,
      linePhone,
      text: looking,
      leadId: lead.id,
      propertyId: propertyId || "workspace",
      at,
    });
  }

  // The returning-prospect lookup finds this phone through its contact row from now on.
  await upsertManagerSmsContact(db, { managerUserId: prospect.ownerUserId, phone: phoneE164, counterpartyRole: "prospect", lastInboundAt: at }).catch(() => undefined);
  await db.from("manager_sms_contacts").update({ workspace_id: prospect.workspaceId }).eq("manager_user_id", prospect.ownerUserId).eq("phone_e164", phoneE164).eq("counterparty_role", "prospect");
  // The home lock: a house sets it (and tags the thread with that house so only the owner and the co-hosts who hold it see
  // it); a placement by an admin with no house clears any earlier lock.
  await saveSharedLineRoute(db, lead.phoneKey, { workspaceId: prospect.workspaceId, role: "prospect", lockedPropertyId: propertyId || null });
  if (propertyId) await tagLockedHouse(db, { ownerUserId: prospect.ownerUserId, phoneE164, propertyId });

  const summary = profileLine(lead.profile);
  await alertWorkspaceTeam(db, {
    workspaceId: prospect.workspaceId,
    ownerUserId: prospect.ownerUserId,
    kind: "new_lead",
    urgent: false,
    text: `New lead for ${label}${summary ? `: ${summary}` : ""}`,
    propertyId: propertyId || null,
    idempotencyKey: `lead-assigned:${lead.id}`,
  }).catch(() => undefined);

  return { ok: true, workspaceId: prospect.workspaceId, ownerUserId: prospect.ownerUserId, label };
}

export async function closeLead(db: SupabaseClient, leadId: string): Promise<boolean> {
  const at = new Date().toISOString();
  const { data, error } = await db
    .from("sms_unassigned_leads")
    .update({ status: "closed", updated_at: at })
    .eq("id", leadId)
    .eq("status", "open")
    .select("id");
  return !error && Boolean(data?.length);
}

// ---------------------------------------------------------------------------
// The admin queue (platform only: never read by a manager route)
// ---------------------------------------------------------------------------

export type UnassignedLeadListItem = {
  id: string;
  /** "•••• 1234": the number is never sent to the browser. */
  phoneMasked: string;
  budgetMax: number | null;
  moveInDate: string | null;
  lastMessageAt: string | null;
  stage: string;
};

export function maskPhoneKey(phoneKey: string): string {
  const digits = phoneKey.replace(/\D/g, "");
  return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : "••••";
}

export async function listOpenLeads(db: SupabaseClient, opts: { limit?: number; offset?: number } = {}): Promise<{ items: UnassignedLeadListItem[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const { data, error, count } = await db
    .from("sms_unassigned_leads")
    .select(LEAD_COLUMNS, { count: "exact" })
    .eq("status", "open")
    .order("last_inbound_at", { ascending: false, nullsFirst: false })
    .range(offset, offset + limit - 1);
  if (error) return { items: [], total: 0 };
  const items = ((data ?? []) as Row[]).map((row) => {
    const lead = toLead(row);
    return {
      id: lead.id,
      phoneMasked: maskPhoneKey(lead.phoneKey),
      budgetMax: lead.profile.budgetMax ?? null,
      moveInDate: lead.profile.moveInDate ?? null,
      lastMessageAt: lead.lastInboundAt,
      stage: lead.profile.stage ?? "qualifying",
    };
  });
  return { items, total: count ?? items.length };
}

/**
 * One open lead as an admin Communication text thread: every turn of the stranger's conversation with the PropLane line,
 * before any workspace holds it. The number is never sent to the browser (masked, like the queue), so the thread is
 * read-only until it is assigned.
 */
export type UnassignedLeadThread = {
  leadId: string;
  phoneMasked: string;
  lastMessageAt: string | null;
  turns: Array<{ id: string; direction: "inbound" | "outbound"; body: string; createdAt: string }>;
};

export async function listOpenLeadThreads(db: SupabaseClient, opts: { limit?: number } = {}): Promise<UnassignedLeadThread[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const { data, error } = await db
    .from("sms_unassigned_leads")
    .select(LEAD_COLUMNS)
    .eq("status", "open")
    .order("last_inbound_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error || !data?.length) return [];
  const leads = (data as Row[]).map(toLead);
  const turnsRes = await db
    .from("sms_unassigned_lead_turns")
    .select("id, lead_id, direction, body, created_at")
    .in("lead_id", leads.map((lead) => lead.id))
    .order("created_at", { ascending: true })
    .limit(2000);
  const byLead = new Map<string, UnassignedLeadThread["turns"]>();
  for (const turn of (turnsRes.error ? [] : (turnsRes.data ?? [])) as Row[]) {
    const leadId = str(turn.lead_id);
    const list = byLead.get(leadId) ?? [];
    list.push({
      id: str(turn.id),
      direction: str(turn.direction) === "inbound" ? "inbound" : "outbound",
      body: str(turn.body),
      createdAt: str(turn.created_at),
    });
    byLead.set(leadId, list);
  }
  return leads.map((lead) => ({
    leadId: lead.id,
    phoneMasked: maskPhoneKey(lead.phoneKey),
    lastMessageAt: lead.lastInboundAt,
    turns: byLead.get(lead.id) ?? [],
  }));
}

// ---------------------------------------------------------------------------
// The lead exchange for a locked prospect's switch question (Unassigned only)
// ---------------------------------------------------------------------------

/** The newest lead rows for a phone, any status, newest first. */
export async function recentLeadsFor(db: SupabaseClient, phoneKey: string, limit = 5): Promise<LeadRow[]> {
  const { data, error } = await db.from("sms_unassigned_leads").select(LEAD_COLUMNS).eq("phone_key", phoneKey).order("updated_at", { ascending: false }).limit(limit);
  if (error) return [];
  return ((data ?? []) as Row[]).map(toLead);
}

/**
 * Open (or reuse) the phone's lead and record the inbound text on it, so a question the line asks a LOCKED prospect and its
 * answer are visible to PropLane admin in Unassigned and to no manager. A new lead starts from `seed` (the criteria of the
 * earlier lead, so a later re-lock can still say what they were looking for). `duplicate` = a webhook retry of this text.
 */
export async function startLeadExchange(
  db: SupabaseClient,
  input: { phoneKey: string; body: string; messageSid: string; mediaCount?: number; now: Date; seed?: LeadProfile },
): Promise<{ lead: LeadRow; duplicate: string | null } | null> {
  const found = await findOrCreateOpenLead(db, input.phoneKey, input.now.toISOString());
  if (found.kind !== "lead") return null;
  let lead = found.lead;
  if (lead.profile.stage === undefined && input.seed) {
    lead = { ...lead, profile: { ...input.seed, stage: "switch", asked: null } };
    await saveProfile(db, lead, lead.profile);
  }
  const turn = await db
    .from("sms_unassigned_lead_turns")
    .insert({ lead_id: lead.id, direction: "inbound", body: redactLeadBody(input.body), message_sid: input.messageSid || null, media: input.mediaCount ? { count: input.mediaCount } : null })
    .select("id")
    .maybeSingle();
  if (turn.error?.code === "23505") return { lead, duplicate: (await storedReplyFor(db, lead.id, input.messageSid)) ?? "" };
  await db.from("sms_unassigned_leads").update({ last_inbound_at: input.now.toISOString(), updated_at: input.now.toISOString() }).eq("id", lead.id);
  return { lead, duplicate: null };
}
