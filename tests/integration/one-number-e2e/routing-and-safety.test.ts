 
// Simulated texting, no Twilio: a person texts the PropLane line and the real seam + router + session
// code decides who answers. Only the transport (the send door) and the team alert are stand-ins, so every
// text that "leaves" is recorded with the workspace it was billed to and the key that makes a retry safe.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedLineConfig, SharedLineSend } from "@/lib/one-number/contracts";
import { EMERGENCY_SAFETY_REPLY } from "@/lib/one-number/contracts";
import { fakeSharedLineDb, type FakeRow } from "../../helpers/shared-line-fake-db";

const sim = vi.hoisted(() => ({
  sent: [] as SharedLineSend[],
  keys: new Set<string>(),
  alerts: [] as Array<Record<string, unknown>>,
  alertKeys: new Set<string>(),
}));
vi.mock("@/lib/one-number/send.server", () => ({
  // Like the outbox: a repeated idempotency key is accepted and sends nothing new.
  sendSharedLineMessage: vi.fn(async (_db: unknown, send: SharedLineSend) => {
    if (send.idempotencyKey && sim.keys.has(send.idempotencyKey)) return { ok: true as const, messageSid: "SMdup", segments: 1 };
    if (send.idempotencyKey) sim.keys.add(send.idempotencyKey);
    sim.sent.push(send);
    return { ok: true as const, messageSid: "SMout", segments: 1 };
  }),
}));
vi.mock("@/lib/one-number/team-alerts.server", () => ({
  alertWorkspaceTeam: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    const key = String(input.idempotencyKey ?? "");
    if (key && sim.alertKeys.has(key)) return { sent: false };
    if (key) sim.alertKeys.add(key);
    sim.alerts.push(input);
    return { sent: true };
  }),
}));
vi.mock("@/lib/one-number/onboarding/unknown-sender.server", () => ({
  handleUnknownSenderInbound: vi.fn(async () => ({ leadId: "lead-x", reply: "Hi, this is PropLane. Reply STOP to opt out. What is your monthly budget for rent?", assignedWorkspaceId: null })),
}));

import { handleSharedLineInbound, HUMAN_ACK_REPLY } from "@/lib/one-number/inbound-seam.server";
import { loadThreadPause, resumeThreadAi } from "@/lib/one-number/session.server";

const VERIFIED = "2026-10-01T00:00:00.000Z";
const PHONE = "+12065550142";
const KEY = "2065550142";
const config: SharedLineConfig = { mode: "shared", sharedNumber: "+12065550100", messagingServiceSid: "MGshared", pilotWorkspaceIds: [] };

function world(extra: Record<string, FakeRow[]> = {}) {
  return fakeSharedLineDb({
    portal_workspaces: [
      { id: "ws-a", name: "Brooklyn Homes", owner_user_id: "owner-a", is_default: true },
      { id: "ws-b", name: "Eighth Ave Co", owner_user_id: "owner-b", is_default: true },
    ],
    manager_property_records: [
      { id: "prop-a1", manager_user_id: "owner-a", workspace_id: "ws-a", row_data: { buildingName: "5259 Brooklyn" } },
      { id: "prop-b1", manager_user_id: "owner-b", workspace_id: "ws-b", row_data: { address: "4709A 8th Ave" } },
    ],
    profiles: [
      { id: "user-rae", email: "rae@x.com", phone: PHONE, phone_verified_at: VERIFIED },
      { id: "owner-a", email: "ann@x.com", phone: "+12065550001", phone_verified_at: VERIFIED },
    ],
    sms_entry_codes: [
      { code: "BROOKLYN5", workspace_id: "ws-a", owner_user_id: "owner-a", property_id: "prop-a1", label: "5259 Brooklyn", active: true },
      { code: "OLDCODE", workspace_id: "ws-a", owner_user_id: "owner-a", property_id: "prop-a1", label: "old", active: false },
    ],
    ...extra,
  });
}
const resident: Record<string, FakeRow[]> = {
  manager_application_records: [{ id: "app", manager_user_id: "owner-a", resident_email: "rae@x.com", property_id: "prop-a1", row_data: { bucket: "approved" } }],
};
const vendor: Record<string, FakeRow[]> = {
  agent_sessions: [{ id: "s", kind: "vendor_work_order", vendor_phone_e164: PHONE, landlord_id: "owner-b", work_order_id: "wo", status: "active" }],
  portal_work_order_records: [{ id: "wo", property_id: "prop-b1", row_data: {} }],
};

