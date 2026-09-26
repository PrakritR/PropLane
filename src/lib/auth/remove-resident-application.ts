import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { managerCanAccessApplicationRecord } from "@/lib/auth/manager-application-access";
import {
  previewManagerResidentPurge,
  purgeManagerResidentData,
  type ManagerResidentPurgeCounts,
} from "@/lib/auth/purge-manager-resident";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceDb = ReturnType<typeof createSupabaseServiceRoleClient>;

/** Who the delete is about, resolved on the server from the application row. */
type ResidentRemovalTarget = {
  applicationId: string;
  /** The portfolio the rows belong to — the record's own stamp, not the caller's id. */
  managerUserId: string;
  email: string;
  residentUserId: string | null;
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
 * The resident's login id, when they have one. A resident may hold charges or
 * autopay rows keyed only by `resident_user_id`, so the cascade needs it — but a
 * resident who never signed up is still deletable, hence `null` rather than a
 * refusal.
 */
async function resolveResidentUserId(db: SupabaseClient, email: string): Promise<string | null> {
  if (!email) return null;
  const { data, error } = await db.from("profiles").select("id").ilike("email", literalEmail(email));
  if (error) throw new Error(error.message);
  const id = (data ?? []).map((row) => (row as { id?: unknown }).id).find((value) => typeof value === "string");
  return typeof id === "string" && id.length > 0 ? id : null;
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
  return {
    ok: true as const,
    target: {
      applicationId: String(row.id),
      managerUserId,
      email: recordEmail,
      residentUserId: await resolveResidentUserId(db, recordEmail),
    },
  };
}

/**
 * What Delete would remove, counted, with nothing removed. Powers the confirm
 * dialog: a manager sees the leases, charges and services that go with the row
 * before they agree to lose them.
 */
export async function previewResidentApplicationRemoval(
  db: SupabaseClient,
  actor: { userId: string; isAdmin: boolean },
  input: { applicationId: string; email?: string },
): Promise<
  | { ok: true; mode: "preview"; email: string; counts: ManagerResidentPurgeCounts; total: number }
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
  });
  return { ok: true as const, mode: "preview" as const, email: target.email, counts: preview.counts, total: preview.total };
}

/**
 * Remove the resident from this portfolio: the application AND every lease,
 * charge, service, inspection, document and conversation in this manager's
 * portfolio that belongs to them, in one transaction.
 *
 * The resident's login and anything they hold with another manager are
 * untouched. A failure removes nothing, so the caller keeps the row in the list.
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
  });
  return {
    ok: true as const,
    mode: "removed_application" as const,
    email: target.email,
    removed: result.counts,
    total: result.total,
    storageWarnings: result.storageWarnings,
  };
}
