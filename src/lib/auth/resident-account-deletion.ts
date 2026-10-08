import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ACCOUNT_PURGE_TABLES } from "@/lib/auth/account-purge-manifest";
import { deleteOwnPortalAccount, normalizedRolesForUser } from "@/lib/auth/delete-portal-account";
import { loadAccountCleanupRows } from "@/lib/auth/load-account-cleanup-rows";
import { PRIMARY_ADMIN_EMAIL } from "@/lib/auth/primary-admin";
import { ADMIN_INBOX_SCOPE } from "@/lib/portal-inbox-thread-scope";

/**
 * When a manager deletes a resident, does the resident's PropLane LOGIN go too?
 *
 * Captain, Oct 8: "If a resident is deleted they should no longer have an
 * account with PropLane." A manager must still never be able to destroy an
 * account that has a life outside their workspace, so the login is deleted only
 * when every condition below holds. All of it is re-derived here from the
 * database; nothing comes from the request body.
 *
 *   1. the account's only role is `resident` (`profile_roles` plus the legacy
 *      `profiles.role`) — never a login that is also manager/vendor/admin/owner;
 *   2. it is not the acting manager and not the workspace owner;
 *   3. its Auth email is the application's email (a profile contact field is not
 *      proof of which identity is being deleted);
 *   4. nothing links it to anyone ELSE once this manager's rows are gone: no
 *      application, lease, charge, rent profile, service, work order, autopay or
 *      ledger row stamped to another manager, no inbox conversation with another
 *      manager or workspace, no workspace or team membership.
 *
 * Any read that fails keeps the account: a guess never deletes a login.
 * The deletion itself is `deleteOwnPortalAccount` — the same purge the
 * self-delete path runs — so there is exactly one purge implementation.
 */

export type ResidentAccountStatus = "delete" | "keep" | "none";

export type ResidentAccountKeepReason =
  | "other_roles"
  | "other_relationships"
  | "is_actor"
  | "identity_mismatch"
  | "unreadable";

export type ResidentAccountDecision =
  | { status: "delete"; userId: string }
  | { status: "keep"; reason: ResidentAccountKeepReason; detail?: string }
  | { status: "none" };

export type ResidentAccountDecisionInput = {
  /** The signed-in caller. */
  actorUserId: string;
  /** The portfolio the rows are being removed from (the record's own stamp). */
  managerUserId: string;
  /** The application's resident email. */
  email: string;
  /** The login resolved from that email, or null when they never signed up. */
  residentUserId: string | null;
};

type Db = SupabaseClient;
type Row = Record<string, unknown>;

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** `ilike` treats these as wildcards; an address must match literally. */
function literalEmail(email: string): string {
  return email.replace(/[\\%_]/g, "\\$&");
}

async function authEmail(db: Db, userId: string): Promise<string> {
  const { data, error } = await db.auth.admin.getUserById(userId);
  if (error || !data?.user) return "";
  return normalizeEmail(data.user.email);
}

/** Workspaces the manager owns: a resident-side conversation points at one of them. */
async function managerWorkspaceIds(db: Db, managerUserId: string): Promise<Set<string>> {
  const { data, error } = await db.from("portal_workspaces").select("id").eq("owner_user_id", managerUserId).range(0, 999);
  if (error) throw new Error(error.message);
  return new Set((data ?? []).map((row) => String((row as Row).id ?? "")).filter(Boolean));
}

type ThreadRow = {
  id: string;
  scope?: string | null;
  workspace_id?: string | null;
  conversation_key?: string | null;
  row_data?: { email?: unknown } | null;
};

/**
 * Does this resident-owned conversation belong to the deleting manager's
 * workspace? By the row's workspace id or its `ws:<workspace>` conversation
 * key; a row from before conversations were keyed (neither set) is matched by
 * the manager's own address, the only manager reference it carries.
 */
function threadBelongsToManager(row: ThreadRow, workspaceIds: ReadonlySet<string>, managerEmail: string): boolean {
  const workspaceId = String(row.workspace_id ?? "").trim();
  if (workspaceId && workspaceIds.has(workspaceId)) return true;
  const key = String(row.conversation_key ?? "").trim();
  if (key.startsWith("ws:") && workspaceIds.has(key.slice(3))) return true;
  if (!workspaceId && !key && managerEmail) return normalizeEmail(row.row_data?.email) === managerEmail;
  return false;
}

function threadIsWithSupport(row: ThreadRow): boolean {
  return normalizeEmail(row.row_data?.email) === PRIMARY_ADMIN_EMAIL.trim().toLowerCase();
}

