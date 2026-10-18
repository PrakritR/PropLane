import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedLineConfig, SharedLineSend } from "@/lib/one-number/contracts";
import { EMERGENCY_SAFETY_REPLY } from "@/lib/one-number/contracts";
import { fakeSharedLineDb, type FakeRow } from "../helpers/shared-line-fake-db";

const sent = vi.hoisted(() => [] as SharedLineSend[]);
vi.mock("@/lib/one-number/send.server", () => ({
  sendSharedLineMessage: vi.fn(async (_db: unknown, send: SharedLineSend) => {
    sent.push(send);
    return { ok: true as const, messageSid: "SMout", segments: 1 };
  }),
}));
const alerts = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@/lib/one-number/team-alerts.server", () => ({
  alertWorkspaceTeam: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    alerts.push(input);
    return { sent: true };
  }),
}));
const unassigned = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ leadId: "lead-1" as string | null, reply: "Welcome! Budget?" as string | null, assignedWorkspaceId: null as string | null })));
vi.mock("@/lib/one-number/onboarding/unknown-sender.server", () => ({ handleUnknownSenderInbound: unassigned }));

import { handleSharedLineInbound, HUMAN_ACK_REPLY } from "@/lib/one-number/inbound-seam.server";
import { loadThreadPause } from "@/lib/one-number/session.server";

const VERIFIED = "2026-10-01T00:00:00.000Z";
const PHONE = "+12065550142";
const KEY = "2065550142";

const config = (over: Partial<SharedLineConfig> = {}): SharedLineConfig => ({
  mode: "shared", sharedNumber: "+12065550100", messagingServiceSid: "MGshared", pilotWorkspaceIds: [], ...over,
});

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
    profiles: [{ id: "user-u", email: "u@x.com", phone: PHONE, phone_verified_at: VERIFIED }],
    ...extra,
  });
}
const resident: Record<string, FakeRow[]> = {
  manager_application_records: [{ id: "app", manager_user_id: "owner-a", resident_email: "u@x.com", property_id: "prop-a1", row_data: { bucket: "approved" } }],
};
const vendor: Record<string, FakeRow[]> = {
  agent_sessions: [{ id: "s", kind: "vendor_work_order", vendor_phone_e164: PHONE, landlord_id: "owner-b", work_order_id: "wo", status: "active" }],
  portal_work_order_records: [{ id: "wo", property_id: "prop-b1", row_data: {} }],
};

const run = (db: never, body: string, over: Partial<{ config: SharedLineConfig; messageSid: string }> = {}) =>
  handleSharedLineInbound(db, { config: over.config ?? config(), fromPhone: PHONE, body, messageSid: over.messageSid ?? "SM1", mediaCount: 0, phoneKey: KEY });

beforeEach(() => {
  sent.length = 0;
  alerts.length = 0;
  unassigned.mockClear();
});

describe("routed text", () => {
  it("continues into the pipeline as the workspace owner, with the shared line's messaging service", async () => {
    const { db } = world(resident);
    expect(await run(db, "the sink is dripping")).toEqual({
      kind: "continue", owned: { managerId: "owner-a", workspaceId: "ws-a", messagingServiceSid: "MGshared" },
    });
    expect(sent).toEqual([]);
    expect(alerts).toEqual([]);
  });

  it("HUMAN pauses the AI for that workspace only, alerts that team once, acks, then continues so the team sees the text", async () => {
    const { db, rows } = world({ ...resident, ...vendor });
    const result = await run(db, "HUMAN please", { messageSid: "SM-h" });
    // Resident in A + vendor in B + neutral text = ambiguous, so a HUMAN pauses BOTH teams (below).
    expect(result).toEqual({ kind: "handled", twiml: null });
    expect(await loadThreadPause(db, KEY, "ws-a")).toMatchObject({ role: "resident" });
    expect(await loadThreadPause(db, KEY, "ws-b")).toMatchObject({ role: "vendor" });
    expect(alerts.map((a) => a.workspaceId).sort()).toEqual(["ws-a", "ws-b"]);
    expect(alerts.every((a) => a.kind === "human_request" && a.urgent === false)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ body: HUMAN_ACK_REPLY, toPhone: PHONE, idempotencyKey: "shared-line:human:SM-h" });
    // No pending question was left behind: the person did not get asked anything.
    expect(rows.sms_line_sessions ?? []).toEqual([]);
  });

  it("HUMAN from a single-team resident pauses only that team and still continues", async () => {
    const { db } = world(resident);
    const result = await run(db, "human");
    expect(result).toMatchObject({ kind: "continue", owned: { workspaceId: "ws-a" } });
    expect(await loadThreadPause(db, KEY, "ws-a")).not.toBeNull();
    expect(await loadThreadPause(db, KEY, "ws-b")).toBeNull();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ workspaceId: "ws-a", ownerUserId: "owner-a", kind: "human_request", idempotencyKey: "human:SM1:ws-a" });
    expect(sent.map((s) => s.body)).toEqual([HUMAN_ACK_REPLY]);
  });

  it("EMERGENCY replies with the safety text at once, alerts urgently, and still lets the agent file the request", async () => {
    const { db } = world(resident);
    const result = await run(db, "I smell gas in the hallway");
    expect(result).toMatchObject({ kind: "continue", owned: { workspaceId: "ws-a" } });
    expect(sent.map((s) => s.body)).toEqual([EMERGENCY_SAFETY_REPLY]);
    expect(alerts).toMatchObject([{ workspaceId: "ws-a", kind: "emergency", urgent: true }]);
    expect(await loadThreadPause(db, KEY, "ws-a")).toBeNull();
  });

  it("a team member saying HUMAN or fire is just talking to their own manager agent", async () => {
    const { db } = world({
      profiles: [{ id: "owner-a", email: "a@x.com", phone: "+12065550100", phone_verified_at: VERIFIED }],
    });
    for (const body of ["human", "is there a fire drill today"]) {
      const result = await handleSharedLineInbound(db, { config: config(), fromPhone: "+12065550100", body, messageSid: "SMm", mediaCount: 0, phoneKey: "2065550100" });
      expect(result).toMatchObject({ kind: "continue", owned: { workspaceId: "ws-a" } });
    }
    expect(sent).toEqual([]);
    expect(alerts).toEqual([]);
  });
});

