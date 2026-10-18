import { normalizeE164, phoneKey } from "./phones.mjs";

/**
 * Pure planning for the workspace stamp backfill: which workspace does an unstamped SMS row belong to.
 *
 * The rule is the one the database triggers already apply to new rows (supabase/migrations/
 * 20261018110000_one_number_transport.sql): the row's own work line decides, then the owner's default
 * workspace. Two guards make it safe to run on live data:
 *   1. A row is only ever stamped with a workspace its OWN owner holds. A number shared into another
 *      owner's workspace never moves a row across owners.
 *   2. Only rows whose workspace_id is NULL are touched (the writer repeats `is null` in the update).
 */

export function buildWorkspaceIndex({ workspaces = [], numbers = [], links = [] }) {
  const byOwner = new Map();
  const byId = new Map();
  for (const ws of workspaces) {
    byId.set(ws.id, ws);
    const list = byOwner.get(ws.owner_user_id) ?? [];
    list.push(ws);
    byOwner.set(ws.owner_user_id, list);
  }
  for (const list of byOwner.values()) {
    list.sort((a, b) => {
      if (Boolean(a.is_default) !== Boolean(b.is_default)) return a.is_default ? -1 : 1;
      return String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) || String(a.id).localeCompare(String(b.id));
    });
  }
  const numberById = new Map(numbers.map((n) => [n.id, n]));
  const numbersByKey = new Map();
  for (const n of numbers) {
    const key = phoneKey(n.phone_number);
    if (!key) continue;
    const list = numbersByKey.get(key) ?? [];
    list.push(n);
    numbersByKey.set(key, list);
  }
  const linksByNumber = new Map();
  for (const link of links) {
    const list = linksByNumber.get(link.number_id) ?? [];
    list.push(link);
    linksByNumber.set(link.number_id, list);
  }
  const owns = (owner, workspaceId) => Boolean(workspaceId) && byId.get(workspaceId)?.owner_user_id === owner;

  /** The workspace `owner` holds that this number serves: its home workspace, else a linked one (primary first). */
  function workspaceForNumber(owner, number) {
    if (!number) return null;
    if (owns(owner, number.workspace_id)) return number.workspace_id;
    const linked = (linksByNumber.get(number.id) ?? [])
      .filter((link) => owns(owner, link.workspace_id))
      .sort((a, b) => Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary)));
    return linked[0]?.workspace_id ?? null;
  }

  return {
    owns,
    ownerDefault: (owner) => byOwner.get(owner)?.[0]?.id ?? null,
    workspaceCount: (owner) => byOwner.get(owner)?.length ?? 0,
    workspaceForNumberId(owner, numberId) {
      return workspaceForNumber(owner, numberById.get(numberId));
    },
    /** A number row for `phone` that belongs to `owner` (its own line), else any with that phone the owner can use. */
    workspaceForPhone(owner, phone) {
      const key = phoneKey(phone);
      if (!key) return null;
      const candidates = numbersByKey.get(key) ?? [];
      const own = candidates.filter((n) => n.manager_user_id === owner);
      for (const n of own.length ? own : candidates) {
        const ws = workspaceForNumber(owner, n);
        if (ws) return ws;
      }
      return null;
    },
  };
}

function payloadOf(row) {
  const p = row.inbound_payload;
  return p && typeof p === "object" ? p : {};
}

/**
 * Each entry: the table, its paging key, the columns to read, the owner column, and `derive(row, ctx)`
 * returning `{ workspaceId, rule }` (workspaceId null = could not decide).
 */
