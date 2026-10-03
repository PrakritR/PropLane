import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { InboxScopedContact } from "@/data/inbox-scoped-directory";
import { PRIMARY_ADMIN_EMAIL } from "@/lib/auth/primary-admin";
import {
  managerHasAuthoritativeResidentLink,
  recipientInReach,
  type RecipientReach,
} from "@/lib/auth/resident-relationship";
import { postgrestFilterValue } from "@/lib/supabase/or-filter";
import { managerIdsOwningResident } from "@/lib/resident-manager-scope";
import { assertTestWorkspacePrincipalCompatibility } from "@/lib/test-workspaces/index.server";

/** Shared singleton holding every manager's tour inquiries (see tour-inquiry.server). */
const INQUIRIES_RECORD_ID = "axis_admin_partner_inquiries_v1";

/**
 * Server-side recipient scoping for the portal inbox compose flow.
 *
 * The compose UI already hides out-of-scope people, but the UI is not a security
 * boundary. These helpers are the authoritative gate: they decide, per sender
 * role, exactly which recipients a message may be delivered to. Both the
 * eligible-contacts query (what the picker lists) and the send endpoints call
 * into this module so the two can never drift.
 *
 * Rules (non-admin senders):
 *  - Resident sender  → may message ONLY the managers/owners tied to their own
 *    listing(s)/lease(s)/tours, plus those managers' linked co-managers, plus Axis
 *    admin ops. Never other residents, never arbitrary managers.
 *  - Manager sender   → may message ONLY people in their funnel (applications,
 *    charges, leases, tour links/inquiries, listing leads in their inbox), plus
 *    their own linked co-managers, plus Axis admin ops. Never arbitrary
 *    strangers, never unlinked managers.
 *  - Admin sender     → unrestricted (unchanged).
 */

const ADMIN_EMAIL = PRIMARY_ADMIN_EMAIL.trim().toLowerCase();

export type InboxScopeSender = {
  id: string;
  email: string;
  role: string | null;
  isAdmin: boolean;
  /**
   * The workspace and house grants the sender is acting within. A manager or
   * co-manager send is checked against them; omitted, only the sender's own
   * people are reachable (never another owner's, never a co-manager's).
   */
  reach?: RecipientReach;
};

export type { RecipientReach };

/** The reach a resolved Communication scope grants: its active workspace and granted houses. */
export function recipientReachFromScope(scope: {
  workspaceHouseIds: Set<string> | null;
  untaggedOwnedVisible: boolean;
  grantedHousesByOwner: Map<string, Set<string>>;
  activeWorkspaceId: string | null;
}): RecipientReach {
  return {
    workspaceHouseIds: scope.workspaceHouseIds,
    untaggedOk: scope.untaggedOwnedVisible,
    grantedHousesByOwner: scope.grantedHousesByOwner,
    activeWorkspaceId: scope.activeWorkspaceId,
  };
}

export type InboxScopeRecipient = { email: string; userId: string | null };

function isManagerRole(role: string | null): boolean {
  const r = String(role ?? "").trim().toLowerCase();
  return r === "manager" || r === "owner" || r === "pro";
}

/**
 * Emails of co-managers linked to any of the given manager ids. Only an
 * ACCEPTED account link counts: `portal_pro_relationship_records` is a
 * client-writable mirror (any account can write a row naming any email), so it
 * is no evidence of a connection.
 */
async function coManagerEmailsForManagers(
  db: SupabaseClient,
  managerIds: string[],
): Promise<Set<string>> {
  const emails = new Set<string>();
  const ids = await accountLinkCoManagerIdsForManagers(db, managerIds);
  if (ids.size === 0) return emails;
  const { data } = await db.from("profiles").select("id, email").in("id", [...ids]);
  for (const row of data ?? []) {
    const email = String(row.email ?? "").trim().toLowerCase();
    if (email) emails.add(email);
  }
  return emails;
}

