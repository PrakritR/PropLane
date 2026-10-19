// The RA looks up house details for a group member on the resident assistant's own terms:
// a member whose move-in details are still locked (or whose lock cannot be read) gets no house info.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, fakeGateway, HOUSE, NOON, noShield, WS } from "../helpers/house-group-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
vi.mock("@/lib/comms-billing/wallet.server", () => ({
  reserveCommsCredit: vi.fn(async () => ({ allowed: true, duplicate: false, state: "reserved" })),
  finishCommsCredit: vi.fn(async () => undefined),
}));

const seen = vi.hoisted(() => ({ scopes: [] as Array<{ includeHouseInfo: boolean }>, lock: { moveInDetailsLocked: true } as { moveInDetailsLocked: boolean }, throwLock: false }));
vi.mock("@/lib/one-number/knowledge/lookup.server", () => ({
  lookupPropertyKnowledge: async (_db: unknown, scope: { includeHouseInfo: boolean }) => {
    seen.scopes.push(scope);
    return { found: false, mustEscalate: null, answers: [], houseDetails: [] };
  },
}));
vi.mock("@/lib/tools/resident-context", () => ({
  loadMoveInDetailsLock: async () => {
    if (seen.throwLock) throw new Error("forms unreadable");
    return seen.lock;
  },
}));

import { handleGroupMessage, type RaDeps } from "@/lib/house-groups/ra.server";
import { memberHash } from "@/lib/house-groups/members";

const SID = "CH" + "8".repeat(32);
const MAYA = "+12065550101";
let n = 0;

function world(memberUserId: string | null) {
  return fakeDb({
    house_group_conversations: [{ id: "g1", workspace_id: WS, property_id: HOUSE, conversation_sid: SID, status: "active", member_hash: memberHash(["2065550101"]) }],
    house_group_members: [{ id: "m1", group_id: "g1", phone_key: "2065550101", phone_e164: MAYA, first_name: "Maya", room_label: "Room 1", resident_user_id: memberUserId, left_at: null }],
    profiles: [{ id: "u1", email: "maya@example.test" }],
  });
}
const deps = (): RaDeps => ({
  gateway: fakeGateway(),
  now: () => NOON,
  sendDirect: async () => undefined,
  alert: (async () => ({ sent: true })) as never,
  post: { shielded: noShield },
});
const ask = (db: never, d: RaDeps) =>
  handleGroupMessage(db, { conversationSid: SID, messageSid: `IM${String(++n).padStart(32, "0")}`, author: MAYA, body: "PropLane, what is the wifi password?", mediaCount: 0 }, d);

beforeEach(() => {
  seen.scopes = [];
  seen.lock = { moveInDetailsLocked: true };
  seen.throwLock = false;
});

describe("group lookups honour the move-in lock", () => {
  it("a pre-move-in member (details locked) gets no house info", async () => {
    const w = world("u1");
    await ask(w.db, deps());
    expect(seen.scopes).toHaveLength(1);
    expect(seen.scopes[0]!.includeHouseInfo).toBe(false);
  });

  it("a member whose lock is open gets house info", async () => {
    seen.lock = { moveInDetailsLocked: false };
    const w = world("u1");
    await ask(w.db, deps());
    expect(seen.scopes[0]!.includeHouseInfo).toBe(true);
  });

  it("an unreadable lock or an unknown account stays locked", async () => {
    seen.lock = { moveInDetailsLocked: false };
    seen.throwLock = true;
    await ask(world("u1").db, deps());
    seen.throwLock = false;
    await ask(world(null).db, deps());
    expect(seen.scopes.map((s) => s.includeHouseInfo)).toEqual([false, false]);
  });
});
