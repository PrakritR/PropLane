// The RA at work: a message in a house group goes through quiet-by-default rules, never names anyone,
// keeps secrets out of the thread, hands complaints to a private text and the team, and dedupes retries.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, fakeGateway, HOUSE, MIDNIGHT, NOON, noShield, resident, WS } from "../helpers/house-group-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
vi.mock("@/lib/comms-billing/wallet.server", () => ({
  reserveCommsCredit: vi.fn(async () => ({ allowed: true, duplicate: false, state: "reserved" })),
  finishCommsCredit: vi.fn(async () => undefined),
}));

import { COMPLAINT_ACK, LEAVE_CONFIRM, RETIRED_REPLY } from "@/lib/house-groups/copy";
import { handleGroupMessage, handleGroupPreferenceText, runDueGroupChecks, type RaDeps } from "@/lib/house-groups/ra.server";
import { memberHash } from "@/lib/house-groups/members";
import type { LookupLike } from "@/lib/house-groups/facts";

const SID = "CH" + "9".repeat(32);
const MAYA = "+12065550101";
const SAM = "+12065550102";

const groupRows = (status = "active") => ({
  house_group_conversations: [
    { id: "g1", workspace_id: WS, property_id: HOUSE, conversation_sid: SID, status, member_hash: memberHash(["2065550101", "2065550102", "2065550103"]) },
  ],
  house_group_members: [
    { id: "m1", group_id: "g1", phone_key: "2065550101", phone_e164: MAYA, first_name: "Maya", room_label: "Room 1", left_at: null },
    { id: "m2", group_id: "g1", phone_key: "2065550102", phone_e164: SAM, first_name: "Sam", room_label: "Room 2", left_at: null },
    { id: "m3", group_id: "g1", phone_key: "2065550103", phone_e164: "+12065550103", first_name: "Lee", room_label: "Room 3", left_at: null },
  ],
});

let msg = 0;
const incoming = (author: string, body: string, over: Record<string, unknown> = {}) => ({
  conversationSid: SID,
  messageSid: `IM${String(++msg).padStart(32, "0")}`,
  author,
  body,
  mediaCount: 0,
  ...over,
});

const wifi: LookupLike = {
  found: true,
  mustEscalate: null,
  answers: [],
  houseDetails: [{ house: "5259 Brooklyn", section: "Wi-Fi", rows: [{ label: "Network", value: "Lakeview" }, { label: "Password", value: "hunter2" }] }],
};
const trash: LookupLike = {
  found: true,
  mustEscalate: null,
  answers: [{ question: "Trash day?", answer: "Trash goes out Tuesday night." }],
  houseDetails: [],
};

function harness(rows = groupRows(), lookupResult: LookupLike = trash, now = NOON) {
  const world = fakeDb(rows);
  const gateway = fakeGateway();
  const sent: { toPhone: string; body: string }[] = [];
  const alerts: { kind: string; urgent: boolean; text: string }[] = [];
  const clock = { now };
  const deps: RaDeps = {
    gateway,
    now: () => clock.now,
    lookup: async () => lookupResult,
    sendDirect: async (i) => {
      sent.push({ toPhone: i.toPhone, body: i.body });
    },
    alert: (async (_db: unknown, input: { kind: string; urgent: boolean; text: string }) => {
      alerts.push({ kind: input.kind, urgent: input.urgent, text: input.text });
      return { sent: true };
    }) as never,
    post: { shielded: noShield },
    sync: {
      loadCandidates: async () => [resident(2), resident(3)],
      sendDirect: async (i) => {
        sent.push({ toPhone: i.toPhone, body: i.body });
      },
      alert: (async () => ({ sent: true })) as never,
      post: { shielded: noShield },
    },
  };
  return { ...world, gateway, sent, alerts, deps, clock };
}

