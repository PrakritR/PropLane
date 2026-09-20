/**
 * "Who manages this resident RIGHT NOW" — the one resolver behind every
 * resident-facing view of how to reach their manager.
 *
 * The contact is deliberately NOT stored on the resident. A resident moves: they
 * sign at a different house, sometimes under a different manager, and the
 * number they are told to text has to become the new one the moment that lease
 * is real. Deriving it on every read means a new lease changes the answer just
 * by existing — there is no field to migrate, no cache to bust, and no way for
 * a stale copy to keep pointing at the manager they left.
 *
 * A resident mid-move gets BOTH managers with dates rather than one picked
 * silently: that is exactly the moment the two houses are easiest to confuse,
 * and misrouting a message then is worse than showing an extra line.
 *
 * Before a lease exists, the manager is whoever holds the resident's live
 * application or charges — the same evidence `managerIdsOwningResident`
 * (resident-manager-scope.ts) accepts for "which managers may this resident
 * message". An applicant paying an application fee is already talking to that
 * manager in their inbox; the card must not pretend they have nobody to reach.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveActiveManagerWorkEmail } from "@/lib/manager-assistant-email/manager-assistant-email.server";
import { loadManagerAutomationSettings } from "@/lib/payment-automation-settings";
import { resolveActiveManagerSendNumber } from "@/lib/sms/manager-number-provisioning.server";
import { orFilterForIdentity } from "@/lib/supabase/or-filter";
import { normalizeE164 } from "@/lib/phone-e164";
import { applicationRowLinksResident } from "@/lib/resident-manager-scope";

export type ResidentManagerContact = {
  managerUserId: string;
  /**
   * Manager's display name, for the resident's contact card. The manager's id
   * is still withheld from the API response — a resident already sees this name
   * on every message they receive, so it discloses nothing new.
   */
  managerName: string | null;
  /**
   * The phone the resident can reach this manager on, E.164. The provisioned
   * work number wins when it can send; otherwise the phone on the manager's
   * own profile, but ONLY when they opted in
   * (`shareProfileContactWithoutWorkChannel`, default off). Null when the
   * manager has neither, or has not opted in.
   */
  phone: string | null;
  /**
   * What `phone` is. A work number is a texting line that never rings, so the
   * card offers Text only; a profile phone is a real line and also gets Call.
   */
  phoneKind: "work" | "profile" | null;
  /**
   * The email the resident can write to. The workspace work email wins when
   * provisioned; otherwise the manager's account email under the same opt-in
   * as `phone`. Null when the manager has neither, or has not opted in.
   */
  email: string | null;
  emailKind: "work" | "account" | null;
  /** House this tenancy is for — rendered only when there are several. */
  propertyLabel: string | null;
  leaseStart: string | null;
  leaseEnd: string | null;
  /** Whether the tenancy has begun, so the UI can date a future one. */
  status: "current" | "upcoming" | "ended";
};

type LeaseRow = {
  manager_user_id: string | null;
  property_id: string | null;
  status: string | null;
  updated_at: string | null;
  row_data: Record<string, unknown> | null;
};

function text(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || null;
}

