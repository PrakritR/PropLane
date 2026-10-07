import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { TEAM_ROLE_LABELS, type TeamRoleId } from "@/lib/co-manager-team-roles";
import {
  payeeFromRow,
  UUID_RE,
  validatePayeeInput,
  type ManagerPayee,
  type ManagerTeammate,
  type PayeeInput,
} from "@/lib/manager-payees";
import { withoutOwnerLinks } from "@/lib/co-manager-team-roles";

/**
 * Server side of saved payees. Every function takes the authenticated manager's id (re-derived by
 * the route from the session, never from the body) and pins each read and write to it, so an id
 * from another manager's account reads as "not found". The service-role client bypasses RLS, so
 * these predicates ARE the access control.
 */

export type PayeeResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

const NOT_FOUND = { ok: false, status: 404, error: "Payee not found." } as const;

type Db = Pick<SupabaseClient, "from">;

export async function listPayees(db: Db, managerUserId: string): Promise<ManagerPayee[]> {
  const { data, error } = await db
    .from("manager_payees")
    .select("*")
    .eq("manager_user_id", managerUserId)
    .is("archived_at", null)
    .order("name", { ascending: true })
    .limit(500);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => payeeFromRow(row as Record<string, unknown>));
}

/** A live payee this manager owns, or null: foreign, archived and missing ids are indistinguishable. */
export async function findOwnedPayee(db: Db, managerUserId: string, payeeId: string): Promise<ManagerPayee | null> {
  const id = payeeId.trim();
  if (!id) return null;
  // A malformed id is "not found", not a 500: `.eq("id", "abc")` against a uuid column makes
  // Postgres refuse the cast, and the route's catch then echoed its message to the client.
  if (!UUID_RE.test(id)) return null;
  const { data, error } = await db
    .from("manager_payees")
    .select("*")
    .eq("id", id)
    .eq("manager_user_id", managerUserId)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? payeeFromRow(data as Record<string, unknown>) : null;
}

/**
 * Teammates are re-derived from accepted account links: the other side of a link this manager sits
 * on, in either direction. A user id from the client is only ever matched against this set.
 */
export async function listTeammates(db: Db, managerUserId: string): Promise<ManagerTeammate[]> {
  const rows: Array<{ user: string; role: string | null; fallbackName: string | null }> = [];
  const asInviter = withoutOwnerLinks(await db
    .from("account_link_invites")
    .select("invitee_user_id, invitee_display_name, team_role")
    .eq("inviter_user_id", managerUserId)
    .eq("status", "accepted"));
  if (asInviter.error) throw new Error(asInviter.error.message);
  for (const row of asInviter.data ?? []) {
    const user = String((row as Record<string, unknown>).invitee_user_id ?? "").trim();
    if (user) rows.push({ user, role: textOrNull((row as Record<string, unknown>).team_role), fallbackName: textOrNull((row as Record<string, unknown>).invitee_display_name) });
  }
  const asInvitee = withoutOwnerLinks(await db
    .from("account_link_invites")
    .select("inviter_user_id, inviter_display_name, team_role")
    .eq("invitee_user_id", managerUserId)
    .eq("status", "accepted"));
  if (asInvitee.error) throw new Error(asInvitee.error.message);
  for (const row of asInvitee.data ?? []) {
    const user = String((row as Record<string, unknown>).inviter_user_id ?? "").trim();
    if (user) rows.push({ user, role: textOrNull((row as Record<string, unknown>).team_role), fallbackName: textOrNull((row as Record<string, unknown>).inviter_display_name) });
  }
  const ids = [...new Set(rows.map((row) => row.user))].filter((id) => id !== managerUserId);
  if (ids.length === 0) return [];

  const profileById = new Map<string, { name: string | null; email: string | null }>();
  const { data: profiles, error: profileError } = await db
    .from("profiles")
    .select("id, full_name, email")
    .in("id", ids);
  // Its two sibling reads above throw; a silent failure here named every teammate "Teammate"
  // in the Add payment picker, so the manager would pick a payee by a placeholder.
  if (profileError) throw new Error(profileError.message);
  for (const profile of profiles ?? []) {
    const p = profile as Record<string, unknown>;
    profileById.set(String(p.id), { name: textOrNull(p.full_name), email: textOrNull(p.email) });
  }
  return ids.map((userId) => {
    const link = rows.find((row) => row.user === userId)!;
    const profile = profileById.get(userId);
    const role = link.role && link.role in TEAM_ROLE_LABELS ? TEAM_ROLE_LABELS[link.role as TeamRoleId] : null;
    return {
      userId,
      name: profile?.name || link.fallbackName || profile?.email || "Teammate",
      email: profile?.email ?? null,
      roleLabel: role,
    };
  });
}

