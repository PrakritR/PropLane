import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { propertyStayClockFromRecord } from "@/lib/bookings/property-stay-times.server";
import { withResolvedStayTimes } from "@/lib/channel-calendar/property-bookings";
import { digestLinesByHouse } from "@/lib/one-number/checkin-digest";
import { checkinDigestEntityId } from "@/lib/one-number/ops-alert-lines";
import { alertPhonesOf } from "@/lib/one-number/ops-alerts.server";
import { occupancyEntriesForManager } from "@/lib/occupancy/snapshot.server";
import { pacificCalendarDateYmd, pacificHourOfDay } from "@/lib/pacific-time";
import { readServiceManagerSettings } from "@/lib/service/service-manager.server";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { createHash } from "node:crypto";
import { composeServiceDigest, type DigestLead } from "@/lib/one-number/service-digest";
import { loadPlatformOpsPhones } from "@/lib/one-number/inbound-alert.server";
import { propertyLabel } from "@/lib/one-number/router-lookups.server";
import { reportServiceSendFailure, resolveServiceAlertTargets, type ServiceAlertTargets } from "@/lib/service/service-alert-targets.server";
import { sendTextFromServiceOwner } from "@/lib/service/service-manager.server";
import { SERVICE_ALERT_PHONE_SMS_PURPOSE, TEAM_NOTICE_SMS_PURPOSE } from "@/lib/sms/team-notice-consent.server";
import { addHouseLineToRecipients, dedupeDigestRecipients, type HouseDigestBucket, type HouseDigestRecipient } from "@/lib/one-number/house-digest-recipients";
import { loadUsableManagerPhones, resolveHouseManagerUserIds } from "@/lib/one-number/house-digest-recipients.server";
import { listWorkNumberRecipients } from "@/lib/work-number-recipients.server";
import { normalizeE164 } from "@/lib/phone-e164";

/**
 * The 7 AM (Pacific) "who checks in and out today" text, always FROM a PropLane work number, TO every manager on each
 * house. Recipients are worked out per house from PropLane's records, never hardcoded:
 *   - PropLane-managed workspace: ONE text per phone from the PropLane line (`sendTextFromServiceOwner`, platform wallet)
 *     to the owner of record (`manager_property_records.manager_user_id`), every co-manager / teammate whose grants put
 *     them on that house's calendar notices, and the service alert targets (the listed admin phones and staff seats).
 *     Owners and co-managers get only their houses; the admin phones and staff also get leads and the reminder count.
 *   - Self-serve workspace: the listed alert phones keep their per-house text (`alertPhonesOf`), and every co-manager on
 *     the house gets ONE combined text from that workspace's own work number. The owner is not texted twice.
 * Accounts count only at a verified phone with SMS forwarding on; STOP and the consent gate are the transport's. A person
 * whose houses have no move today gets no text (see `house-digest-recipients.ts`). Vercel crons run on UTC, so the route
 * is scheduled at 14:00 and 15:00 UTC and this only acts when it is 7 o'clock in Pacific time (the one that matches in
 * either half of the year); the per-phone-per-day idempotency key makes a repeat harmless.
 *
 * Every digest text is `transactional`: quiet hours are 9 PM - 8 AM Pacific and an `automated` text inside them is refused
 * at the transport (not held), so a 7 AM `automated` digest would never arrive.
 */
export const CHECKIN_DIGEST_HOUR_PACIFIC = 7;

/** Owners handled at once. One cron invocation has 120s for all of them, so they do not go one by one. */
export const CHECKIN_DIGEST_OWNER_CONCURRENCY = 4;

export type CheckinDigestSummary = {
  owners: number;
  houses: number;
  sent: number;
  failed: number;
  /** Daily digest texts to PropLane's own people (managed workspaces: one text per person, houses + leads + reminders). */
  serviceTexts?: number;
  /** Combined texts to the co-managers of self-serve houses, from each workspace's own work number. */
  managerTexts?: number;
  /** Accounts on a house with no usable phone (unverified, forwarding off, none): skipped, counted, never named. */
  skippedNoPhone?: number;
  skippedReason?: "not_7am" | "unreadable";
};