// A vendor who only ever texts YES / DONE / a photo: on the roster of team B with an offer out, no login, no session.
const dispatched = (over: { attempt?: string; run?: string; completedAt?: string | null; phone?: string } = {}): Record<string, FakeRow[]> => ({
  manager_vendor_records: [{ id: "vd1", manager_user_id: "owner-b", row_data: { name: "Sam Locksmith", phone: over.phone ?? "(206) 555-0142", active: true } }],
  vendor_dispatch_attempts: [{ run_id: "r1", vendor_directory_id: "vd1", status: over.attempt ?? "offered" }],
  vendor_dispatch_runs: [{ id: "r1", owner_user_id: "owner-b", property_id: "prop-b1", status: over.run ?? "offering", completed_at: over.completedAt ?? null }],
});

let sid = 0;
const text = (db: never, body: string, from = PHONE, key = KEY) =>
  handleSharedLineInbound(db, { config, fromPhone: from, body, messageSid: `SM${++sid}`, mediaCount: 0, phoneKey: key });
const bodies = () => sim.sent.map((s) => s.body);

beforeEach(() => {
  sim.sent.length = 0;
  sim.keys.clear();
  sim.alerts.length = 0;
  sim.alertKeys.clear();
});

describe("one person in two teams", () => {
  it("resident in A and vendor in B: an unclear text is asked about, the answer is remembered, and each team sees only its own", async () => {
    const { db } = world({ ...resident, ...vendor });
    // 1. A neutral text cannot be placed: ask, naming houses and never people.
    expect(await text(db, "ok thanks")).toEqual({ kind: "handled", twiml: null });
    expect(bodies()).toEqual(["Is this about 5259 Brooklyn or your job at Eighth Ave Co?"]);
    expect(bodies().join(" ")).not.toMatch(/4709A|8th Ave/);
    // 2. The answer picks a team; the text goes on to THAT team's pipeline.
    const picked = await text(db, "2");
    expect(picked).toMatchObject({ kind: "continue", owned: { workspaceId: "ws-b", managerId: "owner-b" } });
    // 3. The thread now stays with that team for a neutral follow-up.
    expect(await text(db, "ok great")).toMatchObject({ kind: "continue", owned: { workspaceId: "ws-b" } });
    // 4. Naming a house, or using the other role's words, switches without a question.
    expect(await text(db, "5259 Brooklyn the heat is out")).toMatchObject({ kind: "continue", owned: { workspaceId: "ws-a", managerId: "owner-a" } });
    expect(await text(db, "invoice is ready for the job")).toMatchObject({ kind: "continue", owned: { workspaceId: "ws-b" } });
    // Nobody was texted anything but the one question.
    expect(bodies()).toHaveLength(1);
  });

  it("a reply that names the house answers the question as well as a number does", async () => {
    const { db } = world({ ...resident, ...vendor });
    await text(db, "ok thanks");
    expect(await text(db, "brooklyn")).toMatchObject({ kind: "continue", owned: { workspaceId: "ws-a" } });
  });

  it("HUMAN pauses the AI for both teams, pages both, answers once, and resume gives the thread back to ONE team", async () => {
    const { db } = world({ ...resident, ...vendor });
    expect(await text(db, "HUMAN")).toEqual({ kind: "handled", twiml: null });
    expect(await loadThreadPause(db, KEY, "ws-a")).toMatchObject({ role: "resident" });
    expect(await loadThreadPause(db, KEY, "ws-b")).toMatchObject({ role: "vendor" });
    expect(sim.alerts.map((a) => a.workspaceId).sort()).toEqual(["ws-a", "ws-b"]);
    expect(bodies()).toEqual([HUMAN_ACK_REPLY]);
    // Team A's manager hands the thread back; team B is still paused.
    await resumeThreadAi(db, { phoneKey: KEY, workspaceId: "ws-a", resumedBy: "owner-a" });
    expect(await loadThreadPause(db, KEY, "ws-a")).toBeNull();
    expect(await loadThreadPause(db, KEY, "ws-b")).not.toBeNull();
  });

  it("a Twilio retry of the same text sends the answer once", async () => {
    const { db } = world({ ...resident, ...vendor });
    const input = { config, fromPhone: PHONE, body: "ok thanks", messageSid: "SM-retry", mediaCount: 0, phoneKey: KEY };
    await handleSharedLineInbound(db, input);
    await handleSharedLineInbound(db, input);
    expect(bodies()).toHaveLength(1);
  });
});

