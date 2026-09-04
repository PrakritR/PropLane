/**
 * "Who manages this resident RIGHT NOW" — the one resolver behind every
 * resident-facing view of their manager's work number.
 *
 * The number is deliberately NOT stored on the resident. A resident moves: they
 * sign at a different house, sometimes under a different manager, and the
 * number they are told to text has to become the new one the moment that lease
 * is real. Deriving it on every read means a new lease changes the answer just
 * by existing — there is no field to migrate, no cache to bust, and no way for
 * a stale copy to keep pointing at the manager they left.
 *
 * A resident mid-move gets BOTH managers with dates rather than one picked
 * silently: that is exactly the moment the two houses are easiest to confuse,
 * and misrouting a message then is worse than showing an extra line.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadManagerAssistantEmail } from "@/lib/manager-assistant-email/manager-assistant-email.server";
import { resolveActiveManagerSendNumber } from "@/lib/sms/manager-number-provisioning.server";
import { orFilterForIdentity } from "@/lib/supabase/or-filter";

export type ResidentManagerContact = {
  managerUserId: string;
  /** Sendable work number in E.164, or null when they have none yet. */
  phone: string | null;
  /** Manager's PropLane assistant inbox, when provisioned. */
  assistantEmail: string | null;
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

/**
 * Every tenancy that can still justify showing a manager's number, newest
 * first. Ended tenancies are kept: move-out questions and the deposit return
 * are exactly when a former resident most needs to reach someone, and they are
 * only surfaced when nothing current exists.
 */
export async function resolveResidentManagerContacts(
  db: SupabaseClient,
  args: { residentUserId?: string | null; residentEmail?: string | null; nowMs?: number },
): Promise<ResidentManagerContact[]> {
  const email = args.residentEmail?.trim().toLowerCase() ?? "";
  const userId = args.residentUserId?.trim() ?? "";
  if (!email && !userId) return [];

  let query = db
    .from("portal_lease_pipeline_records")
    .select("manager_user_id, property_id, status, updated_at, row_data")
    .order("updated_at", { ascending: false })
    .limit(50);
  // Scope by the resident's OWN identity. Both columns are theirs; neither is
  // supplied by the caller of the API above this.
  const scope = orFilterForIdentity([
    ["resident_user_id", userId],
    ["resident_email", email],
  ]);
  query = scope ? query.or(scope) : query.eq("resident_user_id", "");

  const { data, error } = await query;
  if (error) return [];

  const nowMs = args.nowMs ?? Date.now();
  const byManager = new Map<string, ResidentManagerContact>();
  for (const row of (data ?? []) as LeaseRow[]) {
    const managerUserId = text(row.manager_user_id);
    if (!managerUserId) continue;
    const rowData = row.row_data ?? {};
    const application = (rowData.application ?? {}) as Record<string, unknown>;
    const leaseStart = text(application.leaseStart) ?? text(rowData.leaseStart);
    const leaseEnd = text(application.leaseEnd) ?? text(rowData.leaseEnd);
    const contact: ResidentManagerContact = {
      managerUserId,
      phone: null,
      assistantEmail: null,
      propertyLabel: text(rowData.propertyLabel) ?? text(rowData.propertyName) ?? text(row.property_id),
      leaseStart,
      leaseEnd,
      status: classifyTenancy(leaseStart, leaseEnd, nowMs),
    };
    // One row per manager — a resident with several leases under the same
    // manager needs that number once, not once per lease. Rows arrive newest
    // first, so the first is the one worth keeping.
    if (!byManager.has(managerUserId)) byManager.set(managerUserId, contact);
  }

  const all = [...byManager.values()];
  const live = all.filter((c) => c.status !== "ended");
  return live.length > 0 ? live : all;
}

/**
 * The resolver plus the numbers, filtered to those that can ACTUALLY receive a
 * text or email. A number that is not sendable is worse than none: the resident
 * texts it and hears nothing, which reads as being ignored by their manager.
 */
export async function resolveResidentManagerPhones(
  db: SupabaseClient,
  args: { residentUserId?: string | null; residentEmail?: string | null; nowMs?: number },
): Promise<ResidentManagerContact[]> {
  const contacts = await resolveResidentManagerContacts(db, args);
  const withChannels = await Promise.all(
    contacts.map(async (contact) => {
      const [phone, assistantRow] = await Promise.all([
        resolveActiveManagerSendNumber(db, contact.managerUserId).catch(() => null),
        loadManagerAssistantEmail(db, contact.managerUserId).catch(() => null),
      ]);
      return {
        ...contact,
        phone,
        assistantEmail: assistantRow?.address?.trim() || null,
      };
    }),
  );
  return withChannels.filter((contact) => Boolean(contact.phone || contact.assistantEmail));
}