export const STAMP_TABLES = [
  {
    table: "sms_projection_turns",
    key: "id",
    owner: "owner_manager_user_id",
    select: "id, owner_manager_user_id, conversation_id",
    derive(row, ctx) {
      const owner = row.owner_manager_user_id;
      const conv = ctx.conversations.get(row.conversation_id);
      if (conv) {
        if (ctx.index.owns(owner, conv.workspace_id)) return { workspaceId: conv.workspace_id, rule: "conversation" };
        const viaLine = ctx.index.workspaceForNumberId(owner, conv.work_line_id);
        if (viaLine) return { workspaceId: viaLine, rule: "work_line" };
        if (ctx.index.owns(owner, conv.work_line_id)) return { workspaceId: conv.work_line_id, rule: "shared_line" };
      }
      return { workspaceId: ctx.index.ownerDefault(owner), rule: "owner_default" };
    },
  },
  {
    table: "sms_outbox",
    key: "id",
    owner: "manager_user_id",
    select: "id, manager_user_id, selected_work_line_id, provider_from_phone, transport_from_number",
    derive(row, ctx) {
      const owner = row.manager_user_id;
      const viaLine = row.selected_work_line_id ? ctx.index.workspaceForNumberId(owner, row.selected_work_line_id) : null;
      if (viaLine) return { workspaceId: viaLine, rule: "work_line" };
      for (const phone of [row.provider_from_phone, row.transport_from_number]) {
        const viaPhone = phone ? ctx.index.workspaceForPhone(owner, phone) : null;
        if (viaPhone) return { workspaceId: viaPhone, rule: "from_number" };
      }
      return { workspaceId: ctx.index.ownerDefault(owner), rule: "owner_default" };
    },
  },
  {
    table: "sms_inbound_receipts",
    key: "message_sid",
    owner: "manager_user_id",
    select: "message_sid, manager_user_id, inbound_payload",
    derive(row, ctx) {
      const owner = row.manager_user_id;
      const payload = payloadOf(row);
      const stamped = typeof payload.workspaceId === "string" ? payload.workspaceId.trim() : "";
      if (stamped && ctx.index.owns(owner, stamped)) return { workspaceId: stamped, rule: "payload" };
      const viaPhone = payload.toPhone ? ctx.index.workspaceForPhone(owner, payload.toPhone) : null;
      if (viaPhone) return { workspaceId: viaPhone, rule: "to_number" };
      return { workspaceId: ctx.index.ownerDefault(owner), rule: "owner_default" };
    },
  },
  {
    table: "manager_sms_messages",
    key: "id",
    owner: "manager_user_id",
    select: "id, manager_user_id, direction, from_phone, to_phone, resident_phone",
    derive(row, ctx) {
      const owner = row.manager_user_id;
      const workPhone = row.direction === "inbound" ? row.to_phone : row.from_phone;
      const viaPhone = workPhone ? ctx.index.workspaceForPhone(owner, workPhone) : null;
      if (viaPhone) return { workspaceId: viaPhone, rule: "work_number" };
      return { workspaceId: ctx.index.ownerDefault(owner), rule: "owner_default" };
    },
  },
  {
    table: "inbound_sms_log",
    key: "id",
    owner: "manager_user_id",
    select: "id, manager_user_id, to_phone",
    derive(row, ctx) {
      const owner = row.manager_user_id;
      const viaPhone = row.to_phone ? ctx.index.workspaceForPhone(owner, row.to_phone) : null;
      if (viaPhone) return { workspaceId: viaPhone, rule: "work_number" };
      return { workspaceId: ctx.index.ownerDefault(owner), rule: "owner_default" };
    },
  },
  {
    table: "manager_sms_contacts",
    key: "id",
    owner: "manager_user_id",
    select: "id, manager_user_id, phone_e164",
    derive(row, ctx) {
      const owner = row.manager_user_id;
      const seen = ctx.contactWorkspace.get(`${owner}|${phoneKey(row.phone_e164)}`);
      if (seen && ctx.index.owns(owner, seen)) return { workspaceId: seen, rule: "thread_messages" };
      return { workspaceId: ctx.index.ownerDefault(owner), rule: "owner_default" };
    },
  },
];

/** Plan the stamps for one table's unstamped rows. */
export function planStamps(spec, rows, ctx) {
  const updates = [];
  const skipped = [];
  const rules = {};
  for (const row of rows) {
    const owner = row[spec.owner];
    if (!owner) {
      skipped.push({ key: row[spec.key], reason: "no_owner" });
      continue;
    }
    const { workspaceId, rule } = spec.derive(row, ctx);
    if (!workspaceId || !ctx.index.owns(owner, workspaceId)) {
      skipped.push({ key: row[spec.key], reason: "owner_has_no_workspace" });
      continue;
    }
    rules[rule] = (rules[rule] ?? 0) + 1;
    updates.push({ key: row[spec.key], workspaceId, rule });
  }
  return { updates, skipped, rules };
}

/** (owner, contact phone key) -> the workspace of an already-stamped message with that contact. */
export function contactWorkspaceMap(stampedMessages) {
  const map = new Map();
  for (const m of stampedMessages) {
    if (!m.workspace_id || !m.manager_user_id) continue;
    const key = `${m.manager_user_id}|${phoneKey(m.resident_phone)}`;
    if (!map.has(key)) map.set(key, m.workspace_id);
  }
  return map;
}

export { normalizeE164 };
