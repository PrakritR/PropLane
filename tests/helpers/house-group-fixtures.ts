import { vi } from "vitest";
import type { ConversationsGateway, ResidentCandidate } from "@/lib/house-groups/types";
import { GROUP_CONSTRAINTS, groupFakeDb, type GroupFakeDb, type GroupRow } from "./house-group-fake-db";

export const WS = "ws-1";
export const OWNER = "owner-1";
export const HOUSE = "prop-1";
export const SHARED = "+12065550100";
/** Noon Pacific (PDT). */
export const NOON = new Date("2026-10-18T19:00:00Z");
/** Midnight Pacific. */
export const MIDNIGHT = new Date("2026-10-19T07:00:00Z");

export function seedRows(over: Record<string, GroupRow[]> = {}): Record<string, GroupRow[]> {
  return {
    sms_runtime_config: [{ singleton: true, line_mode: "shared", shared_number_e164: SHARED, shared_pilot_workspace_ids: [] }],
    portal_workspaces: [{ id: WS, owner_user_id: OWNER, name: "Seattle Homes", is_default: true }],
    manager_property_records: [{ id: HOUSE, workspace_id: WS, manager_user_id: OWNER, row_data: { buildingName: "5259 Brooklyn" } }],
    house_group_settings: [{ workspace_id: WS, enabled: true, max_posts_per_day: 4 }],
    ...over,
  };
}

export function fakeDb(over: Record<string, GroupRow[]> = {}): GroupFakeDb {
  return groupFakeDb(seedRows(over), { constraints: GROUP_CONSTRAINTS });
}

export type FakeGateway = ConversationsGateway & {
  calls: { fn: string; args: unknown[] }[];
  posted: { conversationSid: string; body: string }[];
};

/** A recording stand-in for Twilio Conversations. `fail` names a call that throws. */
export function fakeGateway(opts: { fail?: keyof ConversationsGateway } = {}): FakeGateway {
  const calls: FakeGateway["calls"] = [];
  const posted: FakeGateway["posted"] = [];
  let n = 0;
  const wrap =
    <T extends (...a: never[]) => Promise<unknown>>(fn: keyof ConversationsGateway, impl: T) =>
    async (...args: Parameters<T>) => {
      calls.push({ fn, args });
      if (opts.fail === fn) throw new Error(`${fn} failed`);
      return impl(...args);
    };
  return {
    calls,
    posted,
    createConversation: wrap("createConversation", async () => ({ sid: `CH${String(++n).padStart(32, "0")}` })),
    watchConversation: wrap("watchConversation", async () => undefined),
    addResident: wrap("addResident", async () => ({ participantSid: `MB${String(++n).padStart(32, "0")}` })),
    addProplane: wrap("addProplane", async () => undefined),
    postMessage: wrap("postMessage", async (conversationSid: string, body: string) => {
      posted.push({ conversationSid, body });
      return { messageSid: `IM${String(++n).padStart(32, "0")}` };
    }),
    closeConversation: wrap("closeConversation", async () => undefined),
  } as FakeGateway;
}

export function resident(n: number, over: Partial<ResidentCandidate> = {}): ResidentCandidate {
  const key = `20655501${String(n).padStart(2, "0")}`;
  return {
    phoneKey: key,
    phoneE164: `+1${key}`,
    userId: `user-${n}`,
    firstName: ["Maya", "Sam", "Lee", "Kim", "Ana", "Raj", "Zoe", "Ian", "Eli", "Ora", "Pat", "Tom"][n - 1] ?? `Res${n}`,
    roomLabel: `Room ${n}`,
    moveIn: `2026-01-${String(n).padStart(2, "0")}`,
    longTerm: true,
    verifiedPhone: true,
    consented: true,
    optedOut: false,
    stopped: false,
    ...over,
  };
}

export const noShield = async () => false;

export function mockCredit() {
  return {
    reserveCommsCredit: vi.fn(async () => ({ allowed: true as const, duplicate: false, state: "reserved" as const })),
    finishCommsCredit: vi.fn(async () => undefined),
  };
}