/** Co-manager auth user ids linked to any of the given manager ids (account links). */
async function accountLinkCoManagerIdsForManagers(
  db: SupabaseClient,
  managerIds: string[],
  /** A membership is per workspace: when given, only members of THAT workspace count. */
  workspaceId?: string | null,
): Promise<Set<string>> {
  const ids = new Set<string>();
  if (managerIds.length === 0) return ids;
  try {
    const { data } = await db
      .from("account_link_invites")
      .select("invitee_user_id, workspace_id")
      .eq("status", "accepted")
      .in("inviter_user_id", managerIds);
    for (const row of (data ?? []) as { invitee_user_id?: unknown; workspace_id?: unknown }[]) {
      const rowWorkspace = String(row.workspace_id ?? "").trim();
      if (workspaceId && rowWorkspace && rowWorkspace !== workspaceId) continue;
      const id = String(row.invitee_user_id ?? "").trim();
      if (id) ids.add(id);
    }
  } catch {
    /* table may not exist */
  }
  return ids;
}

/** Inviters who sent this user a pending or accepted co-manager invite (invitee → inviter messaging). */
async function coManagerInviterIdsForInvitee(
  db: SupabaseClient,
  inviteeUserId: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  if (!inviteeUserId) return ids;
  try {
    const { data } = await db
      .from("account_link_invites")
      .select("inviter_user_id")
      .in("status", ["pending", "accepted"])
      .eq("invitee_user_id", inviteeUserId);
    for (const row of data ?? []) {
      const id = String(row.inviter_user_id ?? "").trim();
      if (id) ids.add(id);
    }
  } catch {
    /* table may not exist */
  }
  return ids;
}

/** Pending co-manager invitees the manager may notify before acceptance. */
async function pendingAccountLinkInviteeIdsForManagers(
  db: SupabaseClient,
  managerIds: string[],
): Promise<Set<string>> {
  const ids = new Set<string>();
  if (managerIds.length === 0) return ids;
  try {
    const { data } = await db
      .from("account_link_invites")
      .select("invitee_user_id")
      .eq("status", "pending")
      .in("inviter_user_id", managerIds);
    for (const row of data ?? []) {
      const id = String(row.invitee_user_id ?? "").trim();
      if (id) ids.add(id);
    }
  } catch {
    /* table may not exist */
  }
  return ids;
}

/**
 * Emails of the sender's HOUSEMATES: other approved residents assigned to the
 * same property, under one of the same managers. Derived from the manager's own
 * application records — never from client input — and deliberately narrow: a
 * resident may reach the people they live with, not every resident the manager
 * has.
 */
async function housemateEmailsForResident(
  db: SupabaseClient,
  managerIds: string[],
  residentEmail: string,
): Promise<Set<string>> {
  const emails = new Set<string>();
  if (managerIds.length === 0 || !residentEmail) return emails;
  const { data } = await db
    .from("manager_application_records")
    .select("resident_email, row_data")
    .in("manager_user_id", managerIds);
  const rows = ((data ?? []) as { resident_email: unknown; row_data: unknown }[])
    .map((r) => ({
      email: String(r.resident_email ?? "").trim().toLowerCase(),
      data: (r.row_data ?? {}) as Record<string, unknown>,
    }))
    .filter((r) => r.email && String(r.data.bucket ?? "") === "approved");

  const ownPropertyIds = new Set(
    rows
      .filter((r) => r.email === residentEmail)
      .map((r) => String(r.data.assignedPropertyId ?? r.data.propertyId ?? "").trim())
      .filter(Boolean),
  );
  if (ownPropertyIds.size === 0) return emails;

  for (const row of rows) {
    if (row.email === residentEmail) continue;
    const propertyId = String(row.data.assignedPropertyId ?? row.data.propertyId ?? "").trim();
    if (propertyId && ownPropertyIds.has(propertyId)) emails.add(row.email);
  }
  return emails;
}

/**
 * Vendors the given managers are actually LINKED to: a directory row whose
 * `vendor_user_id` is set (the vendor accepted). A directory row is typed by
 * the manager - an email in it proves nothing about who owns that mailbox.
 */
