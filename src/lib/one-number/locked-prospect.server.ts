import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { MockProperty } from "@/data/types";
import { logManagerSmsMessage } from "@/lib/manager-sms-messages.server";
import type { SharedLineCandidate, SharedLineInbound, SharedLineSession } from "@/lib/one-number/contracts";
import { loadSharedLineConfig } from "@/lib/one-number/config.server";
import {
  homeLabel,
  offerLabel,
  offerReference,
  paidInterestReply,
  parseYesNo,
  relockDetailsReply,
  stillTalkingReply,
  switchQuestion,
} from "@/lib/one-number/home-lock";
import { e164FromPhoneKey, loadHome, ownerFirstName, type LockedHome } from "@/lib/one-number/home-lock.server";
import { matchListingsNamedIn } from "@/lib/one-number/house-redirect";
import { getLineOfferListings } from "@/lib/one-number/line-catalog.server";
import type { LineListing } from "@/lib/one-number/line-tier";
import type { LeadOffer } from "@/lib/one-number/lead-qualifying";
import { toGsm7 } from "@/lib/one-number/lead-qualifying";
import { findWorkspaceProspectCandidate } from "@/lib/one-number/router-lookups.server";
import { paidWorkNumberFor } from "@/lib/one-number/self-serve-line.server";
import { clearSharedLinePending, saveSharedLinePending } from "@/lib/one-number/session.server";
import {
  assignLeadToHouse,
  closeLead,
  paidInterestTurn,
  recentLeadsFor,
  recordReply,
  startLeadExchange,
  type LeadRow,
} from "@/lib/one-number/unassigned-leads.server";

/**
 * A text from a phone that is LOCKED to one home on the PropLane line (`sms_line_sessions.locked_property_id`).
 *
 * The lock is only ever moved by the prospect saying yes. A text that names a different home, or points at another offered
 * one ("the other one", "#2", "the first one"), is never acted on: the line asks "Are you asking about X?" and keeps the
 * old lock until the answer. That question and its answer are written to Admin > Unassigned only (an open lead), never to
 * any workspace's Communication. Everything else routes to the locked home's manager, whose conversation (stamped with the
 * home) is the only place those texts are recorded.
 */

export type LockedTurn =
  /** Not a switch: carry on with the locked home's manager. */
  | { kind: "route"; candidate: SharedLineCandidate }
  /** Answered here; nothing is routed into any workspace by this turn. */
  | { kind: "reply"; reply: string; leadId: string | null };

export type LockedDeps = {
  now?: () => Date;
  listings?: () => Promise<LineListing[]>;
  paidNumberOf?: (listing: MockProperty) => Promise<string | null>;
  firstNameOf?: (ownerUserId: string) => Promise<string | null>;
  dedicatedWorkspaceIds?: readonly string[];
  dryRun?: boolean;
};

type Target = { home: LockedHome; label: string; offer?: LeadOffer };

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

const candidateFor = (t: Target): SharedLineCandidate => ({
  workspaceId: t.home.workspaceId,
  ownerUserId: t.home.ownerUserId,
  role: "prospect",
  reason: "returning_prospect",
  propertyId: t.home.propertyId,
  label: t.label,
});

/** The offers on record for a phone: the newest lead that carries any. */
async function offersOnRecord(db: SupabaseClient, phoneKey: string): Promise<LeadOffer[]> {
  for (const lead of await recentLeadsFor(db, phoneKey)) if (lead.profile.offers?.length) return lead.profile.offers;
  return [];
}

async function loadTargets(db: SupabaseClient, picks: Array<{ propertyId: string; label: string; offer?: LeadOffer }>, dedicated: readonly string[]): Promise<Target[]> {
  const out: Target[] = [];
  for (const pick of picks) {
    const home = await loadHome(db, pick.propertyId, { dedicatedWorkspaceIds: [...dedicated] });
    if (home) out.push({ home, label: pick.label, ...(pick.offer ? { offer: pick.offer } : {}) });
  }
  return out;
}

