import { groupFakeDb, type GroupFakeDb, type GroupRow } from "./house-group-fake-db";
import type { OccupancyStayLike } from "@/lib/house-groups/stay-members";

export const WS = "ws-1";
export const OWNER = "owner-1";
export const HOUSE = "prop-a";
export const OTHER_HOUSE = "prop-b";
export const MANAGER_SCOPE = "axis_portal_inbox_manager_v1";
export const RESIDENT_SCOPE = "axis_portal_inbox_resident_v1";
/** Noon Pacific on 2026-10-20 (PDT). */
export const NOON = new Date("2026-10-20T19:00:00Z");
export const TODAY = "2026-10-20";

type Args = Record<string, unknown>;
type Rows = Record<string, GroupRow[]>;

/** The two database functions the house chat leans on, as plain row operations. */
export const HOUSE_CHAT_RPC = {
  resolve_or_create_conversation: (args: Args, rows: Rows) => {
    const list = (rows.portal_inbox_thread_records ??= []);
    const keys = args.p_keys as string[];
    const hit = list.find(
      (r) => r.scope === args.p_scope && r.workspace_id === args.p_workspace && r.owner_user_id === args.p_owner && keys.includes(String(r.conversation_key)),
    );
    if (hit) return { data: { id: hit.id, created: false }, error: null };
    list.push({
      id: args.p_thread_id,
      scope: args.p_scope,
      owner_user_id: args.p_owner,
      participant_email: args.p_participant_email ?? null,
      thread_type: args.p_thread_type,
      row_data: args.p_row_data,
      conversation_key: keys[0],
      workspace_id: args.p_workspace,
      updated_at: new Date().toISOString(),
    });
    return { data: { id: args.p_thread_id, created: true }, error: null };
  },
  change_portal_inbox_thread_folders: (args: Args, rows: Rows) => {
    const ids = args.p_ids as string[];
    const list = (rows.portal_inbox_thread_records ??= []).filter((r) => ids.includes(String(r.id)) && r.scope === args.p_scope);
    if (list.length !== ids.length) return { data: "stale", error: null };
    for (const row of list) {
      const data = row.row_data as Record<string, unknown>;
      if (data.folder === "trash") continue;
      row.row_data = { ...data, folder: "trash", previousFolder: data.folder === "sent" ? "sent" : "inbox", unread: false };
      row.updated_at = new Date().toISOString();
    }
    return { data: "ok", error: null };
  },
};

export function chatDb(over: Rows = {}): GroupFakeDb {
  return groupFakeDb(
    {
      portal_workspaces: [{ id: WS, owner_user_id: OWNER, name: "Seattle Homes", is_default: true }],
      manager_property_records: [
        { id: HOUSE, workspace_id: WS, manager_user_id: OWNER, row_data: { buildingName: "12 Pine St" } },
        { id: OTHER_HOUSE, workspace_id: WS, manager_user_id: OWNER, row_data: { buildingName: "9 Oak Ave" } },
      ],
      ...over,
    },
    { rpc: HOUSE_CHAT_RPC },
  );
}

export function leaseStay(email: string, name: string, over: Partial<OccupancyStayLike> = {}): OccupancyStayLike {
  return {
    propertyId: HOUSE,
    roomLabel: "Room 1",
    start: "2026-06-01",
    end: "2027-05-31",
    resident: { source: "proplane", residentName: name, residentEmail: email },
    ...over,
  };
}

export function threadRows(db: GroupFakeDb): GroupRow[] {
  return db.rows.portal_inbox_thread_records ?? [];
}

export function oneOnOne(id: string, scope: string, owner: string, key: string, over: Record<string, unknown> = {}): GroupRow {
  return {
    id,
    scope,
    owner_user_id: owner,
    participant_email: null,
    thread_type: "portal_message",
    conversation_key: key,
    workspace_id: WS,
    row_data: { id, folder: "inbox", from: "Resident", email: "", subject: "Hi", preview: "hi", unread: false, messages: [], ...over },
    updated_at: "2026-10-01T00:00:00.000Z",
  };
}