function dayMs(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Classify a tenancy against today. An absent date is never treated as a
 * boundary: a lease with no end has not ended, and one with no start has
 * already begun — guessing either way would hide a number the resident needs.
 */
export function classifyTenancy(
  leaseStart: string | null,
  leaseEnd: string | null,
  nowMs: number = Date.now(),
): ResidentManagerContact["status"] {
  const start = dayMs(leaseStart);
  const end = dayMs(leaseEnd);
  if (start != null && start > nowMs) return "upcoming";
  if (end != null && end < nowMs) return "ended";
  return "current";
}

type ApplicationRow = {
  manager_user_id: string | null;
  property_id: string | null;
  assigned_property_id: string | null;
  occupancy_start: string | null;
  updated_at: string | null;
  row_data: Record<string, unknown> | null;
};

type ChargeRow = {
  manager_user_id: string | null;
  updated_at: string | null;
  row_data: Record<string, unknown> | null;
};

function propertyLabelOf(rowData: Record<string, unknown>, ...fallbacks: Array<string | null>): string | null {
  return (
    text(rowData.propertyLabel) ??
    text(rowData.propertyName) ??
    text(rowData.property) ??
    fallbacks.map((value) => text(value)).find((value): value is string => Boolean(value)) ??
    null
  );
}

/**
 * Every tenancy that can still justify showing a manager's contact, newest
 * first. Ended tenancies are kept: move-out questions and the deposit return
 * are exactly when a former resident most needs to reach someone, and they are
 * only surfaced when nothing current exists.
 *
 * A LIVE lease is the strongest evidence and wins outright. Absent one — either
 * no lease at all, or only an ended one — a live application, then a charge,
 * names the manager instead. This matters for a former resident whose lease
 * ended and who has since applied to a different manager's house: the ended
 * lease alone must not block that live application from surfacing, so the
 * fallbacks are gated on "no LIVE tenancy yet", not "no lease row at all".
 */
export async function resolveResidentManagerContacts(
  db: SupabaseClient,
  args: { residentUserId?: string | null; residentEmail?: string | null; nowMs?: number },
): Promise<ResidentManagerContact[]> {
  const email = args.residentEmail?.trim().toLowerCase() ?? "";
  const userId = args.residentUserId?.trim() ?? "";
  if (!email && !userId) return [];
  const nowMs = args.nowMs ?? Date.now();

  // Scope by the resident's OWN identity. Both columns are theirs; neither is
  // supplied by the caller of the API above this.
  const scope = orFilterForIdentity([
    ["resident_user_id", userId],
    ["resident_email", email],
  ]);

  const byManager = new Map<string, ResidentManagerContact>();
  const remember = (contact: ResidentManagerContact) => {
    // One row per manager — a resident with several records under the same
    // manager needs that contact once, not once per record. Rows arrive
    // newest first, so the first is the one worth keeping.
    if (!byManager.has(contact.managerUserId)) byManager.set(contact.managerUserId, contact);
  };
  const blank = (managerUserId: string): ResidentManagerContact => ({
    managerUserId,
    managerName: null,
    phone: null,
    phoneKind: null,
    email: null,
    emailKind: null,
    propertyLabel: null,
    leaseStart: null,
    leaseEnd: null,
    status: "current",
  });

  let leaseQuery = db
    .from("portal_lease_pipeline_records")
    .select("manager_user_id, property_id, status, updated_at, row_data")
    .order("updated_at", { ascending: false })
    .limit(50);
  leaseQuery = scope ? leaseQuery.or(scope) : leaseQuery.eq("resident_user_id", "");
  const { data: leases, error: leaseError } = await leaseQuery;
  if (leaseError) return [];
  for (const row of (leases ?? []) as LeaseRow[]) {
    const managerUserId = text(row.manager_user_id);
    if (!managerUserId) continue;
    const rowData = row.row_data ?? {};
    const application = (rowData.application ?? {}) as Record<string, unknown>;
    const leaseStart = text(application.leaseStart) ?? text(rowData.leaseStart);
    const leaseEnd = text(application.leaseEnd) ?? text(rowData.leaseEnd);
    remember({
      ...blank(managerUserId),
      propertyLabel: propertyLabelOf(rowData, row.property_id),
      leaseStart,
      leaseEnd,
      status: classifyTenancy(leaseStart, leaseEnd, nowMs),
    });
  }

  // Gate the fallbacks on whether a LIVE tenancy has been found so far, not on
  // whether any manager has been found at all. A former resident whose lease
  // ended keeps that manager in `byManager`, but an ended tenancy is not
  // "current" — if they have since applied to a different manager's house,
  // that live application must still surface rather than being hidden behind
  // the stale, ended one.
  const hasLiveContact = () => [...byManager.values()].some((c) => c.status !== "ended");

  if (!hasLiveContact() && email) {
    // Applications are keyed by email only (they predate the account).
    const { data: apps } = await db
      .from("manager_application_records")
      .select("manager_user_id, property_id, assigned_property_id, occupancy_start, updated_at, row_data")
      .eq("resident_email", email)
      .order("updated_at", { ascending: false })
      .limit(25);
    for (const row of (apps ?? []) as ApplicationRow[]) {
      const managerUserId = text(row.manager_user_id);
      const rowData = row.row_data ?? {};
      if (!managerUserId || !applicationRowLinksResident(rowData)) continue;
      const application = (rowData.application ?? {}) as Record<string, unknown>;
      const leaseStart = text(application.leaseStart) ?? text(rowData.leaseStart) ?? text(row.occupancy_start);
      remember({
        ...blank(managerUserId),
        propertyLabel: propertyLabelOf(rowData, row.assigned_property_id, row.property_id),
        leaseStart,
        status: classifyTenancy(leaseStart, null, nowMs),
      });
    }
  }

  if (!hasLiveContact()) {
    let chargeQuery = db
      .from("portal_household_charge_records")
      .select("manager_user_id, updated_at, row_data")
      .order("updated_at", { ascending: false })
      .limit(25);
    chargeQuery = scope ? chargeQuery.or(scope) : chargeQuery.eq("resident_user_id", "");
    const { data: charges } = await chargeQuery;
    for (const row of (charges ?? []) as ChargeRow[]) {
      const managerUserId = text(row.manager_user_id);
      if (!managerUserId) continue;
      remember({ ...blank(managerUserId), propertyLabel: propertyLabelOf(row.row_data ?? {}) });
    }
  }

  const all = [...byManager.values()];
  const live = all.filter((c) => c.status !== "ended");
  return live.length > 0 ? live : all;
}

/**
 * The resolver plus the ways to reach each manager.
 *
 * A work number that cannot actually send is dropped rather than shown: the
 * resident would text it and hear nothing, which reads as being ignored. But
 * "no work channel yet" is NOT "unreachable" — most managers put a phone and an
 * email on their profile long before they provision a work line. But a profile
 * phone is a personal line, and this resolver also serves applicants the
 * manager has not accepted, so the profile fallback is OPT-IN: only a manager
 * who turned on "Share my profile phone and email" in Communication settings
 * has those channels shown. Off (the default), only provisioned work channels
 * are disclosed, and a contact with neither is dropped.
 */
export async function resolveResidentManagerPhones(
  db: SupabaseClient,
  args: { residentUserId?: string | null; residentEmail?: string | null; nowMs?: number },
): Promise<ResidentManagerContact[]> {
  const contacts = await resolveResidentManagerContacts(db, args);
  const withChannels = await Promise.all(
    contacts.map(async (contact) => {
      const [workPhone, workEmail, profileRow, settings] = await Promise.all([
        resolveActiveManagerSendNumber(db, contact.managerUserId).catch(() => null),
        resolveActiveManagerWorkEmail(db, contact.managerUserId).catch(() => null),
        Promise.resolve(
          db.from("profiles").select("full_name, phone, email").eq("id", contact.managerUserId).maybeSingle(),
        )
          .then((res) => res.data)
          .catch(() => null),
        loadManagerAutomationSettings(db, contact.managerUserId).catch(() => null),
      ]);
      const profile = (profileRow ?? null) as { full_name?: unknown; phone?: unknown; email?: unknown } | null;
      // A failed settings read stays closed: nothing personal is shown by accident.
      const shareProfile = settings?.shareProfileContactWithoutWorkChannel === true;
      const profilePhone = shareProfile ? text(profile?.phone) : null;
      const accountEmail = shareProfile ? (text(profile?.email)?.toLowerCase() ?? null) : null;
      // `profiles.phone` is free-form trimmed text (`PATCH /api/profile` never
      // normalizes it), yet this value is interpolated verbatim into a
      // `tel:`/`sms:` href. Normalize through the codebase's one E.164
      // normalizer before it ever reaches the card; a value that cannot be
      // normalized is dropped rather than emitted as a broken link.
      const phone = normalizeE164(workPhone) ?? normalizeE164(profilePhone);
      const email = text(workEmail)?.toLowerCase() ?? accountEmail;
      return {
        ...contact,
        // An absent name is not an error — the card simply leads with the
        // number, as it did before there was a name to show.
        managerName: text(profile?.full_name),
        phone,
        phoneKind: phone ? (normalizeE164(workPhone) ? "work" : "profile") : null,
        email,
        emailKind: email ? (text(workEmail) ? "work" : "account") : null,
      } satisfies ResidentManagerContact;
    }),
  );
  return withChannels.filter((contact) => Boolean(contact.phone || contact.email));
}