/** Owners who have anyone to tell: an alert phone / email, or a managed workspace with a verified Service phone. */
async function ownersToTell(db: SupabaseClient): Promise<string[] | null> {
  const owners = new Set<string>();
  const { data, error } = await db.from("workspace_work_number_recipients").select("owner_user_id").limit(5000);
  if (error) return null;
  for (const row of (data ?? []) as Array<{ owner_user_id?: unknown }>) {
    const id = typeof row.owner_user_id === "string" ? row.owner_user_id.trim() : "";
    if (id) owners.add(id);
  }
  try {
    const settings = await readServiceManagerSettings(db);
    if (settings?.phoneE164 && settings.verifiedAt) {
      const { data: service } = await db.from("portal_workspaces").select("owner_user_id").eq("is_service", true).limit(500);
      for (const row of (service ?? []) as Array<{ owner_user_id?: unknown }>) {
        const id = typeof row.owner_user_id === "string" ? row.owner_user_id.trim() : "";
        if (id) owners.add(id);
      }
    }
  } catch {
    // The Service leg is additive; the alert phones are still told.
  }
  // Every PropLane-managed workspace's owner: its staff seats and PropLane's admin numbers are told even when the client
  // listed nobody of their own.
  try {
    const { data: service } = await db.from("portal_workspaces").select("owner_user_id").eq("is_service", true).limit(500);
    for (const row of (service ?? []) as Array<{ owner_user_id?: unknown }>) {
      const id = typeof row.owner_user_id === "string" ? row.owner_user_id.trim() : "";
      if (id) owners.add(id);
    }
  } catch {
    /* additive */
  }
  // Every owner with an accepted teammate: their co-managers hear the houses they are on even when the owner listed nobody.
  try {
    const { data: links } = await db.from("account_link_invites").select("inviter_user_id, team_role").eq("status", "accepted").limit(5000);
    for (const row of (links ?? []) as Array<{ inviter_user_id?: unknown; team_role?: unknown }>) {
      if (String(row.team_role ?? "").trim() === "property_owner") continue;
      const id = typeof row.inviter_user_id === "string" ? row.inviter_user_id.trim() : "";
      if (id) owners.add(id);
    }
  } catch {
    /* additive */
  }
  return [...owners];
}

/** The PropLane-managed workspaces: id -> owner. Null when the read fails (then every house falls back to the old per-house path). */
async function loadManagedWorkspaces(db: SupabaseClient): Promise<Map<string, string> | null> {
  const { data, error } = await db.from("portal_workspaces").select("id, owner_user_id").eq("is_service", true).limit(500);
  if (error) return null;
  const out = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ id?: unknown; owner_user_id?: unknown }>) {
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const owner = typeof row.owner_user_id === "string" ? row.owner_user_id.trim() : "";
    if (id && owner) out.set(id, owner);
  }
  return out;
}

type Aggregate = { userId: string | null; houseLines: string[]; houseIds: Set<string>; leads: DigestLead[]; leadKeys: Set<string>; reminders: number };

type HouseLine = { ownerUserId: string; workspaceId: string; propertyId: string; text: string };

const phoneHash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

/** The accounts on each house (owner of record first) and their usable phones, read once for the whole run. */
async function houseManagerPhones(
  db: SupabaseClient,
  lines: readonly HouseLine[],
  opts: { ownersAreRecipients: boolean },
): Promise<{ byHouse: Map<string, HouseDigestRecipient[]>; ownerPhones: Map<string, string>; skipped: number }> {
  const idsByHouse = new Map<string, string[]>();
  for (const line of lines) {
    const ids = await resolveHouseManagerUserIds(db, { ownerUserId: line.ownerUserId, workspaceId: line.workspaceId || null, propertyId: line.propertyId }).catch(() => [line.ownerUserId]);
    idsByHouse.set(`${line.ownerUserId}|${line.propertyId}`, ids);
  }
  const allIds = [...new Set([...idsByHouse.values()].flat())];
  const { phones } = await loadUsableManagerPhones(db, allIds).catch(() => ({ phones: new Map<string, string>() }));
  const owners = new Set(lines.map((l) => l.ownerUserId));
  const skipped = allIds.filter((id) => !phones.has(id) && (opts.ownersAreRecipients || !owners.has(id))).length;
  const byHouse = new Map<string, HouseDigestRecipient[]>();
  for (const [key, ids] of idsByHouse) {
    byHouse.set(
      key,
      ids.flatMap((userId) => {
        const phone = phones.get(userId);
        return phone ? [{ phone, userId, sendClass: "transactional" as const }] : [];
      }),
    );
  }
  const ownerPhones = new Map<string, string>();
  for (const line of lines) {
    const phone = phones.get(line.ownerUserId);
    if (phone) ownerPhones.set(line.ownerUserId, phone);
  }
  return { byHouse, ownerPhones, skipped };
}