export async function teammateIsOnTeam(db: Db, managerUserId: string, userId: string): Promise<ManagerTeammate | null> {
  const team = await listTeammates(db, managerUserId);
  return team.find((member) => member.userId === userId) ?? null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function ownsVendorRecord(db: Db, managerUserId: string, vendorId: string): Promise<boolean> {
  const { data } = await db
    .from("manager_vendor_records")
    .select("id")
    .eq("id", vendorId)
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  return Boolean(data);
}

export async function createPayee(db: Db, managerUserId: string, input: PayeeInput): Promise<PayeeResult<ManagerPayee>> {
  const checked = validatePayeeInput(input, { partial: false });
  if (!checked.ok) return { ok: false, status: 400, error: checked.error };
  const value = { ...checked.value };

  if (value.kind === "teammate") {
    const teammate = await teammateIsOnTeam(db, managerUserId, value.teammate_user_id!);
    if (!teammate) return { ok: false, status: 404, error: "Teammate not found." };
    // The name and login link come from the team, never from the request.
    value.name = teammate.name;
    value.email = value.email ?? teammate.email;
    value.vendor_directory_id = null;
  } else if (value.kind === "vendor") {
    if (!(await ownsVendorRecord(db, managerUserId, value.vendor_directory_id!))) {
      return { ok: false, status: 404, error: "Vendor not found." };
    }
    value.teammate_user_id = null;
  } else {
    value.teammate_user_id = null;
    value.vendor_directory_id = null;
  }

  const now = new Date().toISOString();
  const { data, error } = await db
    .from("manager_payees")
    .insert({ ...value, manager_user_id: managerUserId, created_at: now, updated_at: now })
    .select("*")
    .single();
  if (error || !data) return { ok: false, status: 500, error: error?.message ?? "Could not save payee." };
  return { ok: true, value: payeeFromRow(data as Record<string, unknown>) };
}

/** Update the editable detail fields. Kind and the teammate / vendor links never change after create. */
export async function updatePayee(
  db: Db,
  managerUserId: string,
  payeeId: string,
  input: PayeeInput,
): Promise<PayeeResult<ManagerPayee>> {
  const existing = await findOwnedPayee(db, managerUserId, payeeId);
  if (!existing) return NOT_FOUND;
  const checked = validatePayeeInput({ ...input, kind: undefined, teammateUserId: undefined, vendorDirectoryId: undefined }, { partial: true });
  if (!checked.ok) return { ok: false, status: 400, error: checked.error };
  const patch = { ...checked.value };
  // A teammate's name belongs to their profile, not to this address book.
  if (existing.kind === "teammate") delete patch.name;
  if (existing.kind === "other" && patch.payee_type === null) return { ok: false, status: 400, error: "Choose a payee type." };
  const { data, error } = await db
    .from("manager_payees")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", existing.id)
    .eq("manager_user_id", managerUserId)
    .select("*")
    .single();
  if (error || !data) return { ok: false, status: 500, error: error?.message ?? "Could not update payee." };
  return { ok: true, value: payeeFromRow(data as Record<string, unknown>) };
}

export async function archivePayee(db: Db, managerUserId: string, payeeId: string): Promise<PayeeResult<{ id: string }>> {
  const existing = await findOwnedPayee(db, managerUserId, payeeId);
  if (!existing) return NOT_FOUND;
  const now = new Date().toISOString();
  const { error } = await db
    .from("manager_payees")
    .update({ archived_at: now, updated_at: now })
    .eq("id", existing.id)
    .eq("manager_user_id", managerUserId)
    .select("id")
    .single();
  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true, value: { id: existing.id } };
}