/** What a text points at that is not the locked home: a named home, or an offered one by position. */
async function switchTargets(
  db: SupabaseClient,
  text: string,
  locked: LockedHome,
  catalog: readonly LineListing[],
  inbound: SharedLineInbound,
  dedicated: readonly string[],
): Promise<Target[]> {
  const named = matchListingsNamedIn(text, catalog);
  if (named.kind !== "none") {
    const hits = named.kind === "one" ? [named.listing] : catalog.filter((l) => matchListingsNamedIn(text, [l]).kind === "one");
    const others = hits.filter((l) => l.id !== locked.propertyId).slice(0, 4);
    if (others.length > 0 && !(named.kind === "one" && hits[0]!.id === locked.propertyId)) {
      const offers = await offersOnRecord(db, inbound.phoneKey);
      return loadTargets(
        db,
        others.map((l) => {
          const offer = offers.find((o) => o.propertyId === l.id);
          return { propertyId: l.id, label: offer ? offerLabel(offer) : homeLabel(l), ...(offer ? { offer } : {}) };
        }),
        dedicated,
      );
    }
    return [];
  }
  const reference = offerReference(text);
  if (!reference) return [];
  const offers = await offersOnRecord(db, inbound.phoneKey);
  if (offers.length === 0) return [];
  const others = offers.filter((o) => o.propertyId !== locked.propertyId);
  let chosen: LeadOffer[] = [];
  if (reference.kind === "other") chosen = others;
  else {
    const hit = reference.n === 99 ? offers[offers.length - 1] : offers.find((o) => o.n === reference.n);
    if (hit && hit.propertyId !== locked.propertyId) chosen = [hit];
  }
  return loadTargets(db, chosen.slice(0, 4).map((o) => ({ propertyId: o.propertyId, label: offerLabel(o), offer: o })), dedicated);
}

async function askSwitch(db: SupabaseClient, inbound: SharedLineInbound, targets: Target[], deps: Required<Pick<LockedDeps, "now">>): Promise<LockedTurn> {
  const past = await recentLeadsFor(db, inbound.phoneKey, 1);
  const started = await startLeadExchange(db, { phoneKey: inbound.phoneKey, body: inbound.body, messageSid: inbound.messageSid, mediaCount: inbound.mediaCount, now: deps.now(), seed: past[0]?.profile });
  if (!started) return { kind: "reply", reply: switchQuestion(targets.map((t) => t.label)), leadId: null };
  if (started.duplicate !== null) return { kind: "reply", reply: started.duplicate || switchQuestion(targets.map((t) => t.label)), leadId: started.lead.id };
  const reply = switchQuestion(targets.map((t) => t.label));
  await saveSharedLinePending(db, inbound.phoneKey, targets.map(candidateFor));
  await recordReply(db, started.lead.id, inbound.messageSid, reply, []);
  return { kind: "reply", reply, leadId: started.lead.id };
}

/** The pending answer: a bare yes (one home asked), a number or a name (several), or a no. Null = it answers nothing. */
function readAnswer(text: string, asked: readonly SharedLineCandidate[]): { kind: "yes"; to: SharedLineCandidate } | { kind: "no" } | null {
  const yesNo = parseYesNo(text);
  if (yesNo === "no") return { kind: "no" };
  if (asked.length === 1) return yesNo === "yes" ? { kind: "yes", to: asked[0]! } : null;
  const t = text.trim();
  const num = /^#?(\d)[.!\s]*$/.exec(t);
  if (num) {
    const hit = asked[Number(num[1]) - 1];
    return hit ? { kind: "yes", to: hit } : null;
  }
  const words = t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((w) => w.length > 1 && !["the", "one", "at", "on", "of", "ave", "st", "way", "pl"].includes(w));
  if (words.length > 0) {
    const hits = asked.filter((c) => words.every((w) => c.label.toLowerCase().includes(w)));
    if (hits.length === 1) return { kind: "yes", to: hits[0]! };
  }
  return null;
}

