import type { SupabaseClient } from "@supabase/supabase-js";
import { listViewerWorkspaces, loadWorkspaceById, resolveActiveWorkspace, type ActiveWorkspace } from "@/lib/workspaces/active.server";
import { WORKSPACE_COOKIE } from "@/lib/workspaces/types";

/** Accepted co-manager links where this user is the invitee (linked workspace, no owned rows). */
export async function getAcceptedCoManagerInviterIds(
  db: SupabaseClient,
  userId: string,
  opts: { throwOnError?: boolean } = {},
): Promise<string[]> {
  const { data, error } = await db
    .from("account_link_invites")
    .select("inviter_user_id")
    .eq("invitee_user_id", userId)
    .eq("status", "accepted");
  if (error) {
    if (opts.throwOnError) throw new Error("Co-manager workspace links unavailable.");
    return [];
  }
  return [
    ...new Set(
      (data ?? [])
        .map((row) => String((row as { inviter_user_id?: string }).inviter_user_id ?? "").trim())
        .filter(Boolean),
    ),
  ];
}

export async function managerHasOwnedProperties(
  db: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from("manager_property_records")
    .select("id")
    .eq("manager_user_id", userId)
    .limit(1);
  if (error) return false;
  return (data ?? []).length > 0;
}

/** Linked co-manager with no owned properties — still a full manager account for messaging setup. */
export async function isPureCoManagerWorkspace(
  db: SupabaseClient,
  userId: string,
  opts: { throwOnError?: boolean } = {},
): Promise<boolean> {
  const { data, error } = await db.from("manager_property_records")
    .select("id").eq("manager_user_id", userId).limit(1);
  // Unknown ownership is not evidence of eligibility inherited from another account.
  if (error && opts.throwOnError) throw new Error("Co-manager workspace ownership unavailable.");
  if (error || (data ?? []).length > 0) return false;
  const inviters = await getAcceptedCoManagerInviterIds(db, userId, opts);
  return inviters.length > 0;
}

/**
 * The workspace a work number answers FOR.
 *
 * A work number belongs to the workspace, not to whoever provisioned it. For an
 * owner that is themselves. For a pure co-manager — linked, no owned houses —
 * it is the owner whose workspace they hold the most houses in, so tenant
 * records and listings stay with the property owner and a prospect texting the
 * line cannot tell whether a manager or a co-manager is behind it.
 */
export async function resolveWorkspaceOwnerForWorkNumber(
  db: SupabaseClient,
  numberOwnerUserId: string,
  opts: { throwOnError?: boolean; workspaceId?: string | null } = {},
): Promise<{ ownerUserId: string; sharedFromCoManager: boolean; workspaceId: string | null }> {
  // A row placed in a workspace answers for that workspace's owner — the
  // switcher's workspace, not a guess from co-manager links. Only a legacy
  // row with no workspace (the migration could not place it) still falls
  // through to the co-manager collapse below.
  const placed = opts.workspaceId?.trim();
  if (placed) {
    const workspace = await loadWorkspaceById(db, placed);
    if (workspace?.ownerUserId) {
      return { ownerUserId: workspace.ownerUserId, sharedFromCoManager: false, workspaceId: workspace.id };
    }
    if (opts.throwOnError) throw new Error("Workspace for this line unavailable.");
  }
  if (!(await isPureCoManagerWorkspace(db, numberOwnerUserId, opts))) {
    return { ownerUserId: numberOwnerUserId, sharedFromCoManager: false, workspaceId: null };
  }
  const owners = await listWorkspaceOwnersForCoManager(db, numberOwnerUserId, opts);
  const best = owners[0];
  return best
    ? { ownerUserId: best.ownerUserId, sharedFromCoManager: true, workspaceId: null }
    : { ownerUserId: numberOwnerUserId, sharedFromCoManager: false, workspaceId: null };
}

/**
 * The workspace a work EMAIL answers for. Same rule, same tie-break, same
 * function as the number: an address held by a pure co-manager (requested
 * before addresses became workspace-owned) answers as the owner's workspace.
 */
export const resolveWorkspaceOwnerForWorkEmail = resolveWorkspaceOwnerForWorkNumber;

/**
 * Every workspace a co-manager belongs to, most houses first. Order matters:
 * it is the tie-break for which workspace a legacy co-manager line answers for
 * and the order the Communication header lists shared numbers in.
 */
export async function listWorkspaceOwnersForCoManager(
  db: SupabaseClient,
  coManagerUserId: string,
  opts: { throwOnError?: boolean } = {},
): Promise<Array<{ ownerUserId: string; houses: number }>> {
  const { data, error } = await db
    .from("account_link_invites")
    .select("inviter_user_id, assigned_property_ids")
    .eq("invitee_user_id", coManagerUserId)
    .eq("status", "accepted");
  if (error) {
    if (opts.throwOnError) throw new Error("Co-manager workspace links unavailable.");
    return [];
  }
  const byOwner = new Map<string, number>();
  for (const row of data ?? []) {
    const ownerUserId = String((row as { inviter_user_id?: string }).inviter_user_id ?? "").trim();
    if (!ownerUserId) continue;
    const assigned = (row as { assigned_property_ids?: unknown }).assigned_property_ids;
    const houses = Array.isArray(assigned) ? assigned.length : 0;
    byOwner.set(ownerUserId, Math.max(byOwner.get(ownerUserId) ?? 0, houses));
  }
  return [...byOwner.entries()]
    .map(([ownerUserId, houses]) => ({ ownerUserId, houses }))
    .sort((a, b) => b.houses - a.houses || a.ownerUserId.localeCompare(b.ownerUserId));
}

