import { normalizeE164 } from "@/lib/phone-e164";
import { WORKSPACE_NO_WORK_NUMBER_CODE, WORKSPACE_NO_WORK_NUMBER_MESSAGE } from "@/lib/sms/workspace-no-work-number";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listViewerWorkspaces, loadWorkspaceById, resolveActiveWorkspace, type ActiveWorkspace } from "@/lib/workspaces/active.server";
import { WORKSPACE_COOKIE } from "@/lib/workspaces/types";
import { withoutOwnerLinks } from "@/lib/co-manager-team-roles";
import { isServiceWorkspace, resolveServiceLine } from "@/lib/one-number/service-line.server";

/** Accepted co-manager links where this user is the invitee (linked workspace, no owned rows). */
export async function getAcceptedCoManagerInviterIds(
  db: SupabaseClient,
  userId: string,
  opts: { throwOnError?: boolean } = {},
): Promise<string[]> {
  const { data, error } = withoutOwnerLinks(await db
    .from("account_link_invites")
    .select("inviter_user_id, team_role")
    .eq("invitee_user_id", userId)
    .eq("status", "accepted"));
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
  const { data, error } = withoutOwnerLinks(await db
    .from("account_link_invites")
    .select("inviter_user_id, assigned_property_ids, team_role")
    .eq("invitee_user_id", coManagerUserId)
    .eq("status", "accepted"));
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

const NUMBER_SUMMARY = "workspace_id, manager_user_id, phone_number, provision_state, released_at";

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
  // A workspace may carry a released row beside its live one (the index is over
  // live rows only); the live one is the workspace's work number.
  const numberByWorkspace = new Map<string, { phoneNumber: string | null; provisionState: string | null }>();
  for (const r of [...(numberRows ?? [])].sort((a, b) => Number(Boolean(a.released_at)) - Number(Boolean(b.released_at)))) {
    const key = String(r.workspace_id ?? "").trim();
    if (!key || numberByWorkspace.has(key)) continue;
    numberByWorkspace.set(key, {
      phoneNumber: typeof r.phone_number === "string" && r.phone_number.trim() ? r.phone_number.trim() : null,
      provisionState: typeof r.provision_state === "string" ? r.provision_state : null,
    });
  }
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
 * `columns` with every column the resolution itself FILTERS on guaranteed
 * present: `released_at` (the uniqueness index is per workspace among LIVE
 * rows only, so a released row can sit beside the live one and the live-row
 * preference below has to see the difference), `workspace_id` (the home-row
 * / shared / legacy-unplaced split below reads it off each row) and
 * `manager_user_id` (the named-line branch matches direct ownership on it).
 * PostgREST returns only the selected columns, so a caller's own column list
 * must never decide whether those guards run — omitting `workspace_id`
 * silently turns every one of the owner's rows into a legacy unplaced one.
 */
const RESOLUTION_COLUMNS = ["released_at", "workspace_id", "manager_user_id"] as const;

function withResolutionColumns(columns: string): string {
  let out = columns;
  for (const required of RESOLUTION_COLUMNS) {
    if (!new RegExp(`(^|,)\\s*${required}\\s*(,|$)`).test(out)) out = `${out}, ${required}`;
  }
  return out;
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
  let fallback: T | null = null;
  for (const numberId of numberIds) {
    const { data: row, error } = await db
      .from("manager_sms_numbers")
      .select(withResolutionColumns(columns))
      .eq("id", numberId)
      .maybeSingle();
    if (error || !row) continue;
    // A released hold stays behind for history; the live line wins.
    if (!(row as { released_at?: string | null }).released_at) return row as T;
    fallback ??= row as T;
  }
  return fallback;
}

/**
 * The row a PropLane-MANAGED workspace (`is_service`) sends from: the PropLane line, never a number the workspace itself
 * holds (`resolveServiceLine`). In shared mode the line has no number row, so the answer is a description of it. A line that
 * cannot be resolved is the plain no-work-number refusal; one that cannot be read is an error (never an old-number fallback).
 */
async function resolveManagedLineRow<T>(
  db: SupabaseClient,
  columns: string,
): Promise<{ data: T | null; error: { message: string; code?: string } | null }> {
  const line = await resolveServiceLine<T>(db, columns);
  if (!line.ok) {
    return line.reason === "unreadable"
      ? { data: null, error: { message: "The PropLane line could not be read." } }
      : { data: null, error: { message: WORKSPACE_NO_WORK_NUMBER_MESSAGE, code: WORKSPACE_NO_WORK_NUMBER_CODE } };
  }
  if (line.kind === "owner_number") return { data: line.row, error: null };
  return {
    data: { phone_number: line.phoneNumber, provision_state: "active", registration_state: "approved", workspace_id: null } as unknown as T,
    error: null,
  };
}

/**
 * The number row an OWNER sends from for one message: the line of the
 * workspace the message is about - the workspace that holds the house, or,
 * for a house-less (or unplaced) message, the owner's DEFAULT workspace.
 *
 * One work number per workspace, and a workspace sends ONLY from its own:
 * its home row (`manager_sms_numbers.workspace_id`), or a number it holds via
 * sharing (`workspace_work_numbers`). There is no "the owner has just one
 * line, use it" and no default-workspace fallback for a house placed in a
 * workspace - that is how a workspace-B tenant got texted from workspace A's
 * number and their answer landed in A. A legacy row the migration could not
 * place (`workspace_id` null) may still answer for the owner's default
 * workspace, and only that one. Nothing found is an error with
 * `code: WORKSPACE_NO_WORK_NUMBER_CODE` ("This workspace has no work number."),
 * which the dispatcher turns into a plain, non-retried refusal.
 * Returns `columns` as selected, unmapped, so the dispatcher keeps its own
 * row type.
 */
export async function resolveOwnerSendNumberRow<T extends { workspace_id?: string | null }>(
  db: SupabaseClient,
  ownerUserId: string,
  columns: string,
  opts: { propertyId?: string | null; workLineId?: string | null; workspaceId?: string | null } = {},
): Promise<{ data: T | null; error: { message: string; code?: string } | null }> {
  const exactLine = opts.workLineId?.trim();
  if (exactLine) {
    const { data: line, error } = await db
      .from("manager_sms_numbers")
      .select(withResolutionColumns(columns))
      .eq("id", exactLine)
      .maybeSingle();
    if (error || !line) return { data: null, error: error ?? null };
    const row = line as unknown as T & { manager_user_id?: string };
    // Entitlement FIRST: this owner's own row, or one a workspace of theirs holds. A pinned id that is neither is
    // nothing to this owner, and a managed-workspace override must not answer for it - that would hand a line the
    // owner has no claim on (and put a self-serve manager on the shared 206, which a dedicated workspace never sends from).
    let entitled = row.manager_user_id === ownerUserId;
    if (!entitled) {
      const { data: holds, error: holdsError } = await db.from("workspace_work_numbers")
        .select("workspace_id,portal_workspaces!inner(owner_user_id)").eq("number_id", exactLine);
      if (holdsError) return { data: null, error: holdsError };
      entitled = (holds ?? []).some((hold) => {
        const workspace = hold.portal_workspaces as unknown as { owner_user_id?: string } | null;
        return workspace?.owner_user_id === ownerUserId;
      });
    }
    if (!entitled) return { data: null, error: null };
    // A line the owner IS entitled to that belongs to a PropLane-managed workspace is the PropLane line, whatever id was pinned.
    const pinnedManaged = await isServiceWorkspace(db, String(row.workspace_id ?? ""));
    if (pinnedManaged === null) return { data: null, error: { message: "Service workspace unreadable." } };
    if (pinnedManaged) return resolveManagedLineRow<T>(db, columns);
    return { data: row, error: null };
  }
  const noNumber = { data: null, error: { message: WORKSPACE_NO_WORK_NUMBER_MESSAGE, code: WORKSPACE_NO_WORK_NUMBER_CODE } };

  const propertyId = opts.propertyId?.trim();
  // A caller that already knows the workspace (a status check) names it; it
  // wins over a house and is resolved exactly like one.
  let houseWorkspaceId = opts.workspaceId?.trim() ?? "";
  if (!houseWorkspaceId && propertyId) {
    const { data: house, error: houseError } = await db.from("manager_property_records").select("workspace_id").eq("id", propertyId).maybeSingle();
    if (houseError) return { data: null, error: houseError };
    houseWorkspaceId = String(house?.workspace_id ?? "").trim();
  }
  let defaultWorkspaceId = "";
  const loadDefaultWorkspaceId = async () => {
    if (defaultWorkspaceId) return defaultWorkspaceId;
    const { data: def } = await db
      .from("portal_workspaces")
      .select("id")
      .eq("owner_user_id", ownerUserId)
      .eq("is_default", true)
      .maybeSingle();
    defaultWorkspaceId = String(def?.id ?? "").trim();
    return defaultWorkspaceId;
  };
  const targetWorkspaceId = houseWorkspaceId || (await loadDefaultWorkspaceId());

  // PropLane's own managed service (`is_service`) has no line per workspace: it texts on the PropLane line, in both line
  // modes, even when the workspace still holds a number of its own (captain, Oct 25).
  if (targetWorkspaceId) {
    const managed = await isServiceWorkspace(db, targetWorkspaceId);
    if (managed === null) return { data: null, error: { message: "Service workspace unreadable." } };
    if (managed) return resolveManagedLineRow<T>(db, columns);
  }

  const query = db.from("manager_sms_numbers").select(withResolutionColumns(columns)).eq("manager_user_id", ownerUserId);
  // A real builder is thenable and yields every row; a single-row double
  // only answers `maybeSingle`, and its one row is the one candidate.
  const { data, error } =
    typeof (query as { then?: unknown }).then === "function" ? await query : await query.maybeSingle();
  if (error) return { data: null, error };
  const list = Array.isArray(data) ? data : data ? [data] : [];
  const rows = (list as unknown as Array<T & { released_at?: string | null }>).filter(Boolean);

  if (targetWorkspaceId) {
    // A released row stays behind for history and must not shadow a live one.
    const own = rows.filter((r) => String(r.workspace_id ?? "") === targetWorkspaceId);
    const match = own.find((r) => !r.released_at) ?? own[0];
    if (match) return { data: match, error: null };
    // The workspace has no home number of its own - a number it holds via
    // sharing is still ITS line; nothing else is.
    const held = await resolveHeldNumberRow<T>(db, columns, targetWorkspaceId);
    if (held) return { data: held, error: null };
  }

  // A legacy row the migration could not place answers for the owner's
  // default workspace only - never for a house placed in another workspace.
  const forDefaultWorkspace = !houseWorkspaceId || houseWorkspaceId === (await loadDefaultWorkspaceId());
  if (forDefaultWorkspace) {
    const unplaced = rows.filter((r) => !String(r.workspace_id ?? "").trim());
    const legacy = unplaced.find((r) => !r.released_at) ?? unplaced[0];
    if (legacy) return { data: legacy, error: null };
  }
  return noNumber;
}

/**
 * The line ONE workspace would actually send from, resolved exactly the way a
 * send resolves it (`resolveOwnerSendNumberRow`): the workspace's home row, a
 * number it holds via sharing, or the owner's legacy unplaced row when this is
 * their default workspace. `numbersForWorkspaces` only matches home rows, so a
 * workspace whose line arrives by either of the other two routes is sendable
 * while that read reports no number — use this to agree with "can send".
 *
 * This reports what a status screen should SHOW, so it answers for a line
 * whatever its provision state. The send path's own
 * `resolveWorkspaceSendLine` (`manager-number-provisioning.server`) is a
 * different question - a home row that can send right now, or nothing - and
 * the two must not be reachable under one name.
 */
export async function resolveWorkspaceStatusLine(
  db: SupabaseClient,
  ownerUserId: string,
  workspaceId: string,
): Promise<{ phoneNumber: string | null; provisionState: string | null }> {
  const { data } = await resolveOwnerSendNumberRow<{
    workspace_id?: string | null;
    phone_number?: string | null;
    provision_state?: string | null;
  }>(db, ownerUserId, "workspace_id, phone_number, provision_state", { workspaceId });
  const phone = typeof data?.phone_number === "string" ? data.phone_number.trim() : "";
  return {
    phoneNumber: phone || null,
    provisionState: typeof data?.provision_state === "string" ? data.provision_state : null,
  };
}

const lineDigits = (raw: unknown): string => {
  // A work line is compared by its 10 national digits; `normalizeE164` decides what a valid number is.
  const e164 = normalizeE164(raw);
  if (e164?.startsWith("+1")) return e164.slice(2);
  const digits = String(raw ?? "").replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
};

export type ConversationSendLine =
  | { ok: true; numberId: string | null; phoneNumber: string | null; via: "line" | "house" | "only" | "shared" }
  | { ok: false; reason: "work_line_ambiguous" };

/**
 * The work line a REPLY must leave on: the one the conversation itself used.
 *
 * A reply that finds no line of its own used to fall to the owner's DEFAULT
 * workspace's number, so answering a workspace-B tenant texted them from
 * workspace A's number and their answer landed in A. Order:
 *
 *  1. a line the conversation already went through (the number texted / sent
 *     from), when this owner holds it;
 *  2. the line of the workspace that holds the house the conversation is about;
 *  3. the owner's only line, when they have just one - nothing to confuse;
 *  4. otherwise refuse. Guessing the default is how a message left from the
 *     wrong business.
 */
export async function resolveConversationSendLine(
  db: SupabaseClient,
  ownerUserId: string,
  hints: { linePhones?: ReadonlyArray<string | null | undefined>; propertyId?: string | null } = {},
): Promise<ConversationSendLine> {
  const owner = ownerUserId.trim();
  const { data } = owner
    ? await db.from("manager_sms_numbers").select("id, workspace_id, phone_number").eq("manager_user_id", owner)
    : { data: [] };
  const rows = ((data ?? []) as { id?: unknown; workspace_id?: unknown; phone_number?: unknown }[])
    .map((row) => ({
      id: String(row.id ?? "").trim(),
      workspaceId: String(row.workspace_id ?? "").trim(),
      phone: String(row.phone_number ?? "").trim(),
    }))
    .filter((row) => row.id);

  for (const phone of hints.linePhones ?? []) {
    const key = lineDigits(phone);
    if (!key) continue;
    const hit = rows.find((row) => lineDigits(row.phone) === key);
    if (hit) return { ok: true, numberId: hit.id, phoneNumber: hit.phone || null, via: "line" };
  }

  // The shared PropLane number has no `manager_sms_numbers` row, so a conversation that went through it
  // matches no work line above. It answers from that same shared number (no numberId: there is no row),
  // never from the owner's default workspace number. The config read fails closed to per_workspace,
  // in which case this never matches and nothing changes.
  const propertyId = hints.propertyId?.trim();
  let houseWorkspace = "";
  if (propertyId) {
    const { data: house } = await db.from("manager_property_records").select("workspace_id").eq("id", propertyId).maybeSingle();
    houseWorkspace = String((house as { workspace_id?: unknown } | null)?.workspace_id ?? "").trim();
  }

  // A conversation that began on the shared line, in a workspace that has since taken a number of its
  // own (Pro / Business), answers from that number: a workspace with its own line never sends from the
  // shared one. The config read fails closed to per_workspace, where this never matches.
  const unmatched = (hints.linePhones ?? []).map((phone) => normalizeE164(phone)).filter((phone): phone is string => Boolean(phone));
  if (unmatched.length > 0) {
    const { loadSharedLineConfig, workspaceHasDedicatedNumber } = await import("@/lib/one-number/config.server");
    const config = await loadSharedLineConfig(db);
    if (
      config.mode === "shared" && config.sharedNumber && unmatched.includes(config.sharedNumber) &&
      !workspaceHasDedicatedNumber(config, houseWorkspace)
    ) {
      return { ok: true, numberId: null, phoneNumber: config.sharedNumber, via: "shared" };
    }
  }

  if (propertyId) {
    const hit = houseWorkspace ? rows.find((row) => row.workspaceId === houseWorkspace) : undefined;
    if (hit) return { ok: true, numberId: hit.id, phoneNumber: hit.phone || null, via: "house" };
  }

  if (rows.length <= 1) return { ok: true, numberId: rows[0]?.id ?? null, phoneNumber: rows[0]?.phone || null, via: "only" };
  return { ok: false, reason: "work_line_ambiguous" };
}