describe("handleGroupMessage: who and what it ignores", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ignores PropLane's own message, an unknown conversation, a stranger and a closed group", async () => {
    const h = harness();
    expect(await handleGroupMessage(h.db, incoming("proplane", "hi"), h.deps)).toEqual({ handled: false, reason: "own_message" });
    expect(await handleGroupMessage(h.db, incoming(MAYA, "hi", { conversationSid: "CH" + "0".repeat(32) }), h.deps)).toEqual({ handled: false, reason: "unknown_group" });
    expect(await handleGroupMessage(h.db, incoming("+12065559999", "PropLane trash day?"), h.deps)).toEqual({ handled: false, reason: "not_a_member" });
    const closed = harness(groupRows("closed"));
    expect(await handleGroupMessage(closed.db, incoming(MAYA, "PropLane trash day?"), closed.deps)).toEqual({ handled: false, reason: "closed" });
    expect(h.gateway.posted).toEqual([]);
  });

  it("does nothing while the line is per-workspace or the switch is off", async () => {
    const off = harness({ ...groupRows(), house_group_settings: [{ workspace_id: WS, enabled: false, max_posts_per_day: 4 }] });
    expect(await handleGroupMessage(off.db, incoming(MAYA, "PropLane trash day?"), off.deps)).toEqual({ handled: false, reason: "not_enabled" });
    const perWorkspace = harness({ ...groupRows(), sms_runtime_config: [{ singleton: true, line_mode: "per_workspace" }] });
    expect(await handleGroupMessage(perWorkspace.db, incoming(MAYA, "PropLane trash day?"), perWorkspace.deps)).toEqual({ handled: false, reason: "not_enabled" });
    expect(off.gateway.posted.length + perWorkspace.gateway.posted.length).toBe(0);
  });

  it("is quiet on small talk", async () => {
    const h = harness();
    const result = await handleGroupMessage(h.db, incoming(MAYA, "anyone want pizza tonight?"), h.deps);
    expect(result).toEqual({ handled: true, action: "silent" });
    expect(h.gateway.posted).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.alerts).toEqual([]);
  });

  it("handles a Twilio retry once", async () => {
    const h = harness();
    const m = incoming(MAYA, "PropLane, what day is trash?");
    expect((await handleGroupMessage(h.db, m, h.deps)).handled).toBe(true);
    expect(await handleGroupMessage(h.db, m, h.deps)).toEqual({ handled: false, reason: "duplicate" });
    expect(h.gateway.posted).toHaveLength(1);
  });
});

