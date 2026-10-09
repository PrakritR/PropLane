import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { managerCanAccessApplicationRecord } from "@/lib/auth/manager-application-access";
import {
  previewManagerResidentPurge,
  purgeManagerResidentData,
  type ManagerResidentPurgeCounts,
} from "@/lib/auth/purge-manager-resident";
import {
  applyResidentAccountDecision,
  decideResidentAccountFate,
  findResidentOwnedWorkspaceThreadIds,
  type ResidentAccountOutcome,
} from "@/lib/auth/resident-account-deletion";
import { clearResidentWorkspaceBinding } from "@/lib/auth/resident-workspace-binding";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceDb = ReturnType<typeof createSupabaseServiceRoleClient>;

/** Who the delete is about, resolved on the server from the application row. */
type ResidentRemovalTarget = {
  applicationId: string;
  /** The portfolio the rows belong to — the record's own stamp, not the caller's id. */
  managerUserId: string;
  email: string;
  residentUserId: string | null;
  /** Numbers they text from, so the work number's text log can be attributed. */
  phones: string[];
};

type Refusal = { ok: false; status: number; error: string };

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** `ilike` treats these as wildcards; an address must match literally. */
function literalEmail(email: string): string {
  return email.replace(/[\\%_]/g, "\\$&");
}

/**
 * The resident's login id and phone, when they have one. A resident may hold
 * charges or autopay rows keyed only by `resident_user_id`, so the cascade needs
 * the id — but a resident who never signed up is still deletable, hence `null`
 * rather than a refusal.
 */
async function resolveResidentLogin(
  db: SupabaseClient,
  email: string,
): Promise<{ id: string | null; phones: string[] }> {
  if (!email) return { id: null, phones: [] };
  const { data, error } = await db.from("profiles").select("id,phone").ilike("email", literalEmail(email));
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as { id?: unknown; phone?: unknown }[];
  const id = rows.map((row) => row.id).find((value) => typeof value === "string" && value.length > 0);
  const phones = rows
    .map((row) => row.phone)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return { id: typeof id === "string" ? id : null, phones };
}

/**
 * A property relationship authorizes this application, never the resident's
 * login. Both the preview and the delete authorize through here, so the counts
 * a manager is shown can only ever describe rows they may destroy.
 */
async function authorizeResidentRemoval(
  db: SupabaseClient,
  actor: { userId: string; isAdmin: boolean },
  input: { applicationId: string; email?: string },
): Promise<{ ok: true; target: ResidentRemovalTarget } | Refusal> {
  const { data: row, error } = await db.from("manager_application_records")
    .select("id,resident_email,manager_user_id,property_id,assigned_property_id")
    .eq("id", input.applicationId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!row || (!actor.isAdmin && !(await managerCanAccessApplicationRecord(db as ServiceDb, actor.userId, row, { level: "delete" })))) {
    return { ok: false as const, status: 403, error: "Forbidden: application is not in your portfolio." };
  }
  const recordEmail = normalizeEmail(row.resident_email);
  if (input.email && normalizeEmail(input.email) !== recordEmail) {
    return { ok: false as const, status: 400, error: "The resident does not match this application." };
  }
  // A record whose manager stamp was never written (or was frozen before the
  // property changed hands) is cleared in the caller's own portfolio — the
  // access check above already proved the property is theirs.
  const managerUserId = String(row.manager_user_id ?? "").trim() || actor.userId;
  const login = await resolveResidentLogin(db, recordEmail);
  return {
    ok: true as const,
    target: {
      applicationId: String(row.id),
      managerUserId,
      email: recordEmail,
      residentUserId: login.id,
      phones: login.phones,
    },
  };
}

/**
 * "No login" and "login kept" read the same to a manager: telling them apart would
 * let anyone who can add an application learn whether an arbitrary address has a
 * PropLane account. An admin may see the difference.
 */
function publicAccountFate<T extends ResidentAccountOutcome>(fate: T, isAdmin: boolean): T | "kept" {
  return fate === "none" && !isAdmin ? "kept" : fate;
}

/**
 * What Delete would remove, counted, with nothing removed. Powers the confirm
 * dialog: a manager sees the leases, charges and services that go with the row
 * before they agree to lose them.
 *
 * `accountFate: false` answers the counts alone. Deciding the login's fate walks
 * every table that could still tie the account to anyone — one query per
 * (table x column) — so a confirm covering many residents asks for counts only
 * and leaves the decision to the delete itself, which re-derives it per resident
 * regardless of what any preview said. Those counts are then this manager's own
 * rows only: the resident's copies of this workspace's conversations go with the
 * login, so they belong to that per-resident decision and are reported by the
 * delete's own `account` and `removed.conversations`, not promised up front.
 */