async function linkedVendorsForManagers(
  db: SupabaseClient,
  managerIds: string[],
): Promise<{ userIds: Set<string>; emails: Set<string> }> {
  const userIds = new Set<string>();
  const emails = new Set<string>();
  if (managerIds.length === 0) return { userIds, emails };
  const { data } = await db
    .from("manager_vendor_records")
    .select("vendor_user_id")
    .in("manager_user_id", managerIds);
  for (const row of data ?? []) {
    const id = String(row.vendor_user_id ?? "").trim();
    if (id) userIds.add(id);
  }
  if (userIds.size > 0) {
    const { data: profiles } = await db.from("profiles").select("id, email").in("id", [...userIds]);
    for (const row of profiles ?? []) {
      const email = String(row.email ?? "").trim().toLowerCase();
      if (email) emails.add(email);
    }
  }
  return { userIds, emails };
}

/** Manager user ids that invited/own the given vendor (by linked auth user or directory email). */
export async function managerIdsOwningVendor(
  db: SupabaseClient,
  vendor: { userId: string; email: string },
): Promise<string[]> {
  const email = vendor.email.trim().toLowerCase();
  const ids = new Set<string>();
  const filter = email
    ? `vendor_user_id.eq.${postgrestFilterValue(vendor.userId)},row_data->>email.eq.${postgrestFilterValue(email)}`
    : `vendor_user_id.eq.${postgrestFilterValue(vendor.userId)}`;
  const { data } = await db
    .from("manager_vendor_records")
    .select("manager_user_id, vendor_user_id, row_data")
    .or(filter);
  for (const row of data ?? []) {
    const id = String(row.manager_user_id ?? "").trim();
    if (id) ids.add(id);
  }
  return [...ids];
}

function isVendorRole(role: string | null): boolean {
  return String(role ?? "").trim().toLowerCase() === "vendor";
}

/**
 * Managers connected to a resident through a booked tour. A signed-in prospect
 * can be legitimately connected before they have an approved application or
 * lease, so excluding this record made the manager disappear from Compose.
 */
async function managerIdsFromResidentTours(db: SupabaseClient, residentUserId: string): Promise<string[]> {
  if (!residentUserId.trim()) return [];
  try {
    const { data } = await db
      .from("resident_tour_links")
      .select("manager_user_id")
      .eq("resident_user_id", residentUserId);
    return [
      ...new Set(
        (data ?? [])
          .map((row) => String(row.manager_user_id ?? "").trim())
          .filter(Boolean),
      ),
    ];
  } catch {
    // The link table was introduced after the inbox. Keep existing residency
    // messaging available during a partially applied migration.
    return [];
  }
}

/**
 * True when the address is already in the manager's pre-application funnel:
 * tour link, tour inquiry, or a listing-lead / property conversation thread.
 * Defaults closed. Does not replace {@link managerHasAuthoritativeResidentLink}.
 */
