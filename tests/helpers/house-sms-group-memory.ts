import { vi } from "vitest";
import { emptySmsGroupState, type SmsGroupState } from "@/lib/house-sms-group/model";

/** In-memory stand-in for the house chat rows that hold `row_data.smsGroup`. */
export type Memory = {
  states: Map<string, SmsGroupState | null>;
  threads: Map<string, { propertyId: string; workspaceId: string }>;
};

export function newMemory(): Memory {
  return { states: new Map(), threads: new Map() };
}

export const OWNER = "owner-1";
export const WS = "ws-1";
export const HOUSE = "prop-1";
export const threadId = (property = HOUSE) => `house-thread:${OWNER}:ws:${WS}:prop:${property}`;

/** The functions `store.server.ts` exports, over `memory`. */
export function storeOver(getMemory: () => Memory) {
  const m = () => getMemory();
  return {
    threadIdFor: (i: { ownerUserId: string; workspaceId: string; propertyId: string }) => `house-thread:${i.ownerUserId}:ws:${i.workspaceId}:prop:${i.propertyId}`,
    ensureHouseThread: vi.fn(async (_db: unknown, i: { ownerUserId: string; workspaceId: string; propertyId: string }) => {
      const id = `house-thread:${i.ownerUserId}:ws:${i.workspaceId}:prop:${i.propertyId}`;
      m().threads.set(id, { propertyId: i.propertyId, workspaceId: i.workspaceId });
      if (!m().states.has(id)) m().states.set(id, null);
      return id;
    }),
    loadHouseThread: vi.fn(),
    loadHouseSmsGroup: vi.fn(async (_db: unknown, id: string) => (m().threads.has(id) || m().states.get(id) ? { stored: { id, rowData: {}, ownerUserId: OWNER, workspaceId: WS, updatedAt: null }, state: m().states.get(id) ?? null } : null)),
    saveSmsGroupState: vi.fn(async (_db: unknown, id: string, change: (c: SmsGroupState | null) => SmsGroupState | null) => {
      const next = change(m().states.get(id) ?? null);
      if (next) m().states.set(id, next);
      return true;
    }),
    listWorkspaceSmsGroups: vi.fn(async (_db: unknown, workspaceId: string) =>
      [...m().states.entries()]
        .filter(([id, state]) => state && m().threads.get(id)?.workspaceId === workspaceId)
        .map(([id, state]) => ({ threadId: id, propertyId: m().threads.get(id)!.propertyId, state: state! })),
    ),
    findThreadByConversationSid: vi.fn(),
  };
}

export { emptySmsGroupState };
