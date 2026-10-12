/**
 * Pure planners for scripts/backfill-thread-workspaces.mjs (workspace comms
 * isolation, Oct 12 2026). No I/O: the script loads rows, these decide.
 *
 *   planThreadWorkspaceBackfill      which manager-scope inbox threads get which workspace
 *   planProjectionWorkspaceBackfill  the same for SMS projection conversations
 *   workIdentityReport               one number + one email per workspace, read-only
 */

export const MANAGER_INBOX_SCOPE = "axis_portal_inbox_manager_v1";

const clean = (value) => (typeof value === "string" ? value.trim() : "");

/** A phone as its 10 digits, an address lower-cased: the key a work line is looked up by. */
export function lineKey(raw) {
  const value = clean(raw);
  if (!value) return "";
  if (value.includes("@")) return value.toLowerCase();
  const digits = value.replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

/** The houses a stored thread names (same rule as `threadHouseIds` in conversation-house-filter.ts). */
export function threadHouseIdsOf(rowData) {
  if (!rowData || typeof rowData !== "object") return [];
  const out = new Set();
  const keyed = clean(rowData.conversationKey) !== "";
  const root = clean(rowData.rootHouseId);
  if (root) out.add(root);
  if (!keyed) {
    const legacy = clean(rowData.propertyId) || clean(rowData.assignedPropertyId);
    if (legacy) out.add(legacy);
  }
  const messages = Array.isArray(rowData.messages) ? rowData.messages : [];
  for (const message of messages) {
    const house = clean(message?.houseId);
    if (house) out.add(house);
  }
  return [...out];
}

/** Every property id the candidate threads reference (the script loads their workspaces). */
export function referencedHouseIds(threads) {
  const ids = new Set();
  for (const thread of threads) for (const id of threadHouseIdsOf(thread.row_data)) ids.add(id);
  return [...ids];
}

const conversationSlot = (ownerId, workspaceId, scope, key) => `${ownerId}|${workspaceId}|${scope}|${key}`;

/** The unique-index tuple of a row that is ALREADY stamped and keyed (the loader passes these in). */
export function existingConversationSlots(rows) {
  const slots = new Set();
  for (const row of rows) {
    const key = clean(row.conversation_key);
    const owner = clean(row.owner_user_id);
    const workspace = clean(row.workspace_id);
    if (key && owner && workspace) slots.add(conversationSlot(owner, workspace, clean(row.scope) || MANAGER_INBOX_SCOPE, key));
  }
  return slots;
}

/**
 * Which manager-scope thread gets which workspace. A thread with `workspace_id`
 * or `test_workspace_id` already set is never touched. Order of evidence:
 *
 *   1. the workspace of the house the thread names;
 *   2. the workspace of the work line (`row_data.workLine`);
 *   3. the owner's default workspace.
 *
 * Skipped and reported instead of guessed: a thread whose houses sit in
 * different workspaces (`ambiguous_houses`), an owner with no default workspace
 * (`no_workspace`), a row with no owner (`no_owner`), and a stamp that would
 * land on an occupied (owner, workspace, scope, conversation_key) slot of the
 * unique index (`collision`).
 *
 * @param {object} input
 * @param {Array} input.threads rows: id, scope, owner_user_id, conversation_key, workspace_id, test_workspace_id, row_data
 * @param {Map<string,string|null>} input.houseWorkspaceById property id -> its workspace
 * @param {Map<string,string>} input.workspaceByLine lineKey -> workspace
 * @param {Map<string,string>} input.defaultWorkspaceByOwner owner -> default workspace id
 * @param {Set<string>} [input.occupiedSlots] from existingConversationSlots
 */
export function planThreadWorkspaceBackfill({
  threads,
  houseWorkspaceById = new Map(),
  workspaceByLine = new Map(),
  defaultWorkspaceByOwner = new Map(),
  occupiedSlots = new Set(),
}) {
  const stamps = [];
  const skipped = [];
  const taken = new Set(occupiedSlots);
  let ignored = 0;
  for (const thread of threads) {
    if (thread.scope !== MANAGER_INBOX_SCOPE || clean(thread.workspace_id) || clean(thread.test_workspace_id)) {
      ignored += 1;
      continue;
    }
    const owner = clean(thread.owner_user_id);
    if (!owner) {
      skipped.push({ id: thread.id, reason: "no_owner" });
      continue;
    }
    const houseWorkspaces = new Set();
    for (const house of threadHouseIdsOf(thread.row_data)) {
      const workspace = clean(houseWorkspaceById.get(house));
      if (workspace) houseWorkspaces.add(workspace);
    }
    let workspaceId = "";
    let via = "";
    if (houseWorkspaces.size > 1) {
      skipped.push({ id: thread.id, reason: "ambiguous_houses", workspaces: [...houseWorkspaces] });
      continue;
    }
    if (houseWorkspaces.size === 1) {
      workspaceId = [...houseWorkspaces][0];
      via = "house";
    } else {
      const line = lineKey(thread.row_data?.workLine);
      const lineWorkspace = line ? clean(workspaceByLine.get(line)) : "";
      if (lineWorkspace) {
        workspaceId = lineWorkspace;
        via = "line";
      } else {
        workspaceId = clean(defaultWorkspaceByOwner.get(owner));
        via = "default";
      }
    }
    if (!workspaceId) {
      skipped.push({ id: thread.id, reason: "no_workspace" });
      continue;
    }
    const key = clean(thread.conversation_key);
    if (key) {
      const slot = conversationSlot(owner, workspaceId, thread.scope, key);
      if (taken.has(slot)) {
        skipped.push({ id: thread.id, reason: "collision", workspaceId });
        continue;
      }
      taken.add(slot);
    }
    stamps.push({ id: thread.id, ownerUserId: owner, workspaceId, via, conversationKey: key || null });
  }
  const byVia = { house: 0, line: 0, default: 0 };
  for (const stamp of stamps) byVia[stamp.via] += 1;
  return { stamps, skipped, byVia, ignored };
}

/**
 * The same for SMS projection conversations: the workspace of the work line's
 * number row, else the owner's default workspace. The index on
 * (owner, workspace, conversation_key) is not unique, so nothing collides.
 *
 * @param {Array} input.rows id, owner_manager_user_id, work_line_id, workspace_id
 * @param {Map<string,string|null>} input.numberWorkspaceById manager_sms_numbers.id -> workspace_id
 */
export function planProjectionWorkspaceBackfill({ rows, numberWorkspaceById = new Map(), defaultWorkspaceByOwner = new Map() }) {
  const stamps = [];
  const skipped = [];
  const byVia = { line: 0, default: 0 };
  for (const row of rows) {
    if (clean(row.workspace_id)) continue;
    const owner = clean(row.owner_manager_user_id);
    const lineWorkspace = clean(numberWorkspaceById.get(clean(row.work_line_id)));
    const workspaceId = lineWorkspace || clean(defaultWorkspaceByOwner.get(owner));
    if (!workspaceId) {
      skipped.push({ id: row.id, reason: "no_workspace" });
      continue;
    }
    const via = lineWorkspace ? "line" : "default";
    byVia[via] += 1;
    stamps.push({ id: row.id, ownerUserId: owner, workspaceId, via });
  }
  return { stamps, skipped, byVia };
}

/**
 * One work number and one work email per workspace, read-only. A number is live
 * when it is not released; an email is live when its state is `active`. Rows
 * with no workspace are reported as unplaced; a workspace holding more than one
 * live number or email is flagged. Nothing here is ever changed by the script.
 *
 * @param {object} input
 * @param {Array} input.workspaces id, owner_user_id, name
 * @param {Array} input.numbers id, workspace_id, manager_user_id, provision_state, released_at
 * @param {Array} input.emails id, workspace_id, manager_user_id, provision_state
 */
export function workIdentityReport({ workspaces, numbers, emails }) {
  const liveNumber = (row) => !row.released_at && row.provision_state !== "released";
  const liveEmail = (row) => row.provision_state === "active";
  const perWorkspace = new Map(
    workspaces.map((w) => [w.id, { workspaceId: w.id, name: w.name ?? null, ownerUserId: w.owner_user_id ?? null, liveNumbers: 0, activeEmails: 0 }]),
  );
  const unplacedNumbers = [];
  const unplacedEmails = [];
  const unknownWorkspaceRows = [];
  const bump = (row, field, list, live) => {
    if (!live(row)) return;
    const id = clean(row.workspace_id);
    if (!id) {
      list.push(row.id);
      return;
    }
    const entry = perWorkspace.get(id);
    if (!entry) {
      unknownWorkspaceRows.push({ id: row.id, workspaceId: id });
      return;
    }
    entry[field] += 1;
  };
  for (const row of numbers) bump(row, "liveNumbers", unplacedNumbers, liveNumber);
  for (const row of emails) bump(row, "activeEmails", unplacedEmails, liveEmail);
  const rows = [...perWorkspace.values()];
  const multiple = rows.filter((entry) => entry.liveNumbers > 1 || entry.activeEmails > 1);
  return { rows, unplacedNumbers, unplacedEmails, unknownWorkspaceRows, multiple };
}