async function managerConnectedToFunnelProspect(
  db: SupabaseClient,
  requestorUserId: string,
  target: { email: string; residentUserId?: string | null },
  reach?: RecipientReach,
): Promise<boolean> {
  const email = target.email.trim().toLowerCase();
  const residentUserId = target.residentUserId?.trim() || "";
  if (!requestorUserId || (!email && !residentUserId)) return false;

  // The sender, plus each owner they hold a Communication grant under - no
  // blanket union of everyone an account link has ever touched.
  const managerIds = [requestorUserId, ...(reach ? [...reach.grantedHousesByOwner.keys()] : [])];

  try {
    const keys: Array<[string, string]> = [];
    if (email) keys.push(["attendee_email", email]);
    if (residentUserId) keys.push(["resident_user_id", residentUserId]);
    for (const [column, value] of keys) {
      const { data, error } = await db
        .from("resident_tour_links")
        .select("manager_user_id, property_id")
        .in("manager_user_id", managerIds)
        .eq(column, value);
      if (error || !Array.isArray(data)) continue;
      for (const row of data as { manager_user_id?: unknown; property_id?: unknown }[]) {
        if (
          recipientInReach(
            requestorUserId,
            String(row.manager_user_id ?? ""),
            String(row.property_id ?? "").trim(),
            reach,
          )
        ) {
          return true;
        }
      }
    }
  } catch {
    /* migration may be partial */
  }

  if (email) {
    try {
      const { data, error } = await db
        .from("portal_inbox_thread_records")
        .select("id, owner_user_id, row_data")
        .in("owner_user_id", managerIds)
        .eq("participant_email", email)
        .limit(25);
      if (!error && Array.isArray(data)) {
        for (const row of data) {
          const rowData = (row.row_data ?? {}) as Record<string, unknown>;
          // Property-lead / listing conversations carry a property id; bare
          // accidental threads do not unlock messaging.
          const propertyId = String(rowData.propertyId ?? "").trim();
          if (
            propertyId &&
            recipientInReach(requestorUserId, String((row as { owner_user_id?: unknown }).owner_user_id ?? ""), propertyId, reach)
          ) {
            return true;
          }
        }
      }
    } catch {
      /* ignore */
    }

    try {
      const { data } = await db
        .from("portal_schedule_records")
        .select("row_data")
        .eq("id", INQUIRIES_RECORD_ID)
        .maybeSingle();
      const rowData = (data?.row_data ?? {}) as Record<string, unknown>;
      const payload = Array.isArray(rowData.payload) ? rowData.payload : [];
      for (const item of payload) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const inquiry = item as Record<string, unknown>;
        const inquiryEmail = String(inquiry.email ?? "").trim().toLowerCase();
        if (inquiryEmail !== email) continue;
        const hostId = String(inquiry.managerUserId ?? "").trim();
        if (hostId && managerIds.includes(hostId)) return true;
        const windows = Array.isArray(inquiry.requestedWindows) ? inquiry.requestedWindows : [];
        for (const window of windows) {
          if (!window || typeof window !== "object" || Array.isArray(window)) continue;
          const adminId = String((window as Record<string, unknown>).adminUserId ?? "").trim();
          if (adminId && managerIds.includes(adminId)) return true;
        }
      }
    } catch {
      /* ignore */
    }

    // The manager's own schedule rows are NOT evidence: they are written by
    // the manager and can name any attendee email.
  }

  return false;
}

async function managerIdsConnectedToResident(
  db: SupabaseClient,
  sender: { id: string; email: string },
): Promise<string[]> {
  const [residentManagerIds, tourManagerIds] = await Promise.all([
    managerIdsOwningResident(db, sender.email),
    managerIdsFromResidentTours(db, sender.id),
  ]);
  return [...new Set([...residentManagerIds, ...tourManagerIds])];
}

function partition<T>(items: T[], keep: boolean[]): { allowed: T[]; blocked: T[] } {
  const allowed: T[] = [];
  const blocked: T[] = [];
  items.forEach((item, index) => {
    if (keep[index]) allowed.push(item);
    else blocked.push(item);
  });
  return { allowed, blocked };
}

async function namespaceCompatible(
  db: SupabaseClient,
  actorUserId: string,
  related: { userId?: string | null; email: string },
): Promise<boolean> {
  try {
    await assertTestWorkspacePrincipalCompatibility({
      actorUserId,
      relatedUserIds: [related.userId],
      relatedEmails: [related.email],
      db,
    });
    return true;
  } catch {
    return false;
  }
}

async function enforceRecipientNamespace<T extends InboxScopeRecipient>(
  db: SupabaseClient,
  actorUserId: string,
  result: { allowed: T[]; blocked: T[] },
): Promise<{ allowed: T[]; blocked: T[] }> {
  const compatible = await Promise.all(
    result.allowed.map((recipient) => namespaceCompatible(db, actorUserId, recipient)),
  );
  const scoped = partition(result.allowed, compatible);
  return { allowed: scoped.allowed, blocked: [...result.blocked, ...scoped.blocked] };
}

async function enforceContactNamespace(
  db: SupabaseClient,
  actorUserId: string,
  contacts: InboxScopedContact[],
): Promise<InboxScopedContact[]> {
  const compatible = await Promise.all(
    contacts.map((contact) => namespaceCompatible(db, actorUserId, { email: contact.email })),
  );
  return contacts.filter((_, index) => compatible[index]);
}