async function declineSwitch(db: SupabaseClient, inbound: SharedLineInbound, locked: LockedHome, lead: LeadRow | null): Promise<LockedTurn> {
  const reply = stillTalkingReply(locked.label);
  await clearSharedLinePending(db, inbound.phoneKey);
  if (lead) {
    await recordReply(db, lead.id, inbound.messageSid, reply, []);
    await closeLead(db, lead.id);
  }
  return { kind: "reply", reply, leadId: lead?.id ?? null };
}

async function relock(
  db: SupabaseClient,
  inbound: SharedLineInbound,
  to: SharedLineCandidate,
  lead: LeadRow,
  catalog: readonly LineListing[],
  deps: Required<Pick<LockedDeps, "now" | "paidNumberOf" | "firstNameOf">> & Pick<LockedDeps, "dedicatedWorkspaceIds">,
): Promise<LockedTurn> {
  const home = await loadHome(db, to.propertyId ?? "", { dedicatedWorkspaceIds: [...(deps.dedicatedWorkspaceIds ?? [])] });
  if (!home) {
    const reply = toGsm7("That home is no longer available. Tell me which home you are asking about.");
    await clearSharedLinePending(db, inbound.phoneKey);
    await recordReply(db, lead.id, inbound.messageSid, reply, []);
    await closeLead(db, lead.id);
    return { kind: "reply", reply, leadId: lead.id };
  }
  const listing = catalog.find((l) => l.id === home.propertyId);
  if (home.tier === "paid") {
    const turn = await paidInterestTurn(
      db,
      lead,
      listing ?? ({ id: home.propertyId, managerUserId: home.ownerUserId, workspaceId: home.workspaceId, address: home.label, title: home.label } as MockProperty),
      { inboundSid: inbound.messageSid },
      deps,
    );
    return { kind: "reply", reply: turn.reply ?? "", leadId: lead.id };
  }
  const assigned = await assignLeadToHouse(db, { leadId: lead.id, propertyId: home.propertyId, by: "prospect" }, deps);
  if (!assigned.ok) {
    const reply = toGsm7("That room is no longer available. Send a new budget or area and I will search again.");
    await clearSharedLinePending(db, inbound.phoneKey);
    await recordReply(db, lead.id, inbound.messageSid, reply, []);
    return { kind: "reply", reply, leadId: lead.id };
  }
  const offer = (lead.profile.offers ?? []).find((o) => o.propertyId === home.propertyId);
  const reply = relockDetailsReply({ label: to.label || home.label, rent: offer?.rent ?? null, availability: offer?.availability ?? null });
  await recordReply(db, lead.id, inbound.messageSid, reply, []);
  // The details the line just sent open the new conversation after its "Looking for" line; the prospect's "yes" does not.
  const config = await loadSharedLineConfig(db);
  const phoneE164 = e164FromPhoneKey(inbound.phoneKey);
  await logManagerSmsMessage(db, {
    managerUserId: assigned.ownerUserId,
    residentPhone: phoneE164,
    direction: "outbound",
    body: reply,
    fromPhone: config.sharedNumber ?? phoneE164,
    toPhone: phoneE164,
    messageSid: `relock-reply:${lead.id}:${home.propertyId}`,
    source: "work_number",
    counterpartyRole: "prospect",
    workspaceId: assigned.workspaceId,
  }).catch(() => false);
  return { kind: "reply", reply, leadId: lead.id };
}