describe("ambiguous text", () => {
  it("sends the question and stops", async () => {
    const { db } = world({ ...resident, ...vendor });
    expect(await run(db, "ok thanks")).toEqual({ kind: "handled", twiml: null });
    expect(sent.map((s) => s.body)).toEqual(["Is this about 5259 Brooklyn or your job at 4709A 8th Ave?"]);
    expect(sent[0].idempotencyKey).toBe("shared-line:question:SM1");
  });

  it("an emergency word with an unclear team still sends the safety text and alerts both teams, then asks", async () => {
    const { db } = world({ ...resident, ...vendor });
    await run(db, "there is smoke");
    expect(sent.map((s) => s.body)).toEqual([EMERGENCY_SAFETY_REPLY, "Is this about 5259 Brooklyn or your job at 4709A 8th Ave?"]);
    expect(alerts.map((a) => [a.workspaceId, a.kind])).toEqual([["ws-a", "emergency"], ["ws-b", "emergency"]]);
  });
});

describe("unassigned text", () => {
  it("hands a stranger to the lead queue and answers in the webhook's own TwiML", async () => {
    const { db } = world();
    expect(await run(db, "do you have rooms?")).toEqual({ kind: "handled", twiml: "Welcome! Budget?" });
    expect(unassigned).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
  });

  it("a lead's one real listing photo rides the TwiML reply; an emergency never carries it", async () => {
    const { db } = world();
    unassigned.mockResolvedValueOnce({ leadId: "lead-1", reply: "Room at 5259 Brooklyn, $900.", assignedWorkspaceId: null, mediaUrls: ["https://cdn.example.com/r1.jpg", "https://cdn.example.com/r2.jpg"] } as never);
    expect(await run(db, "yes please")).toEqual({ kind: "handled", twiml: "Room at 5259 Brooklyn, $900.", mediaUrl: "https://cdn.example.com/r1.jpg" });
    unassigned.mockResolvedValueOnce({ leadId: "lead-1", reply: "Room.", assignedWorkspaceId: null, mediaUrls: ["https://cdn.example.com/r1.jpg"] } as never);
    expect(await run(db, "fire")).toEqual({ kind: "handled", twiml: EMERGENCY_SAFETY_REPLY });
  });

  it("a stranger texting an emergency word gets the safety text first", async () => {
    const { db } = world();
    expect(await run(db, "fire")).toEqual({ kind: "handled", twiml: EMERGENCY_SAFETY_REPLY });
  });

  it("a stranger asking for HUMAN is still qualified by the lead queue (no team to page)", async () => {
    const { db } = world();
    expect(await run(db, "human")).toEqual({ kind: "handled", twiml: "Welcome! Budget?" });
    expect(alerts).toEqual([]);
  });
});

describe("pilot", () => {
  it("serves only listed workspaces: anyone else is left to the existing no-owner path", async () => {
    const { db } = world(resident);
    expect(await run(db, "hello", { config: config({ pilotWorkspaceIds: ["ws-b"] }) })).toEqual({ kind: "none" });
    expect(await run(db, "hello", { config: config({ pilotWorkspaceIds: ["ws-a"] }) })).toMatchObject({ kind: "continue" });
  });

  it("an ambiguity between a pilot and a non-pilot team resolves to the pilot team", async () => {
    const { db } = world({ ...resident, ...vendor });
    expect(await run(db, "ok thanks", { config: config({ pilotWorkspaceIds: ["ws-b"] }) })).toMatchObject({
      kind: "continue", owned: { workspaceId: "ws-b", managerId: "owner-b" },
    });
  });
});