async function loadResidentOwnedThreads(db: Db, residentUserId: string): Promise<ThreadRow[]> {
  return loadAccountCleanupRows<ThreadRow>((from, to) =>
    db
      .from("portal_inbox_thread_records")
      .select("id,scope,workspace_id,conversation_key,row_data")
      .eq("owner_user_id", residentUserId)
      .neq("scope", ADMIN_INBOX_SCOPE)
      .order("id")
      .range(from, to),
  );
}

/**
 * The resident's OWN inbox rows (they own them; the manager's RPC can only
 * delete rows the manager owns) that belong to this manager's workspace. Their
 * ids, found by workspace / conversation key — never by message text.
 */
export async function findResidentOwnedWorkspaceThreadIds(
  db: Db,
  input: { managerUserId: string; residentUserId: string | null },
): Promise<string[]> {
  const residentUserId = (input.residentUserId ?? "").trim();
  const managerUserId = input.managerUserId.trim();
  if (!residentUserId || !managerUserId || residentUserId === managerUserId) return [];
  const [workspaceIds, managerEmail, threads] = await Promise.all([
    managerWorkspaceIds(db, managerUserId),
    authEmail(db, managerUserId),
    loadResidentOwnedThreads(db, residentUserId),
  ]);
  return threads.filter((row) => threadBelongsToManager(row, workspaceIds, managerEmail)).map((row) => row.id);
}

/** Delete those rows. Pinned to the resident's own ownership so an id can never reach anyone else's. */
export async function removeResidentOwnedWorkspaceThreads(
  db: Db,
  input: { managerUserId: string; residentUserId: string | null },
): Promise<number> {
  const ids = await findResidentOwnedWorkspaceThreadIds(db, input);
  const residentUserId = (input.residentUserId ?? "").trim();
  if (ids.length === 0 || !residentUserId) return 0;
  let removed = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const { data, error } = await db
      .from("portal_inbox_thread_records")
      .delete()
      .eq("owner_user_id", residentUserId)
      .in("id", batch)
      .select("id");
    if (error) throw new Error(`Could not remove the resident's conversations: ${error.message}`);
    removed += (data ?? []).length || 0;
  }
  return removed;
}

/**
 * Every manifest table that stamps a manager on a row that also names the
 * resident (by login id or email): the resident's relationships with a manager.
 * Derived from the purge manifest so a table added there is checked here too.
 * Inbox rows are judged separately (their owner is the resident, not a manager).
 */
type RelationshipSource = {
  table: string;
  managerColumn: string;
  idColumns: string[];
  emailColumns: string[];
};

const EXTRA_RELATIONSHIP_SOURCES: RelationshipSource[] = [
  // Money rows the manager keeps: a ledger line or deposit names the resident.
  { table: "ledger_entries", managerColumn: "manager_user_id", idColumns: ["resident_user_id"], emailColumns: ["resident_email"] },
  { table: "security_deposit_ledger", managerColumn: "manager_user_id", idColumns: ["resident_user_id"], emailColumns: ["resident_email"] },
];

export function residentRelationshipSources(): RelationshipSource[] {
  const out = new Map<string, RelationshipSource>();
  for (const rule of ACCOUNT_PURGE_TABLES) {
    if (rule.table === "portal_inbox_thread_records") continue;
    const managerColumn = rule.manager?.ids?.[0];
    const idColumns = [...(rule.resident?.ids ?? [])];
    const emailColumns = [...(rule.resident?.emails ?? [])];
    if (!managerColumn || (idColumns.length === 0 && emailColumns.length === 0)) continue;
    // A column that is both the manager stamp and the resident key names the same person twice.
    out.set(rule.table, {
      table: rule.table,
      managerColumn,
      idColumns: idColumns.filter((column) => column !== managerColumn),
      emailColumns,
    });
  }
  for (const extra of EXTRA_RELATIONSHIP_SOURCES) if (!out.has(extra.table)) out.set(extra.table, extra);
  return [...out.values()];
}