export type WorkspaceWorkNumber = {
  workspaceId: string;
  workspaceName: string;
  /** The viewer owns this workspace (may set its line up); false = shared with them. */
  owned: boolean;
  isDefault: boolean;
  ownerUserId: string;
  ownerName: string | null;
  phoneNumber: string | null;
  provisionState: string | null;
};

const NUMBER_SUMMARY = "workspace_id, manager_user_id, phone_number, provision_state";

/**
 * The work number of every workspace this account can see, one per workspace.
 *
 * A workspace's line is the row placed in it. An owned workspace without one
 * is listed with a null number so the UI can offer to set it up; a shared
 * workspace shows its owner's line for THAT workspace only — a co-manager
 * never gets a line of their own, and never sees a line from a workspace they
 * were not granted. Owned workspaces come first, the default first of those,
 * so `numbers[0]` is the viewer's own default line when they have one.
 */
export async function resolveWorkspaceWorkNumbers(
  db: SupabaseClient,
  userId: string,
): Promise<{ role: "primary" | "co_manager"; numbers: WorkspaceWorkNumber[] }> {
  const workspaces = await listViewerWorkspaces(db, userId);
  const pure = await isPureCoManagerWorkspace(db, userId);
  return { role: pure ? "co_manager" : "primary", numbers: await numbersForWorkspaces(db, workspaces) };
}

/** The line of ONE workspace, or null when it has none. */
export async function resolveWorkNumberForWorkspace(
  db: SupabaseClient,
  workspace: ActiveWorkspace,
): Promise<WorkspaceWorkNumber> {
  const [entry] = await numbersForWorkspaces(db, [workspace]);
  return entry;
}

async function numbersForWorkspaces(
  db: SupabaseClient,
  workspaces: ActiveWorkspace[],
): Promise<WorkspaceWorkNumber[]> {
  if (workspaces.length === 0) return [];
  const workspaceIds = workspaces.map((w) => w.id);
  const ownerIds = [...new Set(workspaces.map((w) => w.ownerUserId))];
  const [{ data: numberRows }, { data: profileRows }] = await Promise.all([
    db.from("manager_sms_numbers").select(NUMBER_SUMMARY).in("workspace_id", workspaceIds),
    db.from("profiles").select("id, full_name, email").in("id", ownerIds),
  ]);
  const numberByWorkspace = new Map(
    (numberRows ?? []).map((r) => [
      String(r.workspace_id ?? "").trim(),
      {
        phoneNumber: typeof r.phone_number === "string" && r.phone_number.trim() ? r.phone_number.trim() : null,
        provisionState: typeof r.provision_state === "string" ? r.provision_state : null,
      },
    ]),
  );
  const nameByOwner = new Map(
    (profileRows ?? []).map((p) => [
      String(p.id ?? "").trim(),
      String(p.full_name ?? "").trim() || String(p.email ?? "").trim() || null,
    ]),
  );
  return workspaces.map((w) => ({
    workspaceId: w.id,
    workspaceName: w.name,
    owned: w.owned,
    isDefault: w.isDefault,
    ownerUserId: w.ownerUserId,
    ownerName: nameByOwner.get(w.ownerUserId) ?? null,
    phoneNumber: numberByWorkspace.get(w.id)?.phoneNumber ?? null,
    provisionState: numberByWorkspace.get(w.id)?.provisionState ?? null,
  }));
}

