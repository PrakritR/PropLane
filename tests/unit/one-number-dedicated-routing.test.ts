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
vi.mock("@/lib/one-number/unassigned-leads.server", () => ({ handleUnassignedLeadInbound: unassigned }));
// The router reaches the lead qualifier through the unknown-sender front door (onboarding).
vi.mock("@/lib/one-number/onboarding/unknown-sender.server", () => ({ handleUnknownSenderInbound: unassigned }));
const logged = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@/lib/manager-sms-messages.server", () => ({
  logManagerSmsMessage: vi.fn(async (_db: unknown, args: Record<string, unknown>) => {
    logged.push(args);
    return true;
  }),
}));
const ownNumbers = vi.hoisted(() => ({} as Record<string, string | null>));
vi.mock("@/lib/sms/manager-workspace-role.server", () => ({
  resolveWorkspaceStatusLine: vi.fn(async (_db: unknown, _owner: string, workspaceId: string) => ({
    phoneNumber: ownNumbers[workspaceId] ?? null,
    provisionState: ownNumbers[workspaceId] ? "active" : null,
  })),
}));

import { buildDedicatedRedirectReply } from "@/lib/one-number/dedicated-redirect.server";
import { handleSharedLineInbound } from "@/lib/one-number/inbound-seam.server";
import { routeSharedLineInboundWithReply } from "@/lib/one-number/router.server";

const VERIFIED = "2026-10-01T00:00:00.000Z";
const PHONE = "+12065550142";
const KEY = "2065550142";

const config = (over: Partial<SharedLineConfig> = {}): SharedLineConfig => ({
  mode: "shared", sharedNumber: "+12065550100", messagingServiceSid: "MGshared", pilotWorkspaceIds: [], dedicatedWorkspaceIds: ["ws-pro"], ...over,
});

function world(extra: Record<string, FakeRow[]> = {}) {
  return fakeSharedLineDb({
    portal_workspaces: [
      { id: "ws-pro", name: "Brooklyn Homes", owner_user_id: "owner-pro", is_default: true },
      { id: "ws-free", name: "Eighth Ave Co", owner_user_id: "owner-free", is_default: true },
    ],
    manager_property_records: [
      { id: "prop-pro", manager_user_id: "owner-pro", workspace_id: "ws-pro", row_data: { buildingName: "5259 Brooklyn" } },
      { id: "prop-free", manager_user_id: "owner-free", workspace_id: "ws-free", row_data: { address: "4709A 8th Ave" } },
    ],
    profiles: [{ id: "user-u", email: "u@x.com", phone: PHONE, phone_verified_at: VERIFIED }],
    ...extra,
  });
}
const residentOfPro: Record<string, FakeRow[]> = {
  manager_application_records: [{ id: "app", manager_user_id: "owner-pro", resident_email: "u@x.com", property_id: "prop-pro", row_data: { bucket: "approved" } }],
};
const residentOfBoth: Record<string, FakeRow[]> = {
  manager_application_records: [
    { id: "app", manager_user_id: "owner-pro", resident_email: "u@x.com", property_id: "prop-pro", row_data: { bucket: "approved" } },
    { id: "app2", manager_user_id: "owner-free", resident_email: "u@x.com", property_id: "prop-free", row_data: { bucket: "approved" } },
  ],
};

const run = (db: never, body: string, over: Partial<{ config: SharedLineConfig; messageSid: string }> = {}) =>
  handleSharedLineInbound(db, { config: over.config ?? config(), fromPhone: PHONE, body, messageSid: over.messageSid ?? "SM1", mediaCount: 0, phoneKey: KEY });

beforeEach(() => {
  sent.length = 0;
  alerts.length = 0;
  logged.length = 0;
  unassigned.mockClear();
  for (const key of Object.keys(ownNumbers)) delete ownNumbers[key];
  ownNumbers["ws-pro"] = "+12065550111";
});

describe("buildDedicatedRedirectReply", () => {
  it("names the workspace and its own number in one GSM-7 segment", () => {
    const text = buildDedicatedRedirectReply("5259 Brooklyn", "+12065550111");
    expect(text).toBe("5259 Brooklyn texts from (206) 555-0111. Please text that number.");
    expect(text.length).toBeLessThanOrEqual(160);
  });
  it("caps a long label and never prints a non-GSM character", () => {
    const text = buildDedicatedRedirectReply("The “Très Long” Seattle Homes Workspace Name Goes On", "+12065550111");
    expect(text.length).toBeLessThanOrEqual(160);
    expect(text).not.toMatch(/[“”é]/);
  });
});