/** The reply for a phone locked to a PAID manager's home that is not asking about anything else: their number, again. Written nowhere. */
async function repeatPaidReply(db: SupabaseClient, locked: LockedHome, catalog: readonly LineListing[], deps: Required<Pick<LockedDeps, "paidNumberOf" | "firstNameOf">>): Promise<string | null> {
  const listing = catalog.find((l) => l.id === locked.propertyId);
  const number = await deps.paidNumberOf(listing ?? ({ id: locked.propertyId, managerUserId: locked.ownerUserId, workspaceId: locked.workspaceId } as MockProperty)).catch(() => null);
  if (!number) return null;
  const firstName = (await deps.firstNameOf(locked.ownerUserId).catch(() => null)) ?? "";
  return paidInterestReply({ label: locked.label, firstName, number });
}

/**
 * Decide a locked phone's text. Null when the phone is not locked (or the home is gone): ordinary routing applies.
 */
export async function handleLockedProspectText(
  db: SupabaseClient,
  inbound: SharedLineInbound,
  session: SharedLineSession | null,
  depsIn: LockedDeps = {},
): Promise<LockedTurn | null> {
  const lockedId = str(session?.lockedPropertyId);
  if (!session || !lockedId) return null;
  const dedicated = depsIn.dedicatedWorkspaceIds ?? [];
  const locked = await loadHome(db, lockedId, { dedicatedWorkspaceIds: [...dedicated] });
  if (!locked) return null;
  // A team with a number of its own is never answered on the line: the ordinary path redirects.
  if (dedicated.includes(locked.workspaceId) && locked.tier !== "paid") return null;

  const routeToLocked = async (): Promise<LockedTurn | null> => {
    const base = await findWorkspaceProspectCandidate(db, locked.workspaceId);
    return base ? { kind: "route", candidate: { ...base, propertyId: locked.propertyId } } : null;
  };
  // Shadow mode and the HUMAN keyword only ask where the text would go: no question, no write.
  if (depsIn.dryRun) return locked.tier === "paid" ? null : routeToLocked();

  const now = depsIn.now ?? (() => new Date());
  const deps = {
    now,
    paidNumberOf:
      depsIn.paidNumberOf ??
      (async (l: MockProperty) => (l.managerUserId ? paidWorkNumberFor(db, { ownerUserId: l.managerUserId, workspaceId: l.workspaceId ?? null }) : null)),
    firstNameOf: depsIn.firstNameOf ?? ((ownerUserId: string) => ownerFirstName(db, ownerUserId)),
    dedicatedWorkspaceIds: dedicated,
  };
  const catalog = await (depsIn.listings ?? (() => getLineOfferListings(db)))().catch(() => [] as LineListing[]);

  // 1. An unanswered "Are you asking about X?"
  const asked = session.pendingCandidates?.filter((c) => c.propertyId) ?? [];
  if (asked.length > 0) {
    const answer = readAnswer(inbound.body, asked);
    if (answer) {
      const past = await recentLeadsFor(db, inbound.phoneKey, 1);
      const started = await startLeadExchange(db, { phoneKey: inbound.phoneKey, body: inbound.body, messageSid: inbound.messageSid, mediaCount: inbound.mediaCount, now: now(), seed: past[0]?.profile });
      if (!started) return null;
      if (started.duplicate !== null) return { kind: "reply", reply: started.duplicate, leadId: started.lead.id };
      return answer.kind === "no" ? declineSwitch(db, inbound, locked, started.lead) : relock(db, inbound, answer.to, started.lead, catalog, deps);
    }
    // Not an answer: the question lapses and the text is read fresh.
    await clearSharedLinePending(db, inbound.phoneKey);
  }

  // 2. A text about a different home, or another offered one by position, asks before anything moves.
  const targets = await switchTargets(db, inbound.body, locked, catalog, inbound, dedicated);
  if (targets.length > 0) return askSwitch(db, inbound, targets, deps);

  // 3. Still about the locked home.
  if (locked.tier === "paid") {
    const reply = await repeatPaidReply(db, locked, catalog, deps);
    return reply ? { kind: "reply", reply, leadId: null } : null;
  }
  return routeToLocked();
}
