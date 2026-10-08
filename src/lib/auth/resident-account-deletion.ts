import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ACCOUNT_PURGE_TABLES } from "@/lib/auth/account-purge-manifest";
import { deleteOwnPortalAccount, normalizedRolesForUser } from "@/lib/auth/delete-portal-account";
import { loadAccountCleanupRows } from "@/lib/auth/load-account-cleanup-rows";
import { PRIMARY_ADMIN_EMAIL } from "@/lib/auth/primary-admin";
import { residentBoundToManager } from "@/lib/auth/resident-workspace-binding";
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
 *   2. it is not the acting manager and not the workspace owner, and the actor
 *      IS the workspace owner (or an admin): a co-manager's delete keeps the login;
 *   3. its Auth email is the application's email (a profile contact field is not
 *      proof of which identity is being deleted), AND the account's own owner
 *      bound it to THIS manager: a `resident_workspace_bindings` row, written
 *      only by the resident's own authenticated application submit. The email
 *      on an application is typed by the manager, so email equality alone would
 *      let a manager delete anyone's login by adding an application for them;
 *   4. nothing links it to anyone ELSE once this manager's rows are gone: no
 *      application, lease, charge, rent profile, service, work order, autopay or
 *      ledger row stamped to another manager (or stamped to nobody), no inbox
 *      conversation with another manager or workspace, no workspace or team
 *      membership, and nothing the resident holds with PropLane itself: a
 *      PropLane Number subscription or credit balance, an agent number, a link to
 *      another person's application, or any row in a resident-keyed manifest
 *      table that has no manager column.
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
  | "not_owner"
  | "identity_mismatch"
  | "unverified_link"
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
  /** Only the workspace owner (or an admin) may delete the login; a co-manager's delete keeps it. */
  actorIsAdmin?: boolean;
  /** The application being removed: its own rows (which go with it) are not "someone else's". */
  applicationId?: string;
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

/**
 * Every manifest table that stamps a manager on a row that also names the
 * resident (by login id or email): the resident's relationships with a manager.
 * Derived from the purge manifest so a table added there is checked here too.
 * Inbox rows are judged separately (their owner is the resident, not a manager).
 *
 * `managerColumns[0]` is the table's manager stamp: a row where it is NULL is
 * unattributed, so nobody's removal accounts for it and it counts. Any manager
 * column naming someone other than this manager or the resident counts too.
 * `strict` sources are ones this check depends on: a table that cannot be read
 * (including one this environment never migrated) keeps the account. The rest
 * are manifest-derived; a missing one holds no rows, the way the purge sees it.
 */
type RelationshipSource = {
  table: string;
  managerColumns: string[];
  idColumns: string[];
  emailColumns: string[];
  strict?: boolean;
};

const EXTRA_RELATIONSHIP_SOURCES: RelationshipSource[] = [
  // Money rows the manager keeps: a ledger line or deposit names the resident.
  { table: "ledger_entries", managerColumns: ["manager_user_id"], idColumns: ["resident_user_id"], emailColumns: ["resident_email"], strict: true },
  { table: "security_deposit_ledger", managerColumns: ["manager_user_id"], idColumns: ["resident_user_id"], emailColumns: ["resident_email"], strict: true },
];

export function residentRelationshipSources(): RelationshipSource[] {
  const out = new Map<string, RelationshipSource>();
  for (const rule of ACCOUNT_PURGE_TABLES) {
    if (rule.table === "portal_inbox_thread_records") continue;
    const residentIds = rule.resident?.ids ?? [];
    // A column that is both a manager stamp and a resident key names the resident, not a manager.
    const managerColumns = (rule.manager?.ids ?? []).filter((column) => !residentIds.includes(column));
    if (managerColumns.length === 0) continue;
    const idColumns = residentIds.filter((column) => !(rule.manager?.ids ?? []).includes(column));
    const emailColumns = [...(rule.resident?.emails ?? [])];
    if (idColumns.length === 0 && emailColumns.length === 0) continue;
    out.set(rule.table, { table: rule.table, managerColumns, idColumns, emailColumns });
  }
  for (const extra of EXTRA_RELATIONSHIP_SOURCES) if (!out.has(extra.table)) out.set(extra.table, extra);
  return [...out.values()];
}

