import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The ONE answer to "may this viewer see this conversation" in manager
 * Communication — email threads, SMS conversations, the houses picker, the
 * reply / send paths and the assistant's inbox tools all ask here.
 *
 * Three rules, in this order:
 *
 *  1. A PropLane Assistant thread (`agent_notice`) belongs to ONE account. The
 *     viewer sees their own in every workspace and never anyone else's.
 *  2. Sharing is per HOUSE. A co-manager sees another owner's conversation
 *     only when it is about a house they hold Communication on at the level
 *     asked for. A grant on one house never unlocks the owner's other houses,
 *     and a conversation about no house is never shared.
 *  3. The active workspace NARROWS. A conversation shows in the workspace that
 *     holds its house. A conversation about no house follows the LINE it went
 *     through: a text to a workspace's work number shows in that workspace
 *     (work numbers and work emails belong to a workspace, one each). Only
 *     when no line places it does it fall back to the viewer's own default
 *     workspace (the rule account-level rows already follow), visible when
 *     that workspace is active or the account is not partitioned at all.
 *
 * Narrowing never widens: the workspace cookie is read on the server and the
 * grant is the authority. Every lookup here degrades SAFELY — a failed grant
 * read shares nothing, a failed workspace read narrows nothing — so a broken
 * dependency can hide a co-manager's rows but can never leak an owner's.
 */

export type CommunicationLevel = "read" | "edit" | "delete";

export type ConversationHouseRef = { propertyId: string; label: string };

export type CommunicationScope = {
  viewerId: string;
  level: CommunicationLevel;
  /** Owners whose rows the store query may fetch: the viewer plus every owner with ≥1 granted house at `level`. */
  ownerIds: string[];
  /** For each OTHER owner, the house ids the viewer holds Communication on at `level`. */
  grantedHousesByOwner: Map<string, Set<string>>;
  /** Houses in the active workspace; `null` when the account is not narrowing. */
  workspaceHouseIds: Set<string> | null;
  /** Whether a conversation about no house that the viewer OWNS shows in the active workspace. */
  untaggedOwnedVisible: boolean;
  /** The active workspace, when the account is partitioned; null = not narrowing. */
  activeWorkspaceId: string | null;
  /** The viewer's own work lines (phone digits / lower-cased address) → the workspace each belongs to. */
  workspaceByLine: Map<string, string>;
};

export type VisibilityInput = {
  ownerId: string | null | undefined;
  houseIds: readonly string[];
  /** `agent_notice` marks the assistant thread; the id prefix is accepted for older rows. */
  threadType?: string | null;
  threadId?: string | null;
  /**
   * The work lines this conversation went through — the number texted or the
   * address written to. Places a house-less thread in the workspace that holds
   * that line. Optional: a caller that cannot say passes nothing and the
   * default-workspace rule applies.
   */
  lines?: readonly string[];
};

const AGENT_NOTICE_PREFIX = "agent_notice_";

function clean(id: unknown): string {
  return typeof id === "string" ? id.trim() : "";
}