/**
 * Split recipients into those the sender is authorized to message and those they
 * are not. Admin ops (PRIMARY_ADMIN_EMAIL) is always allowed. Defaults closed.
 */
export async function filterRecipientsBySenderScope<T extends InboxScopeRecipient>(
  db: SupabaseClient,
  sender: InboxScopeSender,
  recipients: T[],
): Promise<{ allowed: T[]; blocked: T[] }> {
  if (recipients.length === 0) return { allowed: [], blocked: [] };
  if (sender.isAdmin) return { allowed: recipients, blocked: [] };

  const senderEmail = sender.email.trim().toLowerCase();

  if (isManagerRole(sender.role)) {
    const reach = sender.reach;
    // Authoritative sources only (accepted account links, linked vendors,
    // applications / leases / tours the resident or system wrote), narrowed to
    // the active workspace and the houses this sender is granted.
    const [coManagerIds, pendingInviteeIds, inviterIdsForInvitee, linkedVendors] = await Promise.all([
      accountLinkCoManagerIdsForManagers(db, [sender.id], reach?.activeWorkspaceId ?? null),
      pendingAccountLinkInviteeIdsForManagers(db, [sender.id]),
      coManagerInviterIdsForInvitee(db, sender.id),
      linkedVendorsForManagers(db, [sender.id]),
    ]);
    const coManagers = new Set<string>();
    if (coManagerIds.size > 0) {
      const { data: coProfiles } = await db.from("profiles").select("id, email").in("id", [...coManagerIds]);
      for (const row of coProfiles ?? []) {
        const email = String(row.email ?? "").trim().toLowerCase();
        if (email) coManagers.add(email);
      }
    }
    const keep = await Promise.all(
      recipients.map(async (recipient) => {
        if (recipient.userId && coManagerIds.has(recipient.userId)) return true;
        if (recipient.userId && pendingInviteeIds.has(recipient.userId)) return true;
        if (recipient.userId && inviterIdsForInvitee.has(recipient.userId)) return true;
        if (recipient.userId && linkedVendors.userIds.has(recipient.userId)) return true;
        const email = recipient.email.trim().toLowerCase();
        if (!email) return false;
        if (email === ADMIN_EMAIL) return true;
        if (coManagers.has(email)) return true;
        if (linkedVendors.emails.has(email)) return true;
        if (
          await managerHasAuthoritativeResidentLink(
            db as never,
            sender.id,
            { email, residentUserId: recipient.userId ?? undefined },
            reach,
          )
        ) {
          return true;
        }
        return managerConnectedToFunnelProspect(db, sender.id, { email, residentUserId: recipient.userId }, reach);
      }),
    );
    return enforceRecipientNamespace(db, sender.id, partition(recipients, keep));
  }

  // Vendor sender → may message the manager(s) who invited/own them plus their co-managers.
  if (isVendorRole(sender.role)) {
    const managerIds = await managerIdsOwningVendor(db, { userId: sender.id, email: senderEmail });
    const managerIdSet = new Set(managerIds);
    const coManagerEmails = await coManagerEmailsForManagers(db, managerIds);
    const coManagerIds = await accountLinkCoManagerIdsForManagers(db, managerIds);
    const { data } = managerIds.length > 0 ? await db.from("profiles").select("id, email").in("id", managerIds) : { data: [] };
    const allowedEmails = new Set((data ?? []).map((row) => String(row.email ?? "").trim().toLowerCase()).filter(Boolean));
    if (coManagerIds.size > 0) {
      const { data: coProfiles } = await db.from("profiles").select("id, email").in("id", [...coManagerIds]);
      for (const row of coProfiles ?? []) {
        const email = String(row.email ?? "").trim().toLowerCase();
        if (email) allowedEmails.add(email);
      }
    }
    const keep = recipients.map((recipient) => {
      const email = recipient.email.trim().toLowerCase();
      if (email === ADMIN_EMAIL) return true;
      if (email && allowedEmails.has(email)) return true;
      if (email && coManagerEmails.has(email)) return true;
      if (recipient.userId && managerIdSet.has(recipient.userId)) return true;
      if (recipient.userId && coManagerIds.has(recipient.userId)) return true;
      return false;
    });
    return enforceRecipientNamespace(db, sender.id, partition(recipients, keep));
  }

  // Resident (and any other non-staff) sender.
  const managerIds = await managerIdsConnectedToResident(db, { id: sender.id, email: senderEmail });
  const managerIdSet = new Set(managerIds);
  const allowedEmails = await coManagerEmailsForManagers(db, managerIds);
  // Same authoritative co-manager source as the manager/vendor branches.
  const coManagerIds = await accountLinkCoManagerIdsForManagers(db, managerIds);
  const housemateEmails = await housemateEmailsForResident(db, managerIds, senderEmail);
  const lookupIds = [...new Set([...managerIds, ...coManagerIds])];
  if (lookupIds.length > 0) {
    const { data } = await db.from("profiles").select("id, email").in("id", lookupIds);
    for (const row of data ?? []) {
      const email = String(row.email ?? "").trim().toLowerCase();
      if (email) allowedEmails.add(email);
    }
  }
  const keep = recipients.map((recipient) => {
    const email = recipient.email.trim().toLowerCase();
    if (email === ADMIN_EMAIL) return true;
    if (email && allowedEmails.has(email)) return true;
    if (recipient.userId && managerIdSet.has(recipient.userId)) return true;
    if (recipient.userId && coManagerIds.has(recipient.userId)) return true;
    return Boolean(email) && housemateEmails.has(email);
  });
  return enforceRecipientNamespace(db, sender.id, partition(recipients, keep));
}

