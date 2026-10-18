// The group manager: a group is defined by its member list. Create, keep, swap (new group, old retired,
// leavers told), reactivate, defer at night, cap at nine, never a short stay.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, fakeGateway, HOUSE, MIDNIGHT, NOON, noShield, OWNER, resident, SHARED, WS } from "../helpers/house-group-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
vi.mock("@/lib/comms-billing/wallet.server", () => ({
  reserveCommsCredit: vi.fn(async () => ({ allowed: true, duplicate: false, state: "reserved" })),
  finishCommsCredit: vi.fn(async () => undefined),
}));

import { closeStaleRetiredGroups, syncAllHouseGroups, syncHouseGroup, type SyncDeps } from "@/lib/house-groups/manager.server";
import { memberHash } from "@/lib/house-groups/members";
import type { ResidentCandidate } from "@/lib/house-groups/types";

type Sent = { toPhone: string; body: string; idempotencyKey: string };

function harness(candidates: ResidentCandidate[], over: Partial<SyncDeps> = {}) {
  const sent: Sent[] = [];
  const alerts: { text: string }[] = [];
  const gateway = fakeGateway();
  const state = { candidates };
  const deps: SyncDeps = {
    gateway,
    now: () => NOON,
    loadCandidates: async () => state.candidates,
    sendDirect: async (i) => {
      sent.push({ toPhone: i.toPhone, body: i.body, idempotencyKey: i.idempotencyKey });
    },
    alert: (async (_db: unknown, input: { text: string }) => {
      alerts.push({ text: input.text });
      return { sent: true };
    }) as never,
    post: { shielded: noShield },
    ...over,
  };
  return { deps, sent, alerts, gateway, state };
}

const sync = (db: never, deps: SyncDeps, reason: "daily" | "early_move_out" | "manager" | "consent_change" = "daily") =>
  syncHouseGroup(db, { workspaceId: WS, propertyId: HOUSE, reason }, deps);