describe("a vendor who works by dispatch text", () => {
  it("YES, DONE and photos from a rostered vendor with an offer out reach the team that offered the job", async () => {
    const { db } = world(dispatched());
    expect(await text(db, "YES 2:30pm")).toMatchObject({ kind: "continue", owned: { workspaceId: "ws-b", managerId: "owner-b" } });
    // Nobody is asked who they are; no onboarding question goes out.
    expect(bodies()).toEqual([]);
  });

  it("an accepted job stays routed, and so does one finished within 30 days (a late photo or invoice)", async () => {
    expect(await text(world(dispatched({ attempt: "accepted", run: "accepted" })).db, "DONE")).toMatchObject({ kind: "continue", owned: { workspaceId: "ws-b" } });
    const recent = new Date(Date.now() - 5 * 86_400_000).toISOString();
    expect(await text(world(dispatched({ attempt: "accepted", run: "completed", completedAt: recent })).db, "INVOICE $240")).toMatchObject({ kind: "continue", owned: { workspaceId: "ws-b" } });
  });

  it("a job finished long ago, a declined offer, a canceled run or another number is not a tie", async () => {
    const old = new Date(Date.now() - 45 * 86_400_000).toISOString();
    for (const [label, data] of [
      ["finished 45 days ago", dispatched({ attempt: "accepted", run: "completed", completedAt: old })],
      ["declined", dispatched({ attempt: "declined" })],
      ["canceled run", dispatched({ run: "canceled" })],
      ["a different phone on the roster", dispatched({ phone: "(206) 555-0199" })],
    ] as const) {
      const out = await text(world(data).db, "YES");
      expect(out, label).toEqual({ kind: "handled", twiml: "Hi, this is PropLane. Reply STOP to opt out. What is your monthly budget for rent?" });
    }
  });

  it("a vendor on the roster of a team that deactivated them is not routed", async () => {
    const data = dispatched();
    (data.manager_vendor_records![0]!.row_data as Record<string, unknown>).active = false;
    expect(await text(world(data).db, "YES")).toMatchObject({ kind: "handled" });
  });

  it("resident in A and dispatched vendor in B: an unclear text is asked about, never guessed", async () => {
    const { db } = world({ ...resident, ...dispatched() });
    expect(await text(db, "ok thanks")).toEqual({ kind: "handled", twiml: null });
    expect(bodies()).toEqual(["Is this about 5259 Brooklyn or your job at Eighth Ave Co?"]);
    expect(bodies().join(" ")).not.toMatch(/4709A|8th Ave/);
    expect(await text(db, "2")).toMatchObject({ kind: "continue", owned: { workspaceId: "ws-b" } });
  });
});

describe("a resident on the shared line", () => {
  it("an ordinary text goes to their manager's pipeline, and nothing leaves from here", async () => {
    const { db } = world(resident);
    expect(await text(db, "the kitchen sink is dripping")).toMatchObject({ kind: "continue", owned: { workspaceId: "ws-a", messagingServiceSid: "MGshared" } });
    expect(sim.sent).toEqual([]);
    expect(sim.alerts).toEqual([]);
  });

  it("gas smell: the safety text first, an urgent page to that team only, and the request is still filed", async () => {
    const { db } = world({ ...resident, ...vendor });
    // Even with an unclear team the safety text goes out and BOTH possible teams are paged; then we ask.
    await text(db, "I smell gas in the hallway");
    expect(bodies()[0]).toBe(EMERGENCY_SAFETY_REPLY);
    expect(sim.alerts.map((a) => [a.workspaceId, a.kind, a.urgent])).toEqual([["ws-a", "emergency", true], ["ws-b", "emergency", true]]);
    // Once the team is known, a second gas text pages only that team and continues into the agent.
    sim.sent.length = 0; sim.alerts.length = 0; sim.alertKeys.clear(); sim.keys.clear();
    await text(db, "1");
    const gas = await text(db, "gas smell at 5259 Brooklyn");
    expect(gas).toMatchObject({ kind: "continue", owned: { workspaceId: "ws-a" } });
    expect(bodies()).toEqual([EMERGENCY_SAFETY_REPLY]);
    expect(sim.alerts).toMatchObject([{ workspaceId: "ws-a", ownerUserId: "owner-a", kind: "emergency", urgent: true }]);
    expect(await loadThreadPause(db, KEY, "ws-a")).toBeNull(); // an emergency never silences the assistant
  });

  it("HUMAN from a single-team resident pauses that team only, acks once, and the text still reaches the pipeline", async () => {
    const { db } = world(resident);
    const out = await text(db, "can I talk to a person please");
    expect(out).toMatchObject({ kind: "continue", owned: { workspaceId: "ws-a" } });
    // A sentence that merely contains the words is not the HUMAN keyword.
    expect(await loadThreadPause(db, KEY, "ws-a")).toBeNull();
    const human = await text(db, "human please");
    expect(human).toMatchObject({ kind: "continue", owned: { workspaceId: "ws-a" } });
    expect(await loadThreadPause(db, KEY, "ws-a")).toMatchObject({ role: "resident" });
    expect(bodies()).toEqual([HUMAN_ACK_REPLY]);
    expect(sim.alerts).toHaveLength(1);
    // The manager resumes; the assistant answers again and nobody is told twice.
    await resumeThreadAi(db, { phoneKey: KEY, workspaceId: "ws-a", resumedBy: "owner-a" });
    expect(await loadThreadPause(db, KEY, "ws-a")).toBeNull();
    expect(await text(db, "thanks")).toMatchObject({ kind: "continue", owned: { workspaceId: "ws-a" } });
    expect(bodies()).toEqual([HUMAN_ACK_REPLY]);
  });
});