describe("router: workspaces with their own number are not routed on the shared line", () => {
  it("when the only match is a dedicated workspace, it asks for a redirect and makes no lead", async () => {
    const { db, rows } = world(residentOfPro);
    const inbound = { fromPhone: PHONE, phoneKey: KEY, body: "the sink is dripping", messageSid: "SM1", mediaCount: 0 };
    const result = await routeSharedLineInboundWithReply(db, inbound, null, { dedicatedWorkspaceIds: ["ws-pro"] });
    expect(result.dedicatedRedirect).toMatchObject({ workspaceId: "ws-pro", ownerUserId: "owner-pro" });
    expect(result.decision.kind).toBe("unassigned");
    expect(unassigned).not.toHaveBeenCalled();
    expect(rows.sms_line_sessions ?? []).toEqual([]);
  });

  it("a mixed phone routes among the shared workspaces only, without asking", async () => {
    const { db } = world(residentOfBoth);
    const inbound = { fromPhone: PHONE, phoneKey: KEY, body: "the sink is dripping", messageSid: "SM1", mediaCount: 0 };
    const result = await routeSharedLineInboundWithReply(db, inbound, null, { dedicatedWorkspaceIds: ["ws-pro"] });
    expect(result.dedicatedRedirect).toBeUndefined();
    expect(result.decision).toMatchObject({ kind: "routed", workspaceId: "ws-free" });
  });

  it("without a dedicated list the router behaves exactly as before (ambiguity is asked)", async () => {
    const { db } = world(residentOfBoth);
    const inbound = { fromPhone: PHONE, phoneKey: KEY, body: "the sink is dripping", messageSid: "SM1", mediaCount: 0 };
    const result = await routeSharedLineInboundWithReply(db, inbound, null, {});
    expect(result.decision.kind).toBe("ambiguous");
  });

  it("a stranger is still a lead", async () => {
    const { db } = world();
    const inbound = { fromPhone: PHONE, phoneKey: KEY, body: "hi, any rooms?", messageSid: "SM1", mediaCount: 0 };
    const result = await routeSharedLineInboundWithReply(db, inbound, null, { dedicatedWorkspaceIds: ["ws-pro"] });
    expect(result.dedicatedRedirect).toBeUndefined();
    expect(unassigned).toHaveBeenCalledTimes(1);
  });

  it("a lead whose picked room belongs to a dedicated workspace is sent to that workspace's number", async () => {
    const { db } = world();
    unassigned.mockResolvedValueOnce({ leadId: "lead-9", reply: "Great pick", assignedWorkspaceId: "ws-pro" });
    const inbound = { fromPhone: PHONE, phoneKey: KEY, body: "1", messageSid: "SM1", mediaCount: 0 };
    const result = await routeSharedLineInboundWithReply(db, inbound, null, { dedicatedWorkspaceIds: ["ws-pro"] });
    expect(result.dedicatedRedirect).toMatchObject({ workspaceId: "ws-pro" });
  });
});

describe("seam: the redirect text", () => {
  it("replies once with the workspace's own number on the webhook TwiML, and logs the text to its thread", async () => {
    const { db } = world(residentOfPro);
    const result = await run(db, "the sink is dripping", { messageSid: "SM-r" });
    expect(result).toEqual({ kind: "handled", twiml: "5259 Brooklyn texts from (206) 555-0111. Please text that number." });
    expect(sent).toEqual([]);
    expect(unassigned).not.toHaveBeenCalled();
    expect(logged).toHaveLength(2);
    expect(logged[0]).toMatchObject({
      managerUserId: "owner-pro", workspaceId: "ws-pro", direction: "inbound", body: "the sink is dripping",
      messageSid: "SM-r", toPhone: "+12065550100", fromPhone: PHONE,
    });
    expect(logged[1]).toMatchObject({ direction: "outbound", messageSid: "redirect:SM-r", fromPhone: "+12065550100", toPhone: PHONE });
  });

  it("never names another workspace's number: a mixed phone is served by the shared workspace, no redirect", async () => {
    const { db } = world(residentOfBoth);
    expect(await run(db, "the sink is dripping")).toMatchObject({ kind: "continue", owned: { workspaceId: "ws-free" } });
    expect(logged).toEqual([]);
  });

  it("falls back to the existing no-owner path when the workspace's number cannot be named", async () => {
    ownNumbers["ws-pro"] = null;
    const { db } = world(residentOfPro);
    expect(await run(db, "hello there")).toEqual({ kind: "none" });
    expect(logged).toEqual([]);
  });

  it("an emergency word still gets the safety text and pages that team", async () => {
    const { db } = world(residentOfPro);
    const result = await run(db, "I smell gas in the hallway", { messageSid: "SM-e" });
    expect(result).toMatchObject({ kind: "handled" });
    expect((result as { twiml: string }).twiml.startsWith(EMERGENCY_SAFETY_REPLY)).toBe(true);
    expect((result as { twiml: string }).twiml).toContain("(206) 555-0111");
    expect(alerts).toMatchObject([{ workspaceId: "ws-pro", kind: "emergency", urgent: true }]);
  });

  it("with no dedicated workspaces the seam is unchanged", async () => {
    const { db } = world(residentOfPro);
    expect(await run(db, "the sink is dripping", { config: config({ dedicatedWorkspaceIds: [] }) })).toMatchObject({
      kind: "continue", owned: { workspaceId: "ws-pro" },
    });
    expect(logged).toEqual([]);
  });
});
