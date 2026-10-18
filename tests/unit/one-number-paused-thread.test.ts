import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A HUMAN pause silences the AI for (phone, workspace) on the shared line. The text is still recorded and
// projected so the team reads it; no agent runs. Outside the shared line nothing about the pipeline changes.

const m = vi.hoisted(() => ({
  loadPause: vi.fn(async (..._a: unknown[]): Promise<{ role: string; reason: string | null } | null> => null),
  leasing: vi.fn(async (..._a: unknown[]) => ({ ok: true as const })),
  residentCtx: vi.fn(async (..._a: unknown[]) => ({ ok: false as const, reason: "no_verified_profile" })),
  residentTurn: vi.fn(),
  vendorResolve: vi.fn(async (..._a: unknown[]) => ({ kind: "unknown_phone" })),
  vendorTurn: vi.fn(),
  managerIdentity: vi.fn(async (..._a: unknown[]) => null),
  project: vi.fn(async (..._a: unknown[]) => true),
  finish: vi.fn(async (..._a: unknown[]) => true),
}));

vi.mock("@/lib/one-number/session.server", () => ({ loadThreadPause: m.loadPause }));
vi.mock("@/lib/claw-leasing-bot.server", () => ({ handleClawLeasingInbound: m.leasing }));
vi.mock("@/lib/tools/resident-sms-context", () => ({ resolveResidentSmsAgentContext: m.residentCtx }));
vi.mock("@/lib/agent/resident-sms-agent.server", () => ({ runResidentSmsAgentTurn: m.residentTurn, deliverResidentSmsReply: vi.fn() }));
vi.mock("@/lib/agent/vendor-agent.server", () => ({ resolveVendorAgentSessionForInbound: m.vendorResolve, runVendorAgentSessionTurn: m.vendorTurn }));
vi.mock("@/lib/sms/manager-sms-access.server", () => ({ resolveManagerSmsInboundIdentity: m.managerIdentity }));
vi.mock("@/lib/sms/project-manager-sms-event.server", () => ({ projectManagerSmsEvent: m.project }));
vi.mock("@/lib/sms/inbound-replay.server", () => ({
  attachInboundOutbox: vi.fn(async () => true),
  finishInboundClaim: m.finish,
  loadInboundReplay: vi.fn(async () => ({ ok: true, receipt: null })),
  prepareInboundReply: vi.fn(async () => true),
}));
vi.mock("@/lib/comms-billing/record-usage.server", () => ({ recordManagerCommsUsage: vi.fn(async () => undefined) }));
vi.mock("@/lib/sms/inbound-text-routing.server", () => ({ routeUnrecognizedInboundText: vi.fn(async () => ({ kind: "potential", created: false, name: null })) }));
vi.mock("@/lib/sms/manager-workspace-role.server", () => ({
  resolveWorkspaceOwnerForWorkNumber: vi.fn(async (_db: unknown, owner: string) => ({ ownerUserId: owner, sharedFromCoManager: false, workspaceId: null })),
}));
vi.mock("@/lib/sms/manager-sms-contacts.server", () => ({ upsertManagerSmsContact: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/sms/manager-relay.server", () => ({ forwardResidentInboundToManagerCell: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/sms/inbound-forward-team.server", () => ({ forwardInboundToTeammates: vi.fn(async () => undefined), resolveResidentForwardHouseId: vi.fn(async () => null) }));
vi.mock("@/lib/workspace-team-fanout.server", () => ({ fanOutWorkspaceNotice: vi.fn(async () => ({ notified: 0 })), repliedNoticeText: (t: string) => t }));
vi.mock("@/lib/claw-leasing-links", () => ({ isClawSharedLineBridgeEnabled: () => true }));

import { runClaimedInbound, type ClaimedInbound } from "@/lib/sms/inbound-pipeline.server";

const PAYLOAD = {
  fromPhone: "+12065550142", toPhone: "+12065550100", body: "is anyone there?", workspaceId: "ws-a", media: {}, runtime: "development",
};

/** Every query chain resolves empty; the receipt envelope the claim stored is returned for its own lookup. */
function fakeDb(payload: Record<string, unknown>) {
  const envelope = { manager_user_id: "owner-a", first_received_at: "2026-10-18T12:00:00.000Z", inbound_payload: payload };
  return {
    rpc: async () => ({ data: null, error: null }),
    from(table: string) {
      const chain: Record<string, unknown> = new Proxy({}, {
        get(_t, prop: string) {
          if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
          if (prop === "maybeSingle") return async () => ({ data: table === "sms_inbound_receipts" ? envelope : null, error: null });
          return () => chain;
        },
      });
      return chain;
    },
  } as never;
}

const claim = (over: Partial<ClaimedInbound> = {}): ClaimedInbound => ({
  ...PAYLOAD, messageSid: "SM1", managerId: "owner-a", inboundWorkerId: "w1", mark: () => undefined, ...over,
});

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockClear();
  m.loadPause.mockResolvedValue(null);
});