/** A phone as its 10 digits, an address lower-cased — the key both sides of a line lookup use. */
export function lineKey(raw: unknown): string {
  const value = clean(raw);
  if (!value) return "";
  if (value.includes("@")) return value.toLowerCase();
  const digits = value.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

/** The work address an email thread was written to, when the store stamped one (`row_data.workLine`). */
function threadWorkLines(rowData: unknown): string[] {
  if (!rowData || typeof rowData !== "object") return [];
  const line = (rowData as { workLine?: unknown }).workLine;
  return typeof line === "string" && line.trim() ? [line.trim()] : [];
}

/** The workspace a house-less conversation belongs to by the line it used, or null when no line places it. */
function workspaceForLines(scope: CommunicationScope, lines: readonly string[] | undefined): string | null {
  if (!lines || scope.workspaceByLine.size === 0) return null;
  for (const line of lines) {
    const found = scope.workspaceByLine.get(lineKey(line));
    if (found) return found;
  }
  return null;
}

/** Pure. Decides one conversation against a resolved scope. */
export function conversationVisible(scope: CommunicationScope, input: VisibilityInput): boolean {
  const ownerId = clean(input.ownerId);
  const threadId = clean(input.threadId);
  const houses = [...new Set(input.houseIds.map(clean).filter(Boolean))];
  const isAssistant =
    input.threadType === "agent_notice" || (threadId.length > 0 && threadId.startsWith(AGENT_NOTICE_PREFIX));
  if (isAssistant) return ownerId === scope.viewerId;

  const inWorkspace = (houseId: string) => scope.workspaceHouseIds === null || scope.workspaceHouseIds.has(houseId);

  // Own rows, and legacy owner-less rows the store query matched by the
  // viewer's email: house decides the workspace; no house means default only.
  if (!ownerId || ownerId === scope.viewerId) {
    if (houses.length === 0) {
      const lineWorkspace = workspaceForLines(scope, input.lines);
      if (lineWorkspace && scope.activeWorkspaceId) return lineWorkspace === scope.activeWorkspaceId;
      return scope.untaggedOwnedVisible;
    }
    return houses.some(inWorkspace);
  }

  // Another owner's row: the SAME house must be granted and in the workspace.
  const granted = scope.grantedHousesByOwner.get(ownerId);
  if (!granted || granted.size === 0 || houses.length === 0) return false;
  return houses.some((houseId) => granted.has(houseId) && inWorkspace(houseId));
}

async function readSelectedWorkspaceId(): Promise<string | undefined> {
  try {
    const { cookies } = await import("next/headers");
    const { WORKSPACE_COOKIE } = await import("@/lib/workspaces/types");
    return (await cookies()).get(WORKSPACE_COOKIE)?.value || undefined;
  } catch {
    // Outside a request (a webhook, a unit test): nothing selected, nothing narrowed.
    return undefined;
  }
}

/**
 * Resolve the viewer's Communication scope at `level`. `selectedWorkspaceId`
 * overrides the cookie for callers that hold the raw request (route tests);
 * pass `null` to skip workspace narrowing on purpose.
 */
export async function resolveCommunicationScope(
  db: SupabaseClient,
  viewerUserId: string,
  level: CommunicationLevel = "read",
  options: { selectedWorkspaceId?: string | null } = {},
): Promise<CommunicationScope> {
  const viewerId = clean(viewerUserId);
  const scope: CommunicationScope = {
    viewerId,
    level,
    ownerIds: viewerId ? [viewerId] : [],
    grantedHousesByOwner: new Map(),
    workspaceHouseIds: null,
    untaggedOwnedVisible: true,
    activeWorkspaceId: null,
    workspaceByLine: new Map(),
  };
  if (!viewerId) return scope;

  // Grants: a failure shares nothing.
  try {
    const { linkedOwnerScopeForModule } = await import("@/lib/auth/co-manager-module-scope");
    const linked = await linkedOwnerScopeForModule(
      db as Parameters<typeof linkedOwnerScopeForModule>[0],
      viewerId,
      "inbox",
      level,
    );
    for (const [ownerId, houses] of linked.propertyIdsByOwner) {
      const id = clean(ownerId);
      if (!id || id === viewerId || houses.size === 0) continue;
      scope.grantedHousesByOwner.set(id, new Set([...houses].map(clean).filter(Boolean)));
    }
    scope.ownerIds = [viewerId, ...scope.grantedHousesByOwner.keys()];
  } catch {
    scope.grantedHousesByOwner = new Map();
    scope.ownerIds = [viewerId];
  }

  // Workspace: a failure narrows nothing (the grant above is still the authority).
  if (options.selectedWorkspaceId === null) return scope;
  try {
    const { loadWorkspaces } = await import("@/lib/workspaces/server");
    const workspaces = await loadWorkspaces(db, viewerId);
    if (workspaces.length <= 1) return scope;
    const selected =
      options.selectedWorkspaceId !== undefined ? options.selectedWorkspaceId : await readSelectedWorkspaceId();
    const active = workspaces.find((w) => w.id === selected) ?? workspaces[0];
    if (!active) return scope;
    scope.workspaceHouseIds = new Set(active.propertyIds.map(clean).filter(Boolean));
    scope.untaggedOwnedVisible = active.owned && active.isDefault;
    scope.activeWorkspaceId = active.id;
    // The viewer's own lines, one per owned workspace. A failure here leaves
    // the map empty, which is the default-workspace rule — never wider.
    const ownedIds = workspaces.filter((w) => w.owned).map((w) => w.id);
    if (ownedIds.length > 0) {
      const [numbers, emails] = await Promise.all([
        db.from("manager_sms_numbers").select("workspace_id, phone_number").in("workspace_id", ownedIds),
        db.from("manager_assistant_emails").select("workspace_id, inbox_token, mailbox_local, provision_state").in("workspace_id", ownedIds),
      ]);
      for (const row of numbers.data ?? []) {
        const key = lineKey(row.phone_number);
        const ws = clean(row.workspace_id);
        if (key && ws) scope.workspaceByLine.set(key, ws);
      }
      const { assistantEmailAddress, assistantMailboxAddress } = await import("@/lib/manager-assistant-email/assistant-email-address");
      for (const row of emails.data ?? []) {
        if (row.provision_state !== "active") continue;
        const ws = clean(row.workspace_id);
        if (!ws) continue;
        const local = clean(row.mailbox_local);
        const token = clean(row.inbox_token);
        if (local) scope.workspaceByLine.set(lineKey(assistantMailboxAddress(local)), ws);
        if (token) scope.workspaceByLine.set(lineKey(assistantEmailAddress(token)), ws);
      }
    }
  } catch {
    scope.workspaceHouseIds = null;
    scope.untaggedOwnedVisible = true;
    scope.activeWorkspaceId = null;
    scope.workspaceByLine = new Map();
  }
  return scope;
}

export type StoredInboxThreadRecord = {
  id: string;
  owner_user_id: string | null;
  participant_email: string | null;
  thread_type?: string | null;
  row_data: unknown;
};

type HouseLabelMap = Map<string, { label: string; ownerUserId: string; aliases: string[] }>;

/** Application scan page size and ceiling — the same bounds the SMS resident scan uses. */
const PERSON_SCAN_PAGE = 1000;
const PERSON_SCAN_MAX_ROWS = 20000;

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * The houses each person (by email) has an application or residency on, per
 * owner — the source the SMS `residency` tag already trusts. Every house is
 * kept (a person on two houses is shown under both); nothing is guessed from
 * message text.
 */
async function loadPersonHousesByOwner(
  db: SupabaseClient,
  ownerIds: string[],
  houseLabels: HouseLabelMap,
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const owners = [...new Set(ownerIds.map(clean).filter(Boolean))];
  if (owners.length === 0) return out;
  const idByOwnerAndLabel = new Map<string, string>();
  for (const [id, house] of houseLabels) {
    // One house may list its own label as an alias; only ANOTHER house on the
    // same name is ambiguous, and an ambiguous match is worse than none.
    for (const alias of new Set([house.label.trim().toLowerCase(), ...house.aliases.map((a) => a.trim().toLowerCase())])) {
      if (!alias) continue;
      const key = `${house.ownerUserId}\u0000${alias}`;
      const current = idByOwnerAndLabel.get(key);
      if (current === undefined) idByOwnerAndLabel.set(key, id);
      else if (current !== id) idByOwnerAndLabel.set(key, "");
    }
  }
  try {
    for (let from = 0; from < PERSON_SCAN_MAX_ROWS; from += PERSON_SCAN_PAGE) {
      const { data, error } = await db
        .from("manager_application_records")
        .select("manager_user_id, resident_email, row_data")
        .in("manager_user_id", owners)
        .order("id", { ascending: true })
        .range(from, from + PERSON_SCAN_PAGE - 1);
      if (error) break;
      const rows = (data ?? []) as { manager_user_id?: unknown; resident_email?: unknown; row_data?: unknown }[];
      for (const row of rows) {
        const ownerId = clean(row.manager_user_id);
        const email = normalizeEmail(row.resident_email);
        if (!ownerId || !email.includes("@")) continue;
        const rd = (row.row_data && typeof row.row_data === "object" ? row.row_data : {}) as {
          bucket?: unknown;
          stage?: unknown;
          property?: unknown;
          propertyId?: unknown;
        };
        const bucket = clean(rd.bucket);
        if (bucket !== "approved" && bucket !== "pending") continue;
        if (bucket === "pending" && clean(rd.stage).toLowerCase() === "in progress") continue;
        const explicit = clean(rd.propertyId);
        const label = clean(rd.property).toLowerCase();
        const houseId = explicit || (label ? idByOwnerAndLabel.get(`${ownerId} ${label}`) ?? "" : "");
        if (!houseId) continue;
        const key = `${ownerId} ${email}`;
        const set = out.get(key) ?? new Set<string>();
        set.add(houseId);
        out.set(key, set);
      }
      if (rows.length < PERSON_SCAN_PAGE) break;
    }
  } catch {
    // A failed scan leaves the affected threads untagged — never shared, owner-default only.
  }
  return out;
}

/**
 * The house(s) each email thread is about: the stamped `propertyId` when the
 * writer set one (tours, applications, listing inquiries, property threads),
 * else the counterparty's own applications and residency with that owner.
 */
export async function emailThreadHouses(
  db: SupabaseClient,
  records: readonly StoredInboxThreadRecord[],
  houseLabels: HouseLabelMap,
): Promise<Map<string, ConversationHouseRef[]>> {
  const out = new Map<string, ConversationHouseRef[]>();
  const needPerson: StoredInboxThreadRecord[] = [];
  for (const record of records) {
    const rd = (record.row_data && typeof record.row_data === "object" ? record.row_data : {}) as Record<string, unknown>;
    const explicit = clean(rd.propertyId) || clean(rd.assignedPropertyId);
    if (explicit) {
      out.set(record.id, [{ propertyId: explicit, label: houseLabels.get(explicit)?.label ?? (clean(rd.propertyTitle) || explicit) }]);
      continue;
    }
    needPerson.push(record);
  }
  if (needPerson.length === 0) return out;
  const owners = [...new Set(needPerson.map((r) => clean(r.owner_user_id)).filter(Boolean))];
  const personHouses = await loadPersonHousesByOwner(db, owners, houseLabels);
  for (const record of needPerson) {
    const rd = (record.row_data && typeof record.row_data === "object" ? record.row_data : {}) as Record<string, unknown>;
    const ownerId = clean(record.owner_user_id);
    const email = normalizeEmail(record.participant_email) || normalizeEmail(rd.email);
    const houses = ownerId && email ? personHouses.get(`${ownerId} ${email}`) : undefined;
    out.set(
      record.id,
      houses ? [...houses].map((id) => ({ propertyId: id, label: houseLabels.get(id)?.label ?? id })) : [],
    );
  }
  return out;
}

async function loadHouseLabelsSafely(db: SupabaseClient, ownerIds: string[]): Promise<HouseLabelMap> {
  try {
    const { loadWorkspaceHouseLabels } = await import("@/lib/manager-sms-messages.server");
    return await loadWorkspaceHouseLabels(db, ownerIds);
  } catch {
    return new Map();
  }
}

/**
 * Keep only the email thread records the scope allows, each stamped with the
 * houses it is about (for the list's house label). Rows the store query
 * matched on ownership still have to pass the house and workspace rules here.
 */
export async function filterVisibleInboxThreadRecords<T extends StoredInboxThreadRecord>(
  db: SupabaseClient,
  scope: CommunicationScope,
  records: readonly T[],
): Promise<(T & { houses: ConversationHouseRef[] })[]> {
  if (records.length === 0) return [];
  const houseLabels = await loadHouseLabelsSafely(db, scope.ownerIds);
  const housesById = await emailThreadHouses(db, records, houseLabels);
  const visible: (T & { houses: ConversationHouseRef[] })[] = [];
  for (const record of records) {
    const houses = housesById.get(record.id) ?? [];
    if (
      conversationVisible(scope, {
        ownerId: record.owner_user_id,
        houseIds: houses.map((h) => h.propertyId),
        threadType: record.thread_type ?? null,
        threadId: record.id,
        lines: threadWorkLines(record.row_data),
      })
    ) {
      visible.push({ ...record, houses });
    }
  }
  return visible;
}

/** One stored thread, checked at `level`. `null` when the viewer may not see it. */
export async function visibleInboxThreadRecord<T extends StoredInboxThreadRecord>(
  db: SupabaseClient,
  viewerUserId: string,
  level: CommunicationLevel,
  record: T,
): Promise<(T & { houses: ConversationHouseRef[] }) | null> {
  const scope = await resolveCommunicationScope(db, viewerUserId, level);
  const [visible] = await filterVisibleInboxThreadRecords(db, scope, [record]);
  return visible ?? null;
}