/** The selected workspace id from the current request, or undefined outside one. */
export async function readSelectedWorkspaceIdSafely(): Promise<string | undefined> {
  try {
    const { cookies } = await import("next/headers");
    return (await cookies()).get(WORKSPACE_COOKIE)?.value || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The line the VIEWER is acting from right now: the active workspace's row.
 * `selectedWorkspaceId` overrides the request cookie for callers that hold it.
 */
export async function resolveViewerWorkNumber(
  db: SupabaseClient,
  viewerUserId: string,
  selectedWorkspaceId?: string | null,
): Promise<WorkspaceWorkNumber | null> {
  const selected = selectedWorkspaceId === undefined ? await readSelectedWorkspaceIdSafely() : selectedWorkspaceId;
  const workspace = await resolveActiveWorkspace(db, viewerUserId, selected);
  return resolveWorkNumberForWorkspace(db, workspace);
}

/**
 * A number the TARGET workspace holds via `workspace_work_numbers` — its own
 * home number when it has one, else a number shared in from a sibling
 * workspace of the SAME owner (primary hold first). Never a guess at an
 * unrelated workspace's line. Returns `columns` as selected, unmapped, so
 * callers keep their own row type. Used only as a fallback when the owner's
 * home-row disambiguation below cannot place the message's workspace.
 */
async function resolveHeldNumberRow<T>(
  db: SupabaseClient,
  columns: string,
  workspaceId: string,
): Promise<T | null> {
  const id = workspaceId.trim();
  if (!id) return null;
  const { data: holds } = await db
    .from("workspace_work_numbers")
    .select("number_id, is_primary")
    .eq("workspace_id", id)
    .order("is_primary", { ascending: false });
  const numberIds = [...new Set((holds ?? []).map((h) => String(h.number_id ?? "").trim()).filter(Boolean))];
  for (const numberId of numberIds) {
    const { data: row, error } = await db.from("manager_sms_numbers").select(columns).eq("id", numberId).maybeSingle();
    if (!error && row) return row as T;
  }
  return null;
}

/**
 * The number row an OWNER sends from for one message: the line of the
 * workspace that holds the house the message is about; a house-less message
 * goes out from the owner's default workspace's line. When that workspace has
 * no HOME number of its own, a number it holds via sharing
 * (`workspace_work_numbers`) is used before ever falling back to an unrelated
 * workspace's line — a workspace never sends from a number it does not hold.
 * A legacy row the migration could not place still answers when nothing else
 * does. Returns `columns` as selected, unmapped, so the dispatcher keeps its
 * own row type.
 */
export async function resolveOwnerSendNumberRow<T extends { workspace_id?: string | null }>(
  db: SupabaseClient,
  ownerUserId: string,
  columns: string,
  opts: { propertyId?: string | null; workLineId?: string | null } = {},
): Promise<{ data: T | null; error: { message: string } | null }> {
  const exactLine = opts.workLineId?.trim();
  if (exactLine) {
    const { data: line, error } = await db.from("manager_sms_numbers").select(columns).eq("id", exactLine).maybeSingle();
    if (error || !line) return { data: null, error: error ?? null };
    const row = line as unknown as T & { manager_user_id?: string };
    if (row.manager_user_id === ownerUserId) return { data: row, error: null };
    const { data: holds, error: holdsError } = await db.from("workspace_work_numbers")
      .select("workspace_id,portal_workspaces!inner(owner_user_id)").eq("number_id", exactLine);
    if (holdsError) return { data: null, error: holdsError };
    const allowed = (holds ?? []).some((hold) => {
      const workspace = hold.portal_workspaces as unknown as { owner_user_id?: string } | null;
      return workspace?.owner_user_id === ownerUserId;
    });
    return { data: allowed ? row : null, error: null };
  }
  const query = db.from("manager_sms_numbers").select(columns).eq("manager_user_id", ownerUserId);
  // A real builder is thenable and yields every row; a single-row double
  // only answers `maybeSingle`, and its one row is the one candidate.
  const { data, error } =
    typeof (query as { then?: unknown }).then === "function" ? await query : await query.maybeSingle();
  if (error) return { data: null, error };
  const list = Array.isArray(data) ? data : data ? [data] : [];
  const rows = (list as unknown as T[]).filter(Boolean);

  const propertyId = opts.propertyId?.trim();
  let houseWorkspaceId = "";
  if (propertyId) {
    const { data: house } = await db.from("manager_property_records").select("workspace_id").eq("id", propertyId).maybeSingle();
    houseWorkspaceId = String(house?.workspace_id ?? "").trim();
  }

  if (rows.length === 0) {
    // No home number anywhere for this owner. The only safe send is a number
    // the TARGET workspace holds via sharing — never a guess.
    let workspaceId = houseWorkspaceId;
    if (!workspaceId) {
      const { data: def } = await db
        .from("portal_workspaces")
        .select("id")
        .eq("owner_user_id", ownerUserId)
        .eq("is_default", true)
        .maybeSingle();
      workspaceId = String(def?.id ?? "").trim();
    }
    const held = workspaceId ? await resolveHeldNumberRow<T>(db, columns, workspaceId) : null;
    return { data: held, error: null };
  }
  if (houseWorkspaceId) {
    const match = rows.find((r) => String(r.workspace_id ?? "") === houseWorkspaceId);
    if (match) return { data: match, error: null };
    // The target workspace has no home number of its own — try a number it
    // holds via sharing before ever falling back to another workspace's line.
    const held = await resolveHeldNumberRow<T>(db, columns, houseWorkspaceId);
    if (held) return { data: held, error: null };
  }
  if (rows.length === 1) return { data: rows[0], error: null };
  const placedIds = rows.map((r) => String(r.workspace_id ?? "").trim()).filter(Boolean);
  if (placedIds.length > 0) {
    const { data: workspaces } = await db.from("portal_workspaces").select("id, is_default").in("id", placedIds);
    const defaultId = String((workspaces ?? []).find((w) => w.is_default)?.id ?? "");
    const inDefault = defaultId ? rows.find((r) => String(r.workspace_id ?? "") === defaultId) : null;
    if (inDefault) return { data: inDefault, error: null };
  }
  return { data: rows.find((r) => !r.workspace_id) ?? rows[0], error: null };
}