describe("a paused shared-line thread", () => {
  it("skips every agent, still projects the text for the team, and completes the claim", async () => {
    m.loadPause.mockResolvedValue({ role: "resident", reason: "human_keyword" });
    const res = await runClaimedInbound(fakeDb({ ...PAYLOAD, sharedLine: true }), claim({ sharedLine: true }));
    expect(res.status).toBe(200);
    expect(m.loadPause).toHaveBeenCalledWith(expect.anything(), "2065550142", "ws-a");
    expect(m.leasing).not.toHaveBeenCalled();
    expect(m.residentCtx).not.toHaveBeenCalled();
    expect(m.residentTurn).not.toHaveBeenCalled();
    expect(m.vendorResolve).not.toHaveBeenCalled();
    expect(m.vendorTurn).not.toHaveBeenCalled();
    expect(m.project).toHaveBeenCalledTimes(1);
    expect(m.project.mock.calls[0][1]).toMatchObject({ ownerManagerUserId: "owner-a", counterpartyRole: "resident", direction: "inbound", body: "is anyone there?" });
    expect(m.finish).toHaveBeenCalledWith(expect.anything(), "SM1", "w1", "completed");
  });

  it("is checked against THIS workspace only: another team's pause is a different key", async () => {
    m.loadPause.mockImplementation(async (...args: unknown[]) => (args[2] === "ws-b" ? { role: "vendor", reason: "human_keyword" } : null));
    await runClaimedInbound(fakeDb({ ...PAYLOAD, sharedLine: true }), claim({ sharedLine: true }));
    expect(m.leasing).toHaveBeenCalledTimes(1);
  });

  it("an unpaused shared-line thread runs the agent as usual", async () => {
    const res = await runClaimedInbound(fakeDb({ ...PAYLOAD, sharedLine: true }), claim({ sharedLine: true }));
    expect(res.status).toBe(200);
    expect(m.loadPause).toHaveBeenCalledTimes(1);
    expect(m.leasing).toHaveBeenCalledTimes(1);
  });

  it("outside the shared line the pause table is never read: the pipeline behaves exactly as before", async () => {
    m.loadPause.mockResolvedValue({ role: "resident", reason: "human_keyword" });
    await runClaimedInbound(fakeDb(PAYLOAD), claim());
    expect(m.loadPause).not.toHaveBeenCalled();
    expect(m.leasing).toHaveBeenCalledTimes(1);
  });

  it("a recovery rerun keeps the flag from the stored receipt, not the in-memory claim", async () => {
    m.loadPause.mockResolvedValue({ role: "prospect", reason: "human_keyword" });
    await runClaimedInbound(fakeDb({ ...PAYLOAD, sharedLine: true }), claim());
    expect(m.leasing).not.toHaveBeenCalled();
  });
});

describe("the inbound route seam", () => {
  const route = readFileSync("src/app/api/twilio/inbound/route.ts", "utf8");

  it("runs after STOP/START/HELP and before vendor identity ingest, and only in shared mode", () => {
    const control = route.indexOf("apply_sms_control_keyword");
    const seam = route.indexOf("handleSharedLineInbound(db");
    const vendor = route.indexOf("ingestVendorWorkIdentitySms(db");
    expect(control).toBeGreaterThan(-1);
    expect(seam).toBeGreaterThan(control);
    expect(seam).toBeLessThan(vendor);
    expect(route).toContain('lineConfig.mode === "shared"');
  });

  it("shadow mode records after the response and only for a normal work-number text", () => {
    const shadow = route.indexOf('lineConfig.mode === "shadow" && !sharedLine');
    expect(shadow).toBeGreaterThan(route.indexOf("resolveWorkspaceOwnerForWorkNumber(db, numberOwnerId"));
    expect(route.slice(shadow, shadow + 700)).toContain("after(");
  });
});