/**
 * One digest text per PERSON for the managed workspaces, from the PropLane line: each phone gets the houses it is on (the
 * owner of record and the co-managers only their own houses; a listed admin phone or staff seat the houses its alerts
 * cover), and the admin phones / staff seats also the leads of the last 24 hours and one payment-reminder count. Paid by
 * the platform (`sendTextFromServiceOwner`), idempotent per phone and Pacific day. Returns how many texts were accepted.
 */
async function sendServiceDigests(
  db: SupabaseClient,
  input: {
    dayKey: string;
    now: Date;
    managed: Map<string, string>;
    houseLines: HouseLine[];
    houseLabels: Map<string, string>;
  },
): Promise<{ sent: number; skippedNoPhone: number }> {
  const since = new Date(input.now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const cache = new Map<string, ServiceAlertTargets | null>();
  const targetsFor = async (workspaceId: string, propertyId: string | null, module: "calendar" | "inbox" | "payments") => {
    const key = `${workspaceId}|${propertyId ?? ""}|${module}`;
    if (!cache.has(key)) cache.set(key, await resolveServiceAlertTargets(db, { workspaceId, propertyId, module }).catch(() => null));
    return cache.get(key) ?? null;
  };
  const agg = new Map<string, Aggregate>();
  const slot = (rawPhone: string, userId: string | null): Aggregate | null => {
    const phone = normalizeE164(rawPhone);
    if (!phone) return null;
    let a = agg.get(phone);
    if (!a) {
      a = { userId, houseLines: [], houseIds: new Set(), leads: [], leadKeys: new Set(), reminders: 0 };
      agg.set(phone, a);
    }
    return a;
  };

  // Houses: the service targets first (a listed number's consent is its listing, so it keeps that identity), then the
  // owner of record and every co-manager on the house. One entry per number per house.
  const accounts = await houseManagerPhones(db, input.houseLines, { ownersAreRecipients: true });
  for (const line of input.houseLines) {
    const targets = await targetsFor(line.workspaceId, line.propertyId, "calendar");
    const recipients = dedupeDigestRecipients(
      (targets?.phones ?? []).map((p) => ({ phone: p.phone, userId: p.userId, sendClass: "transactional" as const })),
      accounts.byHouse.get(`${line.ownerUserId}|${line.propertyId}`) ?? [],
    );
    for (const r of recipients) {
      const a = slot(r.phone, r.userId);
      if (!a || a.houseIds.has(line.propertyId)) continue;
      a.houseIds.add(line.propertyId);
      a.houseLines.push(line.text);
    }
  }

  const workspaceIds = [...input.managed.keys()];
  const addLead = (phones: Array<{ phone: string; userId: string | null }>, key: string, lead: DigestLead) => {
    for (const p of phones) {
      const a = slot(p.phone, p.userId);
      if (!a || a.leadKeys.has(key)) continue;
      a.leadKeys.add(key);
      a.leads.push(lead);
    }
  };
  try {
    const { data: contacts } = await db
      .from("manager_sms_contacts")
      .select("workspace_id, phone_e164, display_name, counterparty_role")
      .in("workspace_id", workspaceIds)
      .in("counterparty_role", ["prospect", "applicant"])
      .gte("created_at", since)
      .limit(500);
    for (const c of (contacts ?? []) as Array<{ workspace_id?: unknown; phone_e164?: unknown; display_name?: unknown }>) {
      const ws = String(c.workspace_id ?? "");
      const targets = await targetsFor(ws, null, "inbox");
      if (!targets) continue;
      const name = String(c.display_name ?? "").trim().split(" ")[0] || null;
      addLead(targets.phones, `${ws}|${String(c.phone_e164 ?? "")}`, { firstName: name, house: null });
    }
    const { data: leads } = await db
      .from("sms_unassigned_leads")
      .select("phone_key, assigned_workspace_id, assigned_property_id")
      .gte("created_at", since)
      .limit(500);
    const ops = await loadPlatformOpsPhones(db);
    for (const l of (leads ?? []) as Array<{ phone_key?: unknown; assigned_workspace_id?: unknown; assigned_property_id?: unknown }>) {
      const ws = String(l.assigned_workspace_id ?? "");
      const house = input.houseLabels.get(String(l.assigned_property_id ?? "")) ?? null;
      const lead: DigestLead = { firstName: null, house };
      if (ws && input.managed.has(ws)) {
        const targets = await targetsFor(ws, String(l.assigned_property_id ?? "") || null, "inbox");
        if (targets) addLead(targets.phones, `${ws}|${String(l.phone_key)}`, lead);
      } else if (!ws) {
        addLead(ops.map((phone) => ({ phone, userId: null })), `open|${String(l.phone_key)}`, lead);
      }
    }
  } catch {
    /* leads are additive: the houses still go out */
  }

  // One count for the routine payment reminders of the day, in place of one Team line per resident.
  const counted = new Set<string>();
  for (const [workspaceId, owner] of input.managed) {
    if (counted.has(owner)) continue;
    counted.add(owner);
    try {
      const { data } = await db.from("payment_reminder_occurrences").select("recipient_email").eq("manager_user_id", owner).gte("created_at", since).limit(1000);
      const residents = new Set(((data ?? []) as Array<{ recipient_email?: unknown }>).map((r) => String(r.recipient_email ?? "").toLowerCase()).filter(Boolean)).size;
      if (residents === 0) continue;
      const targets = await targetsFor(workspaceId, null, "payments");
      for (const p of targets?.phones ?? []) {
        const a = slot(p.phone, p.userId);
        if (a) a.reminders += residents;
      }
    } catch {
      /* additive */
    }
  }

  let sent = 0;
  const refusals: string[] = [];
  for (const [phone, a] of agg) {
    // Nothing to say = no text (`composeServiceDigest` returns none for a quiet day).
    const texts = composeServiceDigest({ houseLines: a.houseLines, leads: a.leads, remindersResidents: a.reminders });
    for (const [index, text] of texts.entries()) {
      const key = `svc-digest:${input.dayKey}:${phoneHash(phone)}:${index}`;
      const out = await sendTextFromServiceOwner(db, { toPhone: phone, text, dedupeKey: key, purpose: SERVICE_ALERT_PHONE_SMS_PURPOSE, recipientUserId: a.userId, sendClass: "transactional" });
      if (out.ok) sent += 1;
      else {
        console.error("service digest text refused", out.reason);
        refusals.push(out.reason);
      }
    }
  }
  if (refusals.length > 0) await reportServiceSendFailure(db, refusals, "daily digest");
  return { sent, skippedNoPhone: accounts.skipped };
}

/**
 * The co-managers of SELF-SERVE houses: one combined text per phone per workspace, from that workspace's own work number
 * (billed to the owner, as every teammate notice is). The owner of record is not texted here (their listed alert phones
 * already got the per-house text from `alertPhonesOf`), and neither is a phone that is listed or is the owner's own.
 */
async function sendSelfServeManagerDigests(
  db: SupabaseClient,
  input: { dayKey: string; houseLines: HouseLine[] },
): Promise<{ sent: number; skippedNoPhone: number }> {
  if (input.houseLines.length === 0) return { sent: 0, skippedNoPhone: 0 };
  const accounts = await houseManagerPhones(db, input.houseLines, { ownersAreRecipients: false });
  const listedByOwner = new Map<string, Set<string>>();
  const listedFor = async (ownerUserId: string): Promise<Set<string> | null> => {
    if (!listedByOwner.has(ownerUserId)) {
      try {
        const listed = await listWorkNumberRecipients(db, ownerUserId);
        listedByOwner.set(ownerUserId, new Set(listed.map((r) => normalizeE164(r.phone)).filter((p): p is string => Boolean(p))));
      } catch {
        return null;
      }
    }
    return listedByOwner.get(ownerUserId) ?? null;
  };
  const buckets = new Map<string, HouseDigestBucket>();
  const senderOf = new Map<string, { ownerUserId: string; workspaceId: string }>();
  for (const line of input.houseLines) {
    // An unreadable alert list could hide a listed phone that was already texted: skip rather than text it twice.
    const listed = await listedFor(line.ownerUserId);
    if (!listed) continue;
    const ownerPhone = accounts.ownerPhones.get(line.ownerUserId) ?? null;
    const coManagers = (accounts.byHouse.get(`${line.ownerUserId}|${line.propertyId}`) ?? []).filter(
      (r) => r.userId !== line.ownerUserId && r.phone !== ownerPhone && !listed.has(r.phone),
    );
    const scope = `${line.ownerUserId}|${line.workspaceId}`;
    senderOf.set(scope, { ownerUserId: line.ownerUserId, workspaceId: line.workspaceId });
    addHouseLineToRecipients(buckets, line, coManagers, scope);
  }
  let sent = 0;
  const { sendFromManagerWorkNumber } = await import("@/lib/proplane-sms-transport.server");
  for (const [key, bucket] of buckets) {
    const scope = key.slice(0, key.lastIndexOf("|"));
    const sender = senderOf.get(scope);
    if (!sender) continue;
    const texts = composeServiceDigest({ houseLines: bucket.houseLines, leads: [] });
    for (const [index, text] of texts.entries()) {
      try {
        const out = await sendFromManagerWorkNumber({
          managerUserId: sender.ownerUserId,
          workspaceId: sender.workspaceId || null,
          to: bucket.phone,
          text,
          source: "automated",
          sendClass: "transactional",
          counterpartyRole: "manager",
          purpose: TEAM_NOTICE_SMS_PURPOSE,
          dedupeKey: `house-digest:${input.dayKey}:${phoneHash(`${scope}|${bucket.phone}`)}:${index}`,
          recipientUserId: bucket.userId,
          skipLog: true,
        });
        if (out.ok || out.durablyAccepted) sent += 1;
        else console.error("house digest text refused", out.error ?? "unknown");
      } catch {
        console.error("house digest text failed");
      }
    }
  }
  return { sent, skippedNoPhone: accounts.skipped };
}

export async function runCheckinCheckoutDigest(
  db: SupabaseClient,
  deps: { now?: () => Date; force?: boolean } = {},
): Promise<CheckinDigestSummary> {
  const now = (deps.now ?? (() => new Date()))();
  const summary: CheckinDigestSummary = { owners: 0, houses: 0, sent: 0, failed: 0 };
  if (!deps.force && pacificHourOfDay(now) !== CHECKIN_DIGEST_HOUR_PACIFIC) return { ...summary, skippedReason: "not_7am" };
  const owners = await ownersToTell(db);
  if (!owners) return { ...summary, skippedReason: "unreadable" };
  const dayKey = pacificCalendarDateYmd(now);
  const url = `${resolveEmailLinkBaseUrl().replace(/\/$/, "")}/portal/bookings/upcoming`;

  const managed = await loadManagedWorkspaces(db).catch(() => null);
  const workspaceOfHouse = new Map<string, string>();
  const houseLabels = new Map<string, string>();
  const serviceHouseLines: HouseLine[] = [];
  const selfServeHouseLines: HouseLine[] = [];

  const digestForOwner = async (ownerUserId: string): Promise<void> => {
    // The houses and the clock each house keeps come from ONE read. Loading the clock per property was
    // a round trip per house (500 of them, for every owner, inside a single 120s invocation), which ran
    // the cron out of time and left the later owners with no 7 AM text at all.
    const { data: properties, error } = await db
      .from("manager_property_records")
      .select("id, workspace_id, row_data, property_data")
      .eq("manager_user_id", ownerUserId)
      .limit(500);
    if (error) throw new Error(error.message);
    const rows = (properties ?? []) as Array<{ id?: unknown; workspace_id?: unknown; row_data?: unknown; property_data?: unknown }>;
    const clocks = new Map<string, ReturnType<typeof propertyStayClockFromRecord>["times"]>();
    const propertyIds: string[] = [];
    for (const row of rows) {
      const id = String(row.id ?? "").trim();
      if (!id) continue;
      propertyIds.push(id);
      workspaceOfHouse.set(id, String(row.workspace_id ?? "").trim());
      const label = propertyLabel(row.row_data);
      if (label) houseLabels.set(id, label);
      clocks.set(id, propertyStayClockFromRecord(row).times);
    }
    if (propertyIds.length === 0) return;
    summary.owners += 1;
    const { entries } = await occupancyEntriesForManager(db, ownerUserId, { propertyIds });
    const timed = withResolvedStayTimes(entries, (propertyId) => clocks.get(propertyId) as never);
    for (const line of digestLinesByHouse(timed, dayKey)) {
      summary.houses += 1;
      // A managed workspace's houses go into ONE digest per person (below); every other workspace keeps its per-house text.
      const managedWorkspace = workspaceOfHouse.get(line.propertyId) ?? "";
      if (managed?.has(managedWorkspace)) {
        serviceHouseLines.push({ ownerUserId, workspaceId: managedWorkspace, propertyId: line.propertyId, text: line.text });
        continue;
      }
      selfServeHouseLines.push({ ownerUserId, workspaceId: managedWorkspace, propertyId: line.propertyId, text: line.text });
      const out = await alertPhonesOf(db, {
        ownerUserId,
        kind: "checkin_checkout_today",
        entityId: checkinDigestEntityId(line.propertyId, dayKey),
        propertyId: line.propertyId,
        text: line.text,
        url,
      });
      if (out.texted + out.emailed > 0) summary.sent += 1;
    }
  };

  // Rotated by the day, from a stable order: a run that outlives its 120s budget cuts off whoever is last,
  // and an unrotated list cuts off the SAME owners every morning — they would never get their 7 AM text.
  const ordered = [...owners].sort();
  const dayIndex = Math.floor(Date.parse(`${dayKey}T00:00:00Z`) / 86_400_000);
  const start = ordered.length > 0 && Number.isFinite(dayIndex) ? ((dayIndex % ordered.length) + ordered.length) % ordered.length : 0;
  const rotated = [...ordered.slice(start), ...ordered.slice(0, start)];

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const ownerUserId = rotated[next++];
      if (!ownerUserId) return;
      try {
        await digestForOwner(ownerUserId);
      } catch {
        // One owner's unreadable house never stops the next owner's text. Nothing identifying is logged.
        summary.failed += 1;
        console.error("check-in digest failed for one owner");
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(CHECKIN_DIGEST_OWNER_CONCURRENCY, owners.length || 1)) }, worker),
  );
  // The managed workspaces' digest also carries leads and the reminder count, so it runs even when no house has a move today.
  let skippedNoPhone = 0;
  if (managed && managed.size > 0) {
    try {
      const out = await sendServiceDigests(db, { dayKey, now, managed, houseLines: serviceHouseLines, houseLabels });
      summary.serviceTexts = out.sent;
      summary.sent += out.sent;
      skippedNoPhone += out.skippedNoPhone;
    } catch {
      summary.failed += 1;
      console.error("service digest failed");
    }
  }
  try {
    const out = await sendSelfServeManagerDigests(db, { dayKey, houseLines: selfServeHouseLines });
    summary.managerTexts = out.sent;
    summary.sent += out.sent;
    skippedNoPhone += out.skippedNoPhone;
  } catch {
    summary.failed += 1;
    console.error("house manager digest failed");
  }
  if (skippedNoPhone > 0) {
    summary.skippedNoPhone = skippedNoPhone;
    // A count only: no id, name or number.
    console.info("check-in digest: managers with no usable phone skipped", skippedNoPhone);
  }
  return summary;
}
