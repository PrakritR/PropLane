import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { MockProperty } from "@/data/types";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { isMissingSchemaError, loadSharedLineConfig } from "@/lib/one-number/config.server";
import type { SharedLineInbound } from "@/lib/one-number/contracts";
import { extractLeadFieldsWithModel } from "@/lib/one-number/lead-extract.server";
import {
  buildOfferBubbles,
  buildOfferText,
  type OfferBubble,
  matchRooms,
  NO_MATCH_TEXT,
  offerFromRow,
  parseOfferPick,
} from "@/lib/one-number/lead-match";
import {
  applyAnswer,
  mergeModelFields,
  NEUTRAL_REPLY,
  nextQuestion,
  pacificToday,
  toGsm7,
  touchesProtectedTopic,
  WELCOME,
  withoutProtectedClauses,
  type LeadProfile,
} from "@/lib/one-number/lead-qualifying";
import { redactSensitiveNumbers } from "@/lib/one-number/redact";
import { findWorkspaceProspectCandidate, propertyLabel } from "@/lib/one-number/router-lookups.server";
import { saveSharedLineRoute } from "@/lib/one-number/session.server";
import { alertWorkspaceTeam } from "@/lib/one-number/team-alerts.server";
import { logManagerSmsMessage } from "@/lib/manager-sms-messages.server";
import { upsertManagerSmsContact } from "@/lib/sms/manager-sms-contacts.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { resolveHouseRedirect } from "@/lib/one-number/house-redirect.server";
import { getServicePublicListings } from "@/lib/service/service-catalog.server";

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
  /** Live public listings (the hourly projected catalog). */
  listings?: () => Promise<MockProperty[]>;
  /** Fallback answer reader. Receives text already stripped of protected clauses. */
  extract?: (input: { text: string; today: string }) => Promise<Partial<LeadProfile> | null>;
  origin?: () => string;
  /** Reply for a text naming one home PropLane does not manage (its team's own number or public page), or null. */
  houseRedirect?: (text: string) => Promise<string | null>;
};

type Row = Record<string, unknown>;
type LeadRow = { id: string; phoneKey: string; status: string; profile: LeadProfile; lastInboundAt: string | null; updatedAt: string };

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

