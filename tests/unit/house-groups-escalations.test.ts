// The RA hands what it cannot settle to the manager's escalations inbox (Automations), and the
// automations "is there a group?" check reads W10's own store.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, fakeGateway, HOUSE, NOON, noShield, WS } from "../helpers/house-group-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
vi.mock("@/lib/comms-billing/wallet.server", () => ({
  reserveCommsCredit: vi.fn(async () => ({ allowed: true, duplicate: false, state: "reserved" })),
  finishCommsCredit: vi.fn(async () => undefined),
}));
const esc = vi.hoisted(() => ({
  item: vi.fn(async () => "esc-1"),
  complaint: vi.fn(async () => ({ logged: true, count: 1, threshold: null, escalated: false })),
}));
vi.mock("@/lib/automations/escalations.server", () => ({ recordEscalationItem: esc.item, recordHouseComplaint: esc.complaint }));

import { houseGroupReady } from "@/lib/house-groups/ready.server";
import { handleGroupMessage, type RaDeps } from "@/lib/house-groups/ra.server";
import { memberHash } from "@/lib/house-groups/members";
import type { LookupLike } from "@/lib/house-groups/facts";

const SID = "CH" + "9".repeat(32);
const SAM = "+12065550102";
const rows = (status = "active", workspace = WS) => ({
  house_group_conversations: [
    { id: "g1", workspace_id: workspace, property_id: HOUSE, conversation_sid: SID, status, member_hash: memberHash(["2065550101", "2065550102", "2065550103"]) },
  ],
  house_group_members: [
    { id: "m1", group_id: "g1", phone_key: "2065550101", phone_e164: "+12065550101", first_name: "Maya", room_label: "Room 1", left_at: null },
    { id: "m2", group_id: "g1", phone_key: "2065550102", phone_e164: SAM, first_name: "Sam", room_label: "Room 2", left_at: null },
    { id: "m3", group_id: "g1", phone_key: "2065550103", phone_e164: "+12065550103", first_name: "Lee", room_label: "Room 3", left_at: null },
  ],
});
let n = 0;
const incoming = (body: string) => ({ conversationSid: SID, messageSid: `IM${String(++n).padStart(32, "0")}`, author: SAM, body, mediaCount: 0 });
const unknown: LookupLike = { found: false, mustEscalate: null, answers: [], houseDetails: [] };

function harness(lookup: LookupLike = unknown) {
  const world = fakeDb(rows());
  const deps: RaDeps = {
    gateway: fakeGateway(),
    now: () => NOON,
    lookup: async () => lookup,
    sendDirect: async () => undefined,
    alert: (async () => ({ sent: true })) as never,
    post: { shielded: noShield },
  };
  return { ...world, deps };
}

beforeEach(() => {
  esc.item.mockClear();
  esc.complaint.mockClear();
});

describe("RA escalations land in the inbox", () => {
  it("counts a complaint against the house", async () => {
    const h = harness();
    await handleGroupMessage(h.db, incoming("I am so fed up with how this house is run"), h.deps);
    expect(esc.complaint).toHaveBeenCalledTimes(1);
    expect(esc.complaint.mock.calls[0]![1]).toMatchObject({ workspaceId: WS, propertyId: HOUSE, phone: SAM });
  });

  it("files a harassment concern as one open item with the excerpt", async () => {
    const h = harness();
    await handleGroupMessage(h.db, incoming("he keeps harassing me in the hallway"), h.deps);
    expect(esc.item).toHaveBeenCalledTimes(1);
    expect(esc.item.mock.calls[0]![1]).toMatchObject({ source: "ra", topic: "harassment", propertyId: HOUSE, workspaceId: WS });
    expect(esc.complaint).not.toHaveBeenCalled();
  });

  it("files a house question with no approved answer as unanswered", async () => {
    const h = harness();
    await handleGroupMessage(h.db, incoming("PropLane what is the landlord's favorite color?"), h.deps);
    expect(esc.item).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ source: "unanswered", topic: "house_question" }));
  });

  it("a Twilio retry of the same message files nothing twice", async () => {
    const h = harness();
    const m = incoming("he keeps harassing me in the hallway");
    await handleGroupMessage(h.db, m, h.deps);
    await handleGroupMessage(h.db, m, h.deps);
    expect(esc.item).toHaveBeenCalledTimes(1);
  });
});

describe("houseGroupReady reads W10's store", () => {
  const enabled = { house_group_settings: [{ workspace_id: WS, enabled: true, max_posts_per_day: 4 }] };
  it("is true for an active group in a workspace with house chat on", async () => {
    expect(await houseGroupReady(fakeDb({ ...rows(), ...enabled } as never).db, WS, HOUSE)).toBe(true);
  });
  it("is false with the switch off, a retired group, another workspace's group, or no table", async () => {
    expect(await houseGroupReady(fakeDb({ ...rows(), house_group_settings: [{ workspace_id: WS, enabled: false, max_posts_per_day: 4 }] } as never).db, WS, HOUSE)).toBe(false);
    expect(await houseGroupReady(fakeDb({ ...rows("retired"), ...enabled } as never).db, WS, HOUSE)).toBe(false);
    expect(await houseGroupReady(fakeDb({ ...rows("active", "ws-other"), ...enabled } as never).db, WS, HOUSE)).toBe(false);
    expect(await houseGroupReady(fakeDb().db, WS, HOUSE)).toBe(false);
  });
});