/**
 * Manifest tables keyed to the resident (or any user) with NO manager column: what
 * the resident holds with PropLane directly, which no manager's delete removes.
 * Any row keeps the login, so a table added to the manifest is covered here
 * without an edit. `RELATIONSHIP_HANDLED_ELSEWHERE` lists the ones with their own
 * rule (status / balance / which application) and the history tables the
 * balance already summarizes.
 */
const RELATIONSHIP_HANDLED_ELSEWHERE: ReadonlySet<string> = new Set([
  "number_subscriptions", // keeps unless canceled/ended
  "number_credit_accounts", // keeps with a nonzero balance
  "resident_account_links", // keeps when it names a person on someone else's application
  // History of the credit balance and subscription above; the account row decides.
  "number_credit_usage_events",
  "number_credit_purchases",
  "number_credit_adjustments",
]);

export function residentDirectRelationshipSources(): { table: string; idColumns: string[]; emailColumns: string[] }[] {
  const out: { table: string; idColumns: string[]; emailColumns: string[] }[] = [];
  for (const rule of ACCOUNT_PURGE_TABLES) {
    if (rule.manager || RELATIONSHIP_HANDLED_ELSEWHERE.has(rule.table)) continue;
    const idColumns = [...(rule.resident?.ids ?? [])];
    const emailColumns = [...(rule.resident?.emails ?? [])];
    if (idColumns.length === 0 && emailColumns.length === 0) continue;
    out.push({ table: rule.table, idColumns, emailColumns });
  }
  return out;
}

type RowsResult = { data: unknown[] | null; error: { code?: string; message: string } | null };

function isMissingTable(error: { code?: string } | null): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205";
}

/**
 * Does the query return a row? A missing table throws when `strict` (the check
 * cannot see it, so the account is kept) and holds no rows otherwise.
 */
async function anyRow(query: PromiseLike<RowsResult>, strict = false): Promise<boolean> {
  const { data, error } = await query;
  if (isMissingTable(error)) {
    if (strict) throw new Error(`Relationship table is unavailable: ${error?.message ?? "missing table"}`);
    return false;
  }
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

/** Ids go into a PostgREST `or()` expression; refuse anything that could add a clause. */
function filterSafeId(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Unexpected id shape.");
  return value;
}

/**
 * Is this resident linked, as applicant or helper, to a person on an application
 * that is not this manager's? Links on the application being removed cascade away
 * with it, so they do not count.
 */
async function linkedToAnotherApplication(
  db: Db,
  input: { managerUserId: string; residentUserId: string; applicationId?: string },
): Promise<boolean> {
  const applicationIds = new Set<string>();
  for (const column of ["applicant_user_id", "helper_user_id"] as const) {
    const { data, error } = await db
      .from("resident_account_links")
      .select("application_id")
      .eq(column, input.residentUserId)
      .range(0, 199);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as Row[]) {
      const id = String(row.application_id ?? "").trim();
      if (id && id !== input.applicationId) applicationIds.add(id);
    }
  }
  if (applicationIds.size === 0) return false;
  const { data, error } = await db.from("manager_application_records").select("id,manager_user_id").in("id", [...applicationIds]);
  if (error) throw new Error(error.message);
  // A link whose application is gone cascades away; one stamped to anyone but this manager is theirs.
  return ((data ?? []) as Row[]).some((row) => String(row.manager_user_id ?? "").trim() !== input.managerUserId);
}