describe("handleGroupMessage: answers", () => {
  it("answers a house-fact question put to PropLane, by first name, from approved facts", async () => {
    const h = harness();
    await handleGroupMessage(h.db, incoming(SAM, "PropLane, what day is trash?"), h.deps);
    expect(h.gateway.posted).toEqual([{ conversationSid: SID, body: "Sam, Trash goes out Tuesday night." }]);
  });

  it("keeps a Wi-Fi password out of the group: the thread gets the network, the asker gets the password", async () => {
    const h = harness(groupRows(), wifi);
    await handleGroupMessage(h.db, incoming(SAM, "PropLane what's the wifi password?"), h.deps);
    expect(h.gateway.posted).toHaveLength(1);
    expect(h.gateway.posted[0].body).toContain("Lakeview");
    expect(h.gateway.posted[0].body).not.toContain("hunter2");
    expect(h.sent).toEqual([{ toPhone: SAM, body: expect.stringContaining("hunter2") }]);
  });

  it("says so, and tells the team, when no approved answer covers the question", async () => {
    const h = harness(groupRows(), { found: false, mustEscalate: null, answers: [], houseDetails: [] });
    await handleGroupMessage(h.db, incoming(SAM, "PropLane, is there a gym nearby?"), h.deps);
    expect(h.gateway.posted[0].body).toBe("Let me check with your landlord and get back to you.");
    expect(h.alerts[0]).toMatchObject({ kind: "unanswered", urgent: false });
  });

  it("takes a money question out of the group: acknowledges, texts the asker, tells the team", async () => {
    const h = harness(groupRows(), { found: false, mustEscalate: "money", answers: [], houseDetails: [] });
    await handleGroupMessage(h.db, incoming(SAM, "PropLane when is my rent due and how much?"), h.deps);
    expect(h.gateway.posted.map((p) => p.body)).toEqual([COMPLAINT_ACK]);
    expect(h.sent.some((s) => s.toPhone === SAM)).toBe(true);
    expect(h.alerts).toHaveLength(1);
  });

  it("holds an addressed question until morning at night, then answers it", async () => {
    const h = harness(groupRows(), trash, MIDNIGHT);
    const result = await handleGroupMessage(h.db, incoming(SAM, "PropLane, what day is trash?"), h.deps);
    expect(result).toEqual({ handled: true, action: "held_quiet_hours" });
    expect(h.gateway.posted).toEqual([]);
    h.clock.now = new Date("2026-10-19T07:30:00Z"); // still night
    expect(await runDueGroupChecks(h.db, h.deps)).toMatchObject({ acted: 0 });
    h.clock.now = new Date("2026-10-19T15:05:00Z"); // 8:05 am
    expect(await runDueGroupChecks(h.db, h.deps)).toMatchObject({ checked: 1, acted: 1 });
    expect(h.gateway.posted).toHaveLength(1);
    expect(h.gateway.posted[0].body).toContain("Trash goes out Tuesday night.");
  });

  it("gives housemates ten minutes on an unaddressed question, and stays out if one answered", async () => {
    const h = harness();
    await handleGroupMessage(h.db, incoming(SAM, "what day is trash?"), h.deps);
    expect(h.gateway.posted).toEqual([]);
    h.clock.now = new Date(NOON.getTime() + 5 * 60_000);
    expect(await runDueGroupChecks(h.db, h.deps)).toMatchObject({ checked: 0 });
    h.clock.now = new Date(NOON.getTime() + 11 * 60_000);
    expect(await runDueGroupChecks(h.db, h.deps)).toMatchObject({ checked: 1, acted: 1 });
    expect(h.gateway.posted).toHaveLength(1);

    const h2 = harness();
    await handleGroupMessage(h2.db, incoming(SAM, "what day is trash?"), h2.deps);
    await handleGroupMessage(h2.db, incoming(MAYA, "tuesday I think"), h2.deps);
    h2.clock.now = new Date(NOON.getTime() + 11 * 60_000);
    expect(await runDueGroupChecks(h2.db, h2.deps)).toMatchObject({ checked: 1, acted: 0 });
    expect(h2.gateway.posted).toEqual([]);
  });

  it("answers privately once the daily cap is reached", async () => {
    const h = harness({
      ...groupRows(),
      house_group_messages: Array.from({ length: 4 }, (_, i) => ({
        id: `o${i}`, group_id: "g1", workspace_id: WS, property_id: HOUSE, direction: "outbound", kind: "reminder", body: "x", idempotency_key: `k${i}`,
        created_at: "2026-10-18T15:00:00.000Z",
      })),
    });
    await handleGroupMessage(h.db, incoming(SAM, "PropLane, what day is trash?"), h.deps);
    expect(h.gateway.posted).toEqual([]);
    expect(h.sent).toEqual([{ toPhone: SAM, body: "Sam, Trash goes out Tuesday night." }]);
  });
});

describe("handleGroupMessage: complaints, escalations, emergencies", () => {
  it("acknowledges a complaint in the group with the exact words, follows up one-on-one, and names no one", async () => {
    const h = harness();
    await handleGroupMessage(h.db, incoming(SAM, "I am so fed up with how this house is run"), h.deps);
    expect(h.gateway.posted.map((p) => p.body)).toEqual([COMPLAINT_ACK]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].toPhone).toBe(SAM);
    for (const name of ["Maya", "Sam", "Lee"]) expect(h.gateway.posted[0].body).not.toContain(name);
    expect(h.alerts).toEqual([]);
  });

  it("reminds neutrally on a repeated rule issue, then escalates the third to the manager with the excerpt", async () => {
    const h = harness();
    await handleGroupMessage(h.db, incoming(SAM, "so loud again, music at 2am"), h.deps);
    h.gateway.posted.length = 0;
    await handleGroupMessage(h.db, incoming(MAYA, "the noise again, so loud"), h.deps);
    expect(h.gateway.posted).toHaveLength(1);
    expect(h.gateway.posted[0].body).toContain("keep noise down");
    expect(h.gateway.posted[0].body).not.toMatch(/Maya|Sam|Lee/);
    h.gateway.posted.length = 0;
    await handleGroupMessage(h.db, incoming("+12065550103", "stomping and loud music again"), h.deps);
    expect(h.gateway.posted).toEqual([]);
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0].text).toContain("repeated house-rule issues");
    expect(h.alerts[0].text).toContain("stomping and loud music again");
  });

  it("sends harassment to the team and says nothing in the group, day or night", async () => {
    for (const now of [NOON, MIDNIGHT]) {
      const h = harness(groupRows(), trash, now);
      await handleGroupMessage(h.db, incoming(SAM, "he keeps harassing me in the hallway"), h.deps);
      expect(h.gateway.posted).toEqual([]);
      expect(h.alerts).toHaveLength(1);
      expect(h.alerts[0].text).toContain("harassment concern");
      expect(h.alerts[0].urgent).toBe(false);
    }
  });

  it("posts the safety reply and an urgent alert on an emergency word, even at night", async () => {
    const h = harness(groupRows(), trash, MIDNIGHT);
    await handleGroupMessage(h.db, incoming(SAM, "I smell a gas leak in the kitchen"), h.deps);
    expect(h.gateway.posted).toHaveLength(1);
    expect(h.gateway.posted[0].body).toContain("call 911");
    expect(h.alerts[0]).toMatchObject({ kind: "emergency", urgent: true });
  });
});