async function anyRow(
  query: PromiseLike<{ data: unknown[] | null; error: { code?: string; message: string } | null }>,
): Promise<boolean> {
  const { data, error } = await query;
  // A table this environment never migrated holds no rows (the purge treats it the same way).
  if (error?.code === "42P01" || error?.code === "PGRST205") return false;
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

/** Name of the first relationship that survives this manager's removal, or null. */
async function findOtherRelationship(
  db: Db,
  input: { managerUserId: string; residentUserId: string; email: string },
): Promise<string | null> {
  const { managerUserId, residentUserId, email } = input;
  const checks: { label: string; run: () => Promise<boolean> }[] = [];

  for (const source of residentRelationshipSources()) {
    // Rows stamped to a manager other than this one (and not to the resident themself).
    const otherManager = () =>
      db.from(source.table).select(source.managerColumn).neq(source.managerColumn, managerUserId).neq(source.managerColumn, residentUserId);
    for (const column of source.idColumns) {
      checks.push({ label: source.table, run: () => anyRow(otherManager().eq(column, residentUserId).range(0, 0) as never) });
    }
    for (const column of source.emailColumns) {
      checks.push({ label: source.table, run: () => anyRow(otherManager().ilike(column, literalEmail(email)).range(0, 0) as never) });
    }
  }

  // Team and workspace membership, either direction; a workspace they own.
  for (const column of ["inviter_user_id", "invitee_user_id"] as const) {
    checks.push({
      label: "account_link_invites",
      run: () => anyRow(db.from("account_link_invites").select("id").eq(column, residentUserId).range(0, 0) as never),
    });
  }
  checks.push({
    label: "portal_workspaces",
    run: () => anyRow(db.from("portal_workspaces").select("id").eq("owner_user_id", residentUserId).range(0, 0) as never),
  });
  checks.push({
    label: "manager_vendor_records",
    run: () => anyRow(db.from("manager_vendor_records").select("id").eq("vendor_user_id", residentUserId).range(0, 0) as never),
  });
  // Another manager's conversation with them (they own none of it; a manager does).
  checks.push({
    label: "portal_inbox_thread_records",
    run: () =>
      anyRow(
        db
          .from("portal_inbox_thread_records")
          .select("id")
          .ilike("participant_email", literalEmail(email))
          .neq("owner_user_id", managerUserId)
          .neq("owner_user_id", residentUserId)
          .neq("scope", ADMIN_INBOX_SCOPE)
          .range(0, 0) as never,
      ),
  });

  for (let i = 0; i < checks.length; i += 8) {
    const batch = checks.slice(i, i + 8);
    const results = await Promise.all(batch.map((check) => check.run()));
    const hit = results.findIndex(Boolean);
    if (hit >= 0) return batch[hit]!.label;
  }

  // The resident's own conversations: any that is not this manager's workspace
  // (and not the PropLane support thread) is a relationship with someone else.
  const [workspaceIds, managerEmail, threads] = await Promise.all([
    managerWorkspaceIds(db, managerUserId),
    authEmail(db, managerUserId),
    loadResidentOwnedThreads(db, residentUserId),
  ]);
  const foreign = threads.find((row) => !threadBelongsToManager(row, workspaceIds, managerEmail) && !threadIsWithSupport(row));
  return foreign ? "portal_inbox_thread_records" : null;
}

/**
 * The one eligibility rule. Run it AFTER this manager's rows are removed (the
 * delete) or before (the preview) — it only looks at what is not theirs, so the
 * answer is the same either way.
 */
export async function decideResidentAccountFate(
  db: Db,
  input: ResidentAccountDecisionInput,
): Promise<ResidentAccountDecision> {
  const residentUserId = (input.residentUserId ?? "").trim();
  const email = normalizeEmail(input.email);
  if (!residentUserId) return { status: "none" };
  if (residentUserId === input.actorUserId.trim() || residentUserId === input.managerUserId.trim()) {
    return { status: "keep", reason: "is_actor" };
  }
  try {
    if (!email || (await authEmail(db, residentUserId)) !== email) {
      return { status: "keep", reason: "identity_mismatch" };
    }
    const roles = await normalizedRolesForUser(db, residentUserId);
    if (roles.length === 0 || roles.some((role) => role !== "resident")) {
      return { status: "keep", reason: "other_roles" };
    }
    const relationship = await findOtherRelationship(db, {
      managerUserId: input.managerUserId.trim(),
      residentUserId,
      email,
    });
    if (relationship) return { status: "keep", reason: "other_relationships", detail: relationship };
    return { status: "delete", userId: residentUserId };
  } catch (error) {
    return { status: "keep", reason: "unreadable", detail: error instanceof Error ? error.message : String(error) };
  }
}

export type ResidentAccountOutcome = "deleted" | "kept" | "none" | "failed";

/**
 * Carry the decision out: the same full purge + Auth deletion the self-delete
 * path runs (`deleteOwnPortalAccount` -> `deleteOwnAccount`: Stripe and PropLane
 * Number cancel, every manifest table, the Auth user), so the email is reusable.
 * A failure is reported, never thrown: the manager's rows are already gone.
 */
export async function applyResidentAccountDecision(
  db: Db,
  decision: ResidentAccountDecision,
): Promise<{ outcome: ResidentAccountOutcome; error?: string }> {
  if (decision.status === "none") return { outcome: "none" };
  if (decision.status === "keep") return { outcome: "kept" };
  try {
    await deleteOwnPortalAccount(db as never, decision.userId, "resident");
    return { outcome: "deleted" };
  } catch (error) {
    return { outcome: "failed", error: error instanceof Error ? error.message : "Could not delete the PropLane account." };
  }
}