describe("a manager on the shared line", () => {
  it("is routed to their own workspace, and HUMAN or fire are just words to their manager agent", async () => {
    const { db } = world();
    for (const body of ["who hasn't paid", "human", "fire drill tomorrow?"]) {
      const out = await text(db, body, "+12065550001", "2065550001");
      expect(out).toMatchObject({ kind: "continue", owned: { workspaceId: "ws-a", managerId: "owner-a" } });
    }
    expect(sim.sent).toEqual([]);
    expect(sim.alerts).toEqual([]);
  });
});

describe("a stranger", () => {
  it("with an entry code goes straight to that house's team as a prospect", async () => {
    const { db } = world();
    const out = await text(db, "hi, is BROOKLYN5 still available?", "+12065550777", "2065550777");
    expect(out).toMatchObject({ kind: "continue", owned: { workspaceId: "ws-a", managerId: "owner-a" } });
  });

  it("with a retired code, or none, is qualified by the lead queue in the webhook's own reply", async () => {
    const { db } = world();
    for (const body of ["OLDCODE", "do you have rooms near the U?"]) {
      const out = await text(db, body, "+12065550778", "2065550778");
      expect(out).toMatchObject({ kind: "handled", twiml: expect.stringContaining("Reply STOP to opt out") });
    }
    expect(sim.sent).toEqual([]);
  });

  it("texting a gas smell gets the safety text and nothing else", async () => {
    const { db } = world();
    expect(await text(db, "I smell gas", "+12065550779", "2065550779")).toEqual({ kind: "handled", twiml: EMERGENCY_SAFETY_REPLY });
  });

  it("a code cannot pull an existing resident to another team: the resident keeps their own", async () => {
    const { db } = world(resident);
    const out = await text(db, "BROOKLYN5");
    expect(out).toMatchObject({ kind: "continue", owned: { workspaceId: "ws-a" } });
  });
});

describe("the shared line off, or not yet theirs", () => {
  // The webhook only calls the seam when the line is shared AND the text arrived on the shared number;
  // these are the two decisions it makes, over the real config reader.
  it("per-workspace mode, an unknown mode, a shared mode with no number and a failed read all keep today's numbers", async () => {
    const { loadSharedLineConfig, isSharedLineNumber } = await import("@/lib/one-number/config.server");
    const cases: Array<[string, Record<string, FakeRow[]>, object?]> = [
      ["per_workspace", { sms_runtime_config: [{ singleton: true, line_mode: "per_workspace", shared_number_e164: "+12065550100" }] }],
      ["unknown mode", { sms_runtime_config: [{ singleton: true, line_mode: "turbo", shared_number_e164: "+12065550100" }] }],
      ["shared without a number", { sms_runtime_config: [{ singleton: true, line_mode: "shared", shared_number_e164: null }] }],
      ["no row", { sms_runtime_config: [] }],
      ["table missing", {}, { broken: ["sms_runtime_config"] }],
    ];
    for (const [label, seed, options] of cases) {
      const cfg = await loadSharedLineConfig(fakeSharedLineDb(seed, options as never).db);
      expect(cfg.mode, label).toBe("per_workspace");
      expect(isSharedLineNumber(cfg, "+12065550100"), label).toBe(false);
    }
    const live = await loadSharedLineConfig(fakeSharedLineDb({ sms_runtime_config: [{ singleton: true, line_mode: "shared", shared_number_e164: "(206) 555-0100" }] }).db);
    expect(live).toMatchObject({ mode: "shared", sharedNumber: "+12065550100" });
    expect(isSharedLineNumber(live, "+1 206 555 0100")).toBe(true);
    expect(isSharedLineNumber(live, "+12065550999")).toBe(false);
  });

  it("a pilot serves only listed workspaces; anyone else is left to the existing no-owner path", async () => {
    const { db } = world(resident);
    const pilot = { ...config, pilotWorkspaceIds: ["ws-b"] };
    expect(await handleSharedLineInbound(db, { config: pilot, fromPhone: PHONE, body: "hello", messageSid: "SMp", mediaCount: 0, phoneKey: KEY })).toEqual({ kind: "none" });
  });
});