/** Name of the first relationship that survives this manager's removal, or null. */
async function findOtherRelationship(
  db: Db,
  input: { managerUserId: string; residentUserId: string; email: string; applicationId?: string },
): Promise<string | null> {
  const { managerUserId, residentUserId, email, applicationId } = input;
  const manager = filterSafeId(managerUserId);
  const resident = filterSafeId(residentUserId);
  const checks: { label: string; run: () => Promise<boolean> }[] = [];

  for (const source of residentRelationshipSources()) {
    const [stamp, ...secondary] = source.managerColumns;
    const strict = source.strict === true;
    // Rows unattributed (stamp NULL) or stamped to a manager other than this one (and not the resident).
    const unattributedOrOther = () => {
      let query = db
        .from(source.table)
        .select(stamp!)
        .or(`${stamp}.is.null,and(${stamp}.neq.${manager},${stamp}.neq.${resident})`);
      // The row being removed is this manager's even if its stamp was never written.
      if (source.table === "manager_application_records" && applicationId) query = query.neq("id", applicationId);
      return query;
    };
    const secondaryOther = (column: string) => db.from(source.table).select(column).neq(column, manager).neq(column, resident);
    for (const column of source.idColumns) {
      checks.push({ label: source.table, run: () => anyRow(unattributedOrOther().eq(column, residentUserId).range(0, 0) as never, strict) });
      for (const other of secondary) {
        checks.push({ label: source.table, run: () => anyRow(secondaryOther(other).eq(column, residentUserId).range(0, 0) as never, strict) });
      }
    }
    for (const column of source.emailColumns) {
      checks.push({ label: source.table, run: () => anyRow(unattributedOrOther().ilike(column, literalEmail(email)).range(0, 0) as never, strict) });
      for (const other of secondary) {
        checks.push({ label: source.table, run: () => anyRow(secondaryOther(other).ilike(column, literalEmail(email)).range(0, 0) as never, strict) });
      }
    }
  }

  // What the resident holds with PropLane itself (no manager column to scope by).
  for (const source of residentDirectRelationshipSources()) {
    for (const column of source.idColumns) {
      checks.push({
        label: source.table,
        run: () => anyRow(db.from(source.table).select(column).eq(column, residentUserId).range(0, 0) as never),
      });
    }
    for (const column of source.emailColumns) {
      checks.push({
        label: source.table,
        run: () => anyRow(db.from(source.table).select(column).ilike(column, literalEmail(email)).range(0, 0) as never),
      });
    }
  }
  // PropLane Number: a live subscription (anything but canceled/ended), or credit left either way.
  checks.push({
    label: "number_subscriptions",
    run: () =>
      anyRow(
        db.from("number_subscriptions").select("owner_user_id").eq("owner_user_id", residentUserId).not("status", "in", "(canceled,ended)").range(0, 0) as never,
        true,
      ),
  });
  checks.push({
    label: "number_credit_accounts",
    run: () =>
      anyRow(
        db
          .from("number_credit_accounts")
          .select("owner_user_id")
          .eq("owner_user_id", residentUserId)
          .or("included_remaining_cents.neq.0,purchased_credit_cents.neq.0")
          .range(0, 0) as never,
        true,
      ),
  });
  checks.push({
    label: "resident_agent_numbers",
    run: () => anyRow(db.from("resident_agent_numbers").select("resident_user_id").eq("resident_user_id", residentUserId).range(0, 0) as never, true),
  });
  checks.push({
    label: "resident_account_links",
    run: () => linkedToAnotherApplication(db, { managerUserId: manager, residentUserId: resident, applicationId }),
  });

  // Team and workspace membership, either direction; a workspace they own.
  for (const column of ["inviter_user_id", "invitee_user_id"] as const) {
    checks.push({
      label: "account_link_invites",
      run: () => anyRow(db.from("account_link_invites").select("id").eq(column, residentUserId).range(0, 0) as never, true),
    });
  }
  checks.push({
    label: "portal_workspaces",
    run: () => anyRow(db.from("portal_workspaces").select("id").eq("owner_user_id", residentUserId).range(0, 0) as never, true),
  });
  checks.push({
    label: "manager_vendor_records",
    run: () => anyRow(db.from("manager_vendor_records").select("id").eq("vendor_user_id", residentUserId).range(0, 0) as never, true),
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
        true,
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
  // Only the workspace owner (or an admin) may delete a login; a co-manager's delete keeps it.
  if (input.actorUserId.trim() !== input.managerUserId.trim() && input.actorIsAdmin !== true) {
    return { status: "keep", reason: "not_owner" };
  }
  try {
    if (!email || (await authEmail(db, residentUserId)) !== email) {
      return { status: "keep", reason: "identity_mismatch" };
    }
    const roles = await normalizedRolesForUser(db, residentUserId);
    if (roles.length === 0 || roles.some((role) => role !== "resident")) {
      return { status: "keep", reason: "other_roles" };
    }
    // The application's email is whatever the manager typed, so a matching email proves nothing
    // about who owns the account. Only the resident's own signed-in submit leaves this row.
    if (!(await residentBoundToManager(db, residentUserId, input.managerUserId.trim()))) {
      return { status: "keep", reason: "unverified_link" };
    }
    const relationship = await findOtherRelationship(db, {
      managerUserId: input.managerUserId.trim(),
      residentUserId,
      email,
      applicationId: input.applicationId,
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