export async function previewResidentApplicationRemoval(
  db: SupabaseClient,
  actor: { userId: string; isAdmin: boolean },
  input: { applicationId: string; email?: string },
  opts?: { accountFate?: boolean },
): Promise<
  | {
      ok: true;
      mode: "preview";
      email: string;
      counts: ManagerResidentPurgeCounts;
      total: number;
      /**
       * What happens to their PropLane login: deleted with them, kept, or they
       * never had one. `null` when the caller did not ask for it.
       */
      account: "deleted" | "kept" | "none" | null;
    }
  | Refusal
> {
  const authorized = await authorizeResidentRemoval(db, actor, input);
  if (!authorized.ok) return authorized;
  const { target } = authorized;
  const preview = await previewManagerResidentPurge(db as ServiceDb, {
    managerUserId: target.managerUserId,
    email: target.email,
    residentUserId: target.residentUserId,
    applicationId: target.applicationId,
    phones: target.phones,
  });
  // Decided first: the resident's own copies of the conversations in this workspace
  // go only with the login, so they are counted only when the login will be deleted.
  const decision =
    opts?.accountFate === false
      ? null
      : await decideResidentAccountFate(db, {
          actorUserId: actor.userId,
          actorIsAdmin: actor.isAdmin,
          managerUserId: target.managerUserId,
          email: target.email,
          residentUserId: target.residentUserId,
          applicationId: target.applicationId,
        });
  const residentThreads =
    decision?.status === "delete"
      ? await findResidentOwnedWorkspaceThreadIds(db, {
          managerUserId: target.managerUserId,
          residentUserId: target.residentUserId,
        })
      : [];
  // Paid money stays on the books, unnamed; the dialog says how much.
  const counts = {
    ...preview.counts,
    conversations: preview.counts.conversations + residentThreads.length,
    paidCount: preview.paidKept.count,
    paidCents: preview.paidKept.cents,
  };
  return {
    ok: true as const,
    mode: "preview" as const,
    email: target.email,
    counts,
    total: preview.total + residentThreads.length,
    account: decision
      ? publicAccountFate(decision.status === "delete" ? "deleted" : decision.status === "none" ? "none" : "kept", actor.isAdmin)
      : null,
  };
}

/**
 * Remove the resident from this portfolio: the application AND every lease,
 * unpaid charge, booking, service, inspection, document, message and text in
 * this manager's portfolio that belongs to them, in one transaction. Paid
 * charges stay on the books without a name.
 *
 * Anything they hold with another manager is untouched. Their PropLane login is
 * deleted too (the same full purge as self-delete), together with their own
 * copies of this workspace's conversations, only when `decideResidentAccountFate`
 * finds nothing else tying it to anyone; otherwise login and threads stay.
 * A failure before the login step removes nothing of this manager's.
 */
export async function removeResidentApplication(
  db: SupabaseClient,
  actor: { userId: string; isAdmin: boolean },
  input: { applicationId: string; email?: string },
) {
  const authorized = await authorizeResidentRemoval(db, actor, input);
  if (!authorized.ok) return authorized;
  const { target } = authorized;
  const result = await purgeManagerResidentData(db as ServiceDb, {
    managerUserId: target.managerUserId,
    email: target.email,
    residentUserId: target.residentUserId,
    applicationId: target.applicationId,
    phones: target.phones,
  });
  // Decided AFTER this manager's rows are gone: what is left is someone else's.
  const decision = await decideResidentAccountFate(db, {
    actorUserId: actor.userId,
    actorIsAdmin: actor.isAdmin,
    managerUserId: target.managerUserId,
    email: target.email,
    residentUserId: target.residentUserId,
    applicationId: target.applicationId,
  });
  // The resident's own copies of the conversations in this workspace (the manager's
  // RPC only reaches rows the manager owns) belong to the resident: they go only with
  // the login. The account purge below removes every resident-owned inbox row, so no
  // separate delete is needed; a kept login keeps its threads untouched.
  const residentThreadIds =
    decision.status === "delete"
      ? await findResidentOwnedWorkspaceThreadIds(db, {
          managerUserId: target.managerUserId,
          residentUserId: target.residentUserId,
        })
      : [];
  const account = await applyResidentAccountDecision(db, decision);
  const removedThreads = account.outcome === "deleted" ? residentThreadIds.length : 0;
  if (account.outcome !== "deleted" && target.residentUserId) {
    // This manager's relationship has ended; the proof must not outlive it.
    await clearResidentWorkspaceBinding(db, target.residentUserId, target.managerUserId).catch(() => undefined);
  }
  return {
    ok: true as const,
    mode: "removed_application" as const,
    email: target.email,
    removed: { ...result.counts, conversations: result.counts.conversations + removedThreads },
    total: result.total + removedThreads,
    anonymized: result.anonymized,
    storageWarnings: result.storageWarnings,
    account: publicAccountFate(account.outcome, actor.isAdmin),
    ...(account.error ? { accountError: account.error } : {}),
  };
}