describe("retired groups", () => {
  it("replies once to a stray text, pointing to the new thread, and never again", async () => {
    const h = harness(groupRows("retired"));
    expect(await handleGroupMessage(h.db, incoming(SAM, "hello?"), h.deps)).toEqual({ handled: true, action: "retired_notice" });
    expect(h.gateway.posted).toEqual([{ conversationSid: SID, body: RETIRED_REPLY }]);
    expect(await handleGroupMessage(h.db, incoming(SAM, "anyone?"), h.deps)).toEqual({ handled: false, reason: "closed" });
    expect(h.gateway.posted).toHaveLength(1);
  });
});

describe("leave group / join group", () => {
  it("'leave group' in the group opts the resident out, confirms privately and rebuilds the group without them", async () => {
    const h = harness();
    const result = await handleGroupMessage(h.db, incoming(MAYA, "leave group"), h.deps);
    expect(result).toEqual({ handled: true, action: "left_group" });
    const pref = h.rows.house_group_preferences.find((p) => p.phone_key === "2065550101");
    expect(pref).toMatchObject({ workspace_id: WS, opted_out_of_group: true });
    expect(h.sent.find((s) => s.toPhone === MAYA)?.body).toBe(LEAVE_CONFIRM);
    expect(h.gateway.posted.every((p) => !/leave group/i.test(p.body) || p.body.includes("Text me"))).toBe(true);
    // The sync (residents 2 and 3 remain) made a new group and retired the old one.
    expect(h.rows.house_group_conversations.filter((g) => g.status === "active")).toHaveLength(1);
    expect(h.rows.house_group_conversations.find((g) => g.id === "g1")?.status).toBe("retired");
  });

  it("a 1:1 'leave group' / 'join group' is recorded for a resident of a chat-enabled house", async () => {
    const h = harness();
    const left = await handleGroupPreferenceText(h.db, { fromPhone: SAM, command: "leave", messageSid: "SM1" }, h.deps);
    expect(left).toEqual({ handled: true, reply: LEAVE_CONFIRM });
    expect(h.rows.house_group_preferences.find((p) => p.phone_key === "2065550102")).toMatchObject({ opted_out_of_group: true });
    const joined = await handleGroupPreferenceText(h.db, { fromPhone: SAM, command: "join", messageSid: "SM2" }, h.deps);
    expect(joined.handled).toBe(true);
    expect(h.rows.house_group_preferences.find((p) => p.phone_key === "2065550102")).toMatchObject({ opted_out_of_group: false, consent_source: "sms_join" });
  });

  it("does not claim the text for someone who is not a resident, or while the line is per-workspace", async () => {
    const h = harness();
    expect(await handleGroupPreferenceText(h.db, { fromPhone: "+12065558888", command: "leave", messageSid: "SM3" }, h.deps)).toEqual({ handled: false, reply: null });
    const perWorkspace = harness({ ...groupRows(), sms_runtime_config: [{ singleton: true, line_mode: "per_workspace" }] });
    expect(await handleGroupPreferenceText(perWorkspace.db, { fromPhone: SAM, command: "leave", messageSid: "SM4" }, perWorkspace.deps)).toEqual({ handled: false, reply: null });
  });
});