/**
 * The individual contacts a sender may pick in the compose modal, scoped to their
 * role. Backs the eligible-contacts API so residents can select their own
 * manager(s) and managers can select their own residents/co-managers.
 */
export async function listEligibleInboxContacts(
  db: SupabaseClient,
  sender: InboxScopeSender,
): Promise<InboxScopedContact[]> {
  const senderEmail = sender.email.trim().toLowerCase();
  const out: InboxScopedContact[] = [];
  const seen = new Set<string>();

  const push = (contact: InboxScopedContact) => {
    const key = contact.email.trim().toLowerCase();
    if (!key || key === senderEmail || key === ADMIN_EMAIL || seen.has(key)) return;
    seen.add(key);
    out.push(contact);
  };

  if (isManagerRole(sender.role) || sender.isAdmin) {
    const { data: apps } = await db
      .from("manager_application_records")
      .select("id, resident_email, row_data")
      .eq("manager_user_id", sender.id);
    for (const row of apps ?? []) {
      const rowData = (row.row_data ?? {}) as Record<string, unknown>;
      const bucket = String(rowData.bucket ?? "").trim();
      if (bucket !== "approved" && bucket !== "pending") continue;
      if (bucket === "pending" && String(rowData.stage ?? "").trim().toLowerCase() === "in progress") {
        continue;
      }
      const email = String(row.resident_email ?? rowData.email ?? "").trim();
      if (!email) continue;
      push({
        id: `res-${row.id}`,
        name: String(rowData.name ?? rowData.residentName ?? "").trim() || email,
        email,
        role: "resident",
        propertyLabel: String(rowData.property ?? "").trim() || undefined,
        propertyId:
          String(rowData.assignedPropertyId ?? rowData.propertyId ?? "").trim() || undefined,
        tenancyStatus: bucket === "approved" ? "resident" : "applicant",
      });
    }
    await pushCoManagers(db, [sender.id], push);
    const { data: vendorRows } = await db
      .from("manager_vendor_records")
      .select("id, vendor_user_id, row_data")
      .eq("manager_user_id", sender.id);
    for (const row of vendorRows ?? []) {
      // Only a vendor who accepted (linked account) is reachable - the same rule
      // the send gate applies, so the picker never offers a person it refuses.
      if (!String((row as { vendor_user_id?: unknown }).vendor_user_id ?? "").trim()) continue;
      const rowData = (row.row_data ?? {}) as Record<string, unknown>;
      const name = String(rowData.name ?? "").trim();
      if (!name || name === "__vendor_category_settings__") continue;
      const email = String(rowData.email ?? "").trim();
      if (!email) continue;
      push({
        id: `ven-${row.id}`,
        name,
        email,
        role: "vendor",
      });
    }
    // Pre-application funnel: tour links + listing-lead inbox threads.
    try {
      const { data: tourLinks } = await db
        .from("resident_tour_links")
        .select("id, attendee_email, property_id")
        .eq("manager_user_id", sender.id);
      for (const row of tourLinks ?? []) {
        const email = String(row.attendee_email ?? "").trim();
        if (!email) continue;
        push({
          id: `tour-${row.id}`,
          name: email,
          email,
          role: "resident",
          propertyId: String(row.property_id ?? "").trim() || undefined,
          tenancyStatus: "applicant",
        });
      }
    } catch {
      /* ignore */
    }
    try {
      const { data: leadThreads } = await db
        .from("portal_inbox_thread_records")
        .select("id, participant_email, row_data")
        .eq("owner_user_id", sender.id);
      for (const row of leadThreads ?? []) {
        const email = String(row.participant_email ?? "").trim();
        if (!email) continue;
        const rowData = (row.row_data ?? {}) as Record<string, unknown>;
        if (!String(rowData.propertyId ?? "").trim()) continue;
        push({
          id: `lead-${row.id}`,
          name: String(rowData.from ?? "").trim() || email,
          email,
          role: "resident",
          propertyLabel: String(rowData.propertyTitle ?? "").trim() || undefined,
          propertyId: String(rowData.propertyId ?? "").trim() || undefined,
          tenancyStatus: "applicant",
        });
      }
    } catch {
      /* ignore */
    }
    return enforceContactNamespace(db, sender.id, out);
  }

  // Vendor sender → the manager(s) who invited/own them.
  if (isVendorRole(sender.role)) {
    const vendorManagerIds = await managerIdsOwningVendor(db, { userId: sender.id, email: senderEmail });
    if (vendorManagerIds.length > 0) {
      const { data: managers } = await db
        .from("profiles")
        .select("id, email, full_name")
        .in("id", vendorManagerIds);
      for (const row of managers ?? []) {
        const email = String(row.email ?? "").trim();
        if (!email) continue;
        push({
          id: `mgr-${row.id}`,
          userId: String(row.id),
          name: String(row.full_name ?? "").trim() || email,
          email,
          role: "manager",
        });
      }
    }
    return enforceContactNamespace(db, sender.id, out);
  }

  // Resident sender → their own manager(s) plus those managers' co-managers.
  const managerIds = await managerIdsConnectedToResident(db, { id: sender.id, email: senderEmail });
  if (managerIds.length > 0) {
    const { data: managers } = await db
      .from("profiles")
      .select("id, email, full_name")
      .in("id", managerIds);
    for (const row of managers ?? []) {
      const email = String(row.email ?? "").trim();
      if (!email) continue;
      push({
        id: `mgr-${row.id}`,
        name: String(row.full_name ?? "").trim() || email,
        email,
        role: "manager",
      });
    }
    await pushCoManagers(db, managerIds, push);
  }
  return enforceContactNamespace(db, sender.id, out);
}

async function pushCoManagers(
  db: SupabaseClient,
  managerIds: string[],
  push: (contact: InboxScopedContact) => void,
): Promise<void> {
  if (managerIds.length === 0) return;
  // Accepted account links, not the client-writable relationship mirror.
  const ids = await accountLinkCoManagerIdsForManagers(db, managerIds);
  if (ids.size === 0) return;
  const { data } = await db.from("profiles").select("id, email, full_name").in("id", [...ids]);
  for (const row of data ?? []) {
    const email = String(row.email ?? "").trim();
    if (!email) continue;
    push({
      id: `rel-${row.id}`,
      userId: String(row.id ?? "").trim() || undefined,
      name: String(row.full_name ?? "").trim() || email,
      email,
      role: "manager",
    });
  }
}
