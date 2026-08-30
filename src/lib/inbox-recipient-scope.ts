import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { InboxScopedContact } from "@/data/inbox-scoped-directory";
import { PRIMARY_ADMIN_EMAIL } from "@/lib/auth/primary-admin";
import { managerOwnsResident } from "@/lib/auth/resident-relationship";
import { managerIdsOwningResident } from "@/lib/resident-manager-scope";

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
 *    listing(s)/lease(s), plus those managers' linked co-managers, plus Axis
 *    admin ops. Never other residents, never arbitrary managers.
 *  - Manager sender   → may message ONLY the residents on their own properties,
 *    plus their own linked co-managers, plus Axis admin ops. Never arbitrary
 *    residents, never unlinked managers.
 *  - Admin sender     → unrestricted (unchanged).
 */

const ADMIN_EMAIL = PRIMARY_ADMIN_EMAIL.trim().toLowerCase();

export type InboxScopeSender = {
  id: string;
  email: string;
  role: string | null;
  isAdmin: boolean;
};

export type InboxScopeRecipient = { email: string; userId: string | null };

function isManagerRole(role: string | null): boolean {
  const r = String(role ?? "").trim().toLowerCase();
  return r === "manager" || r === "owner" || r === "pro";
}

/** Emails of co-managers linked to any of the given manager ids (via pro relationships). */
async function coManagerEmailsForManagers(
  db: SupabaseClient,
  managerIds: string[],
): Promise<Set<string>> {
  const emails = new Set<string>();
  if (managerIds.length === 0) return emails;
  const { data } = await db
    .from("portal_pro_relationship_records")
    .select("related_email")
    .in("manager_user_id", managerIds);
  for (const row of data ?? []) {
    const email = String(row.related_email ?? "").trim().toLowerCase();
    if (email) emails.add(email);
  }
  return emails;
}

/** Co-manager auth user ids linked to any of the given manager ids (account links). */
async function accountLinkCoManagerIdsForManagers(
  db: SupabaseClient,
  managerIds: string[],
): Promise<Set<string>> {
  const ids = new Set<string>();
  if (managerIds.length === 0) return ids;
  try {
    const { data } = await db
      .from("account_link_invites")
      .select("invitee_user_id")
      .eq("status", "accepted")
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

/** Emails of vendors in the given managers' own vendor directory. */
async function vendorEmailsForManagers(
  db: SupabaseClient,
  managerIds: string[],
): Promise<Set<string>> {
  const emails = new Set<string>();
  if (managerIds.length === 0) return emails;
  const { data } = await db
    .from("manager_vendor_records")
    .select("row_data")
    .in("manager_user_id", managerIds);
  for (const row of data ?? []) {
    const rowData = (row.row_data ?? {}) as Record<string, unknown>;
    const email = String(rowData.email ?? "").trim().toLowerCase();
    if (email) emails.add(email);
  }
  return emails;
}

/** Manager user ids that invited/own the given vendor (by linked auth user or directory email). */
export async function managerIdsOwningVendor(
  db: SupabaseClient,
  vendor: { userId: string; email: string },
): Promise<string[]> {
  const email = vendor.email.trim().toLowerCase();
  const ids = new Set<string>();
  const filter = email
    ? `vendor_user_id.eq.${vendor.userId},row_data->>email.eq.${email}`
    : `vendor_user_id.eq.${vendor.userId}`;
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
    const coManagers = await coManagerEmailsForManagers(db, [sender.id]);
    // `portal_pro_relationship_records` is a client-writable mirror, so the
    // authoritative accepted account_link_invites are resolved too — the same
    // source the vendor and resident branches use.
    const coManagerIds = await accountLinkCoManagerIdsForManagers(db, [sender.id]);
    const pendingInviteeIds = await pendingAccountLinkInviteeIdsForManagers(db, [sender.id]);
    if (coManagerIds.size > 0) {
      const { data: coProfiles } = await db.from("profiles").select("id, email").in("id", [...coManagerIds]);
      for (const row of coProfiles ?? []) {
        const email = String(row.email ?? "").trim().toLowerCase();
        if (email) coManagers.add(email);
      }
    }
    const vendors = await vendorEmailsForManagers(db, [sender.id]);
    const keep = await Promise.all(
      recipients.map(async (recipient) => {
        if (recipient.userId && coManagerIds.has(recipient.userId)) return true;
        if (recipient.userId && pendingInviteeIds.has(recipient.userId)) return true;
        const email = recipient.email.trim().toLowerCase();
        if (!email) return false;
        if (email === ADMIN_EMAIL) return true;
        if (coManagers.has(email)) return true;
        if (vendors.has(email)) return true;
        return managerOwnsResident(db, sender.id, {
          email,
          residentUserId: recipient.userId ?? undefined,
        });
      }),
    );
    return partition(recipients, keep);
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
    return partition(recipients, keep);
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
  return partition(recipients, keep);
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
      .select("id, row_data")
      .eq("manager_user_id", sender.id);
    for (const row of vendorRows ?? []) {
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
    return out;
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
          name: String(row.full_name ?? "").trim() || email,
          email,
          role: "manager",
        });
      }
    }
    return out;
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
  return out;
}

async function pushCoManagers(
  db: SupabaseClient,
  managerIds: string[],
  push: (contact: InboxScopedContact) => void,
): Promise<void> {
  if (managerIds.length === 0) return;
  const { data } = await db
    .from("portal_pro_relationship_records")
    .select("id, related_user_id, related_email, row_data")
    .in("manager_user_id", managerIds);
  for (const row of data ?? []) {
    const email = String(row.related_email ?? "").trim();
    if (!email) continue;
    const rowData = (row.row_data ?? {}) as Record<string, unknown>;
    const name =
      String(rowData.linkedDisplayName ?? rowData.displayName ?? rowData.name ?? "").trim() || email;
    push({
      id: `rel-${row.id}`,
      name,
      email,
      role: "manager",
    });
  }
}