describe("syncHouseGroup", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does nothing while the line is per-workspace or the switch is off", async () => {
    const h = harness([resident(1), resident(2)]);
    const perWorkspace = fakeDb({ sms_runtime_config: [{ singleton: true, line_mode: "per_workspace" }] });
    expect((await sync(perWorkspace.db, h.deps)).outcome).toBe("disabled");
    const off = fakeDb({ house_group_settings: [{ workspace_id: WS, enabled: false, max_posts_per_day: 4 }] });
    expect((await sync(off.db, h.deps)).outcome).toBe("disabled");
    expect(h.gateway.calls).toEqual([]);
  });

  it("creates a group: residents as SMS participants, PropLane projected from the shared number, then the intro", async () => {
    const { db, rows } = fakeDb();
    const h = harness([resident(1), resident(2), resident(3)]);
    const result = await sync(db, h.deps);
    expect(result).toMatchObject({ outcome: "created", members: 3, overflow: 0 });
    const fns = h.gateway.calls.map((c) => c.fn);
    expect(fns.slice(0, 2)).toEqual(["createConversation", "watchConversation"]);
    expect(fns.filter((f) => f === "addResident")).toHaveLength(3);
    expect(h.gateway.calls.find((c) => c.fn === "addProplane")?.args[1]).toBe(SHARED);
    expect(rows.house_group_conversations).toHaveLength(1);
    expect(rows.house_group_conversations[0]).toMatchObject({ workspace_id: WS, property_id: HOUSE, status: "active" });
    expect(rows.house_group_members).toHaveLength(3);
    expect(h.gateway.posted).toHaveLength(1);
    expect(h.gateway.posted[0].body).toContain("Maya (Room 1), Sam (Room 2), Lee (Room 3)");
    expect(h.gateway.posted[0].body).not.toContain("old one is retired");
  });

  it("is idempotent: the same list changes nothing", async () => {
    const { db, rows } = fakeDb();
    const h = harness([resident(1), resident(2)]);
    await sync(db, h.deps);
    const callsAfterFirst = h.gateway.calls.length;
    expect((await sync(db, h.deps)).outcome).toBe("unchanged");
    expect(h.gateway.calls).toHaveLength(callsAfterFirst);
    expect(rows.house_group_conversations).toHaveLength(1);
  });

  it("a swap makes a NEW group, retires the old one, introduces the newcomer, and tells the leaver one-on-one", async () => {
    const { db, rows } = fakeDb();
    const h = harness([resident(1), resident(2), resident(3)]);
    await sync(db, h.deps);
    const oldSid = rows.house_group_conversations[0].conversation_sid;

    h.state.candidates = [resident(1), resident(2), resident(4)]; // Lee (3) moved out, Kim (4) moved in
    const result = await sync(db, h.deps, "early_move_out");
    expect(result.outcome).toBe("replaced");

    const groups = rows.house_group_conversations;
    expect(groups).toHaveLength(2);
    const old = groups.find((g) => g.conversation_sid === oldSid)!;
    const next = groups.find((g) => g.conversation_sid !== oldSid)!;
    expect(old.status).toBe("retired");
    expect(old.superseded_by).toBe(next.id);
    expect(next.status).toBe("active");
    expect(next.member_hash).toBe(memberHash(["2065550101", "2065550102", "2065550104"]));

    const intro = h.gateway.posted.at(-1)!;
    expect(intro.conversationSid).toBe(next.conversation_sid);
    expect(intro.body.startsWith("This is the new house thread, the old one is retired.")).toBe(true);
    expect(intro.body).toContain("Welcome Kim (Room 4)");

    const goodbye = h.sent.find((s) => s.toPhone === "+12065550103");
    expect(goodbye?.body).toContain("removed from the 5259 Brooklyn house thread");
    expect(h.sent.filter((s) => s.toPhone !== "+12065550103" && s.idempotencyKey.startsWith("house-group-goodbye"))).toEqual([]);
  });

  it("wakes a retired group whose exact list comes back instead of duplicating it", async () => {
    const { db, rows } = fakeDb();
    const h = harness([resident(1), resident(2), resident(3)]);
    await sync(db, h.deps);
    h.state.candidates = [resident(1), resident(2)];
    await sync(db, h.deps);
    expect(rows.house_group_conversations).toHaveLength(2);
    h.state.candidates = [resident(1), resident(2), resident(3)];
    const result = await sync(db, h.deps);
    expect(result.outcome).toBe("reactivated");
    expect(rows.house_group_conversations).toHaveLength(2);
    expect(rows.house_group_conversations.filter((g) => g.status === "active")).toHaveLength(1);
    expect(h.gateway.calls.filter((c) => c.fn === "createConversation")).toHaveLength(2);
  });

  it("retires the group when fewer than two residents qualify", async () => {
    const { db, rows } = fakeDb();
    const h = harness([resident(1), resident(2)]);
    await sync(db, h.deps);
    h.state.candidates = [resident(1)];
    expect((await sync(db, h.deps)).outcome).toBe("retired");
    expect(rows.house_group_conversations[0].status).toBe("retired");
    expect((await sync(db, h.deps)).outcome).toBe("too_few");
  });

  it("holds nine seats by move-in date, sends the rest one-on-one and warns the team", async () => {
    const { db, rows } = fakeDb();
    const h = harness(Array.from({ length: 11 }, (_, i) => resident(i + 1)));
    const result = await sync(db, h.deps);
    expect(result).toMatchObject({ outcome: "created", members: 9, overflow: 2 });
    expect(rows.house_group_members).toHaveLength(9);
    expect(h.gateway.calls.filter((c) => c.fn === "addResident")).toHaveLength(9);
    expect(h.alerts[0].text).toContain("holds 9 residents");
    expect(h.alerts[0].text).toContain("2 more");
  });

  it("never adds a short stay or a resident who has not agreed, and asks the latter once, privately", async () => {
    const { db, rows } = fakeDb();
    const h = harness([resident(1), resident(2), resident(3, { longTerm: false }), resident(4, { consented: false })]);
    await sync(db, h.deps);
    expect(rows.house_group_members.map((m) => m.phone_key).sort()).toEqual(["2065550101", "2065550102"]);
    const offer = h.sent.filter((s) => s.idempotencyKey.startsWith("house-group-offer"));
    expect(offer).toHaveLength(1);
    expect(offer[0].toPhone).toBe("+12065550104");
    expect(offer[0].body).toContain("join group");
  });

  it("creates and replaces nothing between 10 pm and 8 am", async () => {
    const { db, rows } = fakeDb();
    const h = harness([resident(1), resident(2)], { now: () => MIDNIGHT });
    expect((await sync(db, h.deps)).outcome).toBe("deferred_quiet_hours");
    expect(rows.house_group_conversations ?? []).toHaveLength(0);
    expect(h.gateway.calls).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it("puts the old group back when the new one cannot be built", async () => {
    const { db, rows } = fakeDb();
    const h = harness([resident(1), resident(2)]);
    await sync(db, h.deps);
    h.state.candidates = [resident(1), resident(2), resident(3)];
    const broken = fakeGateway({ fail: "addProplane" });
    const result = await sync(db, { ...h.deps, gateway: broken });
    expect(result.outcome).toBe("error");
    expect(rows.house_group_conversations).toHaveLength(1);
    expect(rows.house_group_conversations[0].status).toBe("active");
    expect(broken.calls.some((c) => c.fn === "closeConversation")).toBe(true);
  });

  it("refuses a house that belongs to another workspace", async () => {
    const { db } = fakeDb({
      manager_property_records: [{ id: HOUSE, workspace_id: "other-ws", manager_user_id: "other-owner", row_data: { buildingName: "Elsewhere" } }],
    });
    const h = harness([resident(1), resident(2)]);
    expect((await sync(db, h.deps)).outcome).toBe("not_found");
    expect(h.gateway.calls).toEqual([]);
    void OWNER;
  });
});

describe("syncAllHouseGroups and closeStaleRetiredGroups", () => {
  it("visits every house of every enabled workspace once", async () => {
    const { db, rows } = fakeDb({
      manager_property_records: [
        { id: HOUSE, workspace_id: WS, manager_user_id: OWNER, row_data: { buildingName: "5259 Brooklyn" } },
        { id: "prop-2", workspace_id: WS, manager_user_id: OWNER, row_data: { buildingName: "5257 Brooklyn" } },
      ],
    });
    const h = harness([resident(1), resident(2)]);
    const summary = await syncAllHouseGroups(db, h.deps);
    expect(summary).toMatchObject({ checked: 2, created: 2, errors: 0 });
    expect(rows.house_group_conversations).toHaveLength(2);
  });

  it("closes a group retired for over a month", async () => {
    const { db, rows } = fakeDb({
      house_group_conversations: [
        { id: "old", workspace_id: WS, property_id: HOUSE, conversation_sid: "CHold", status: "retired", member_hash: "a", retired_at: "2026-09-01T00:00:00Z" },
        { id: "fresh", workspace_id: WS, property_id: "prop-2", conversation_sid: "CHnew", status: "retired", member_hash: "b", retired_at: "2026-10-10T00:00:00Z" },
      ],
    });
    const gateway = fakeGateway();
    expect(await closeStaleRetiredGroups(db, gateway, NOON)).toBe(1);
    expect(rows.house_group_conversations.find((g) => g.id === "old")?.status).toBe("closed");
    expect(rows.house_group_conversations.find((g) => g.id === "fresh")?.status).toBe("retired");
  });
});