async function findOrCreateOpenLead(db: SupabaseClient, phoneKey: string, nowIso: string): Promise<LeadLookup> {
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

async function storedReplyFor(db: SupabaseClient, leadId: string, messageSid: string): Promise<string | null> {
  const { data } = await db
    .from("sms_unassigned_lead_turns")
    .select("body")
    .eq("lead_id", leadId)
    .eq("message_sid", `reply:${messageSid}`)
    .maybeSingle();
  const body = str((data as Row | null)?.body);
  return body || null;
}

async function saveProfile(db: SupabaseClient, lead: LeadRow, profile: LeadProfile, extra: Record<string, unknown> = {}): Promise<void> {
  const now = new Date().toISOString();
  await db.from("sms_unassigned_leads").update({ profile, updated_at: now, ...extra }).eq("id", lead.id).eq("status", "open");
}

async function recordReply(db: SupabaseClient, leadId: string, messageSid: string, body: string, mediaUrls: string[]): Promise<void> {
  await db.from("sms_unassigned_lead_turns").insert({
    lead_id: leadId,
    direction: "outbound",
    body,
    message_sid: messageSid ? `reply:${messageSid}` : null,
    media: mediaUrls.length ? { urls: mediaUrls } : null,
  });
}

const PICK_PROMPT = (n: number) => `Reply ${n === 1 ? "1" : n === 2 ? "1 or 2" : "1, 2 or 3"} to pick a room, or TOUR to see one.`;

type FlowResult = { profile: LeadProfile; reply: string; mediaUrls: string[]; bubbles?: OfferBubble[]; assign?: { propertyId: string; roomId: string } };

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
  const rows = matchRooms(listings, profile, today);
  if (rows.length === 0) {
    return { profile: { ...profile, stage: "no_match", asked: null, offers: [] }, reply: NO_MATCH_TEXT, mediaUrls: [] };
  }
  const offers = rows.map((row, i) => offerFromRow(row, i + 1));
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
      return { profile, reply: "", mediaUrls: [], assign: { propertyId: pick.offer.propertyId, roomId: pick.offer.roomId } };
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
  const question = nextQuestion(next);
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
  const listings = depsIn.listings ?? (() => getServicePublicListings(db));
  const deps: Required<LeadDeps> = {
    now: depsIn.now ?? (() => new Date()),
    // A stranger on the PropLane line is shown the homes PropLane manages and no one else's.
    listings,
    extract: depsIn.extract ?? extractLeadFieldsWithModel,
    origin: depsIn.origin ?? resolveEmailLinkBaseUrl,
    houseRedirect: depsIn.houseRedirect ?? ((text: string) => resolveHouseRedirect(db, text, { serviceListings: listings })),
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

    const first = firstTurn;
    // A new inquiry on the PropLane line: tell the service manager's phone once (best effort, never blocks the reply).
    if (first) {
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
    const flow = await runFlow(lead.profile, inbound.body, first, deps);

    if (flow.assign) {
      const assigned = await assignLeadToHouse(db, {
        leadId: lead.id,
        propertyId: flow.assign.propertyId,
        excludeTurnIds: triggerTurnId ? [triggerTurnId] : [],
        by: "prospect",
      }, deps);
      if (assigned.ok) return { leadId: lead.id, reply: null, assignedWorkspaceId: assigned.workspaceId };
      // The room is gone or not assignable: say so and offer to search again.
      const reply = toGsm7("That room is no longer available. Send a new budget or area and I will search again.");
      await saveProfile(db, lead, { ...lead.profile, stage: "qualifying", asked: "refine", offers: [] });
      await recordReply(db, lead.id, inbound.messageSid, reply, []);
      return { leadId: lead.id, reply, assignedWorkspaceId: null };
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
// Assignment
// ---------------------------------------------------------------------------

/** Does `workspaceId` carry the PropLane Service flag? A failed or absent read is NOT a service workspace (fail closed). */
async function workspaceIsService(db: SupabaseClient, workspaceId: string): Promise<boolean> {
  if (!workspaceId) return false;
  const { data, error } = await db.from("portal_workspaces").select("is_service").eq("id", workspaceId).maybeSingle();
  if (error) return false;
  return (data as Row | null)?.is_service === true;
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
 * prospect conversation through the normal log + projection path, the phone's session points there,
 * and only that team is alerted.
 */
export async function assignLeadToHouse(
  db: SupabaseClient,
  input: { leadId: string; propertyId: string; excludeTurnIds?: string[]; by: "prospect" | "admin" },
  depsIn: Pick<LeadDeps, "now"> = {},
): Promise<AssignResult> {
  const now = depsIn.now ?? (() => new Date());
  const leadRes = await db.from("sms_unassigned_leads").select(LEAD_COLUMNS).eq("id", input.leadId).maybeSingle();
  if (leadRes.error) return { ok: false, error: "unavailable" };
  if (!leadRes.data || str((leadRes.data as Row).status) !== "open") return { ok: false, error: "lead_not_open" };
  const lead = toLead(leadRes.data as Row);

  const houseRes = await db
    .from("manager_property_records")
    .select("id, workspace_id, manager_user_id, status, property_data, row_data")
    .eq("id", input.propertyId)
    .maybeSingle();
  const house = houseRes.data as Row | null;
  if (houseRes.error || !house || str(house.status) !== "live") return { ok: false, error: "house_not_found" };
  let workspaceId = str(house.workspace_id);
  if (!workspaceId) {
    // A legacy row not stamped yet belongs to its manager's default workspace.
    const owned = await db.from("portal_workspaces").select("id").eq("owner_user_id", str(house.manager_user_id)).eq("is_default", true).maybeSingle();
    workspaceId = str((owned.data as Row | null)?.id);
  }
  // A prospect on the PropLane line is only ever handed to a PropLane-managed workspace: the offers they picked from
  // are drawn from the `is_service` catalog alone, so a pick that names anything else did not come from this flow.
  if (input.by === "prospect" && !(await workspaceIsService(db, workspaceId))) return { ok: false, error: "house_not_found" };
  const prospect = workspaceId ? await findWorkspaceProspectCandidate(db, workspaceId) : null;
  if (!prospect) return { ok: false, error: "workspace_not_found" };
  const label = propertyLabel(house.property_data) || propertyLabel(house.row_data) || prospect.label;

  const at = now().toISOString();
  const claimed = await db
    .from("sms_unassigned_leads")
    .update({
      status: "assigned",
      assigned_workspace_id: prospect.workspaceId,
      assigned_property_id: input.propertyId,
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
  const config = await loadSharedLineConfig(db);
  const linePhone = config.sharedNumber ?? phoneE164;
  const excluded = new Set(input.excludeTurnIds ?? []);
  const turns = await db
    .from("sms_unassigned_lead_turns")
    .select("id, direction, body, created_at")
    .eq("lead_id", lead.id)
    .order("created_at", { ascending: true })
    .limit(200);
  for (const turn of (turns.data ?? []) as Row[]) {
    const id = str(turn.id);
    if (excluded.has(id)) continue;
    const inboundDir = str(turn.direction) === "inbound";
    // `workspaceId` rides along for the workspace-stamp support in `logManagerSmsMessage`.
    const entry: Parameters<typeof logManagerSmsMessage>[1] & { workspaceId?: string | null } = {
      managerUserId: prospect.ownerUserId,
      residentPhone: phoneE164,
      direction: inboundDir ? "inbound" : "outbound",
      body: str(turn.body),
      fromPhone: inboundDir ? phoneE164 : linePhone,
      toPhone: inboundDir ? linePhone : phoneE164,
      messageSid: `lead:${id}`,
      createdAt: str(turn.created_at) || at,
      source: "work_number",
      counterpartyRole: "prospect",
      workspaceId: prospect.workspaceId,
    };
    await logManagerSmsMessage(db, entry).catch(() => false);
  }
  // Best-effort stamp for databases where the helper above does not stamp yet.
  await db.from("manager_sms_messages").update({ workspace_id: prospect.workspaceId }).eq("manager_user_id", prospect.ownerUserId).like("message_sid", "lead:%").is("workspace_id", null);

  // The returning-prospect lookup finds this phone through its contact row from now on.
  await upsertManagerSmsContact(db, { managerUserId: prospect.ownerUserId, phone: phoneE164, counterpartyRole: "prospect", lastInboundAt: at }).catch(() => undefined);
  await db.from("manager_sms_contacts").update({ workspace_id: prospect.workspaceId }).eq("manager_user_id", prospect.ownerUserId).eq("phone_e164", phoneE164).eq("counterparty_role", "prospect");
  await saveSharedLineRoute(db, lead.phoneKey, { workspaceId: prospect.workspaceId, role: "prospect" });

  const summary = profileLine(lead.profile);
  await alertWorkspaceTeam(db, {
    workspaceId: prospect.workspaceId,
    ownerUserId: prospect.ownerUserId,
    kind: "new_lead",
    urgent: false,
    text: `New lead for ${label}${summary ? `: ${summary}` : ""}`,
    propertyId: input.propertyId,
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
