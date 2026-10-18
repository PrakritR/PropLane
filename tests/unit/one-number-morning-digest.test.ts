import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  members: vi.fn(),
  access: vi.fn(),
  identity: vi.fn(),
  tours: vi.fn(),
  services: vi.fn(),
  rent: vi.fn(),
  leads: vi.fn(),
  sms: vi.fn(),
}));
vi.mock("@/lib/one-number/config.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/one-number/config.server")>("@/lib/one-number/config.server");
  return { ...actual, loadSharedLineConfig: mocks.config };
});
vi.mock("@/lib/team-comms.server", () => ({ resolveWorkspaceTeamMembersWithGrants: mocks.members }));
vi.mock("@/lib/sms/manager-sms-access.server", () => ({ resolveManagerSmsAccess: mocks.access }));
vi.mock("@/lib/tools/manager-sms-context", () => ({ resolveManagerSmsAgentContext: mocks.identity }));
vi.mock("@/lib/one-number/ops-facts.server", () => ({
  toursOnDay: mocks.tours,
  openServiceCount: mocks.services,
  rentStatusFor: mocks.rent,
  newLeadCount: mocks.leads,
}));
vi.mock("@/lib/manager-notification-routing.server", () => ({ sendManagerNotificationSms: mocks.sms }));

import { MORNING_DIGEST_HOUR_PACIFIC, morningDigestWanted, pacificHour, runMorningDigests } from "@/lib/one-number/morning-digest.server";

const OWNER = "owner-1";
const MATE = "mate-1";
const PDT_8AM = new Date("2026-10-19T15:00:00Z");

function db(settings: Array<{ id: string; wanted: string | null }> = [], workspaces = [{ id: "ws-a", owner_user_id: OWNER }]) {
  return createMemoryDb({
    portal_workspaces: workspaces,
    manager_automation_settings: settings.map((s) => ({ manager_user_id: s.id, wanted: s.wanted })),
  }) as never;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.config.mockResolvedValue({ mode: "shared", sharedNumber: "+12065550000", messagingServiceSid: null, pilotWorkspaceIds: [] });
  mocks.members.mockResolvedValue([{ userId: OWNER, isOwner: true, teamRole: null, grantRow: null }]);
  mocks.access.mockResolvedValue({ mode: "delegated", workNumberOwnerId: OWNER, actorUserId: MATE, dataOwnerIds: [OWNER], assignedPropertyIds: ["p1"] });
  mocks.identity.mockImplementation(async (_db: unknown, args: { actorUserId?: string; workspaceId: string }) => ({
    ok: true,
    ctx: { landlordId: OWNER, userId: args.actorUserId ?? OWNER, workspace: { id: args.workspaceId } },
  }));
  mocks.tours.mockResolvedValue({ day: "2026-10-19", confirmed: [{}, {}], requests: [] });
  mocks.services.mockResolvedValue(3);
  mocks.rent.mockResolvedValue({ month: "2026-10", paidCount: 14, unpaidCount: 3, paidCents: 0, unpaidCents: 285_000, unpaid: [] });
  mocks.leads.mockResolvedValue(2);
  mocks.sms.mockResolvedValue({ sent: true });
});

describe("who gets the morning text", () => {
  it("is on for the owner and off for a teammate until they choose", () => {
    expect(morningDigestWanted(null, true)).toBe(true);
    expect(morningDigestWanted(undefined, false)).toBe(false);
    expect(morningDigestWanted(false, true)).toBe(false);
    expect(morningDigestWanted(true, false)).toBe(true);
  });
});

describe("pacificHour", () => {
  it("is 8 at 8am Pacific in both halves of the year", () => {
    expect(MORNING_DIGEST_HOUR_PACIFIC).toBe(8);
    expect(pacificHour(new Date("2026-10-19T15:00:00Z"))).toBe(8); // PDT
    expect(pacificHour(new Date("2026-12-15T16:00:00Z"))).toBe(8); // PST
    expect(pacificHour(new Date("2026-12-15T15:00:00Z"))).toBe(7);
  });
});

describe("runMorningDigests", () => {
  it("does nothing outside 8am Pacific", async () => {
    const summary = await runMorningDigests(db(), { now: () => new Date("2026-10-19T20:00:00Z") });
    expect(summary.skippedReason).toBe("not_8am");
    expect(mocks.sms).not.toHaveBeenCalled();
  });

  it("does nothing while the line is not shared (today's behaviour is untouched)", async () => {
    for (const mode of ["per_workspace", "shadow"]) {
      mocks.config.mockResolvedValue({ mode, sharedNumber: null, messagingServiceSid: null, pilotWorkspaceIds: [] });
      const summary = await runMorningDigests(db(), { now: () => PDT_8AM });
      expect(summary.skippedReason).toBe("not_shared_mode");
    }
    expect(mocks.sms).not.toHaveBeenCalled();
  });

  it("texts the owner by default, once, with the math from the facts and a per-day key", async () => {
    const summary = await runMorningDigests(db(), { now: () => PDT_8AM });
    expect(summary).toMatchObject({ workspaces: 1, sent: 1, skipped: 0 });
    expect(mocks.sms).toHaveBeenCalledTimes(1);
    expect(mocks.sms.mock.calls[0]![1]).toMatchObject({
      managerUserId: OWNER,
      category: "attention_digest",
      subject: "Good morning",
      text: "2 tours today, 3 open services, rent 14 paid, 3 unpaid ($2,850), 2 new leads.",
      dedupeKey: `morning-digest:ws-a:${OWNER}:2026-10-19`,
      workspaceId: "ws-a",
    });
    expect(mocks.sms.mock.calls[0]![1]).not.toHaveProperty("sendFrom");
  });

  it("respects an owner who turned it off", async () => {
    const summary = await runMorningDigests(db([{ id: OWNER, wanted: "false" }]), { now: () => PDT_8AM });
    expect(summary.sent).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(mocks.sms).not.toHaveBeenCalled();
  });

  it("texts a teammate only if they opted in, from the owner's line, in their own scope", async () => {
    mocks.members.mockResolvedValue([
      { userId: OWNER, isOwner: true, teamRole: null, grantRow: null },
      { userId: MATE, isOwner: false, teamRole: "property_manager", grantRow: {} },
    ]);
    // Teammate has not chosen: only the owner is texted.
    let summary = await runMorningDigests(db(), { now: () => PDT_8AM });
    expect(summary.sent).toBe(1);
    expect(mocks.sms.mock.calls.map((c) => c[1].managerUserId)).toEqual([OWNER]);

    // Teammate opts in.
    vi.clearAllMocks();
    mocks.sms.mockResolvedValue({ sent: true });
    summary = await runMorningDigests(db([{ id: MATE, wanted: "true" }]), { now: () => PDT_8AM });
    expect(summary.sent).toBe(2);
    const mate = mocks.sms.mock.calls.find((c) => c[1].managerUserId === MATE)![1];
    expect(mate.sendFrom).toEqual({ ownerUserId: OWNER, workspaceId: "ws-a" });
    expect(mate.dedupeKey).toBe(`morning-digest:ws-a:${MATE}:2026-10-19`);
    // Their numbers were computed in THEIR scope: delegated access, and no lead count for a houses-only teammate.
    expect(mocks.identity.mock.calls.find((c) => c[1].actorUserId === MATE)![1]).toMatchObject({ managerUserId: OWNER, workspaceId: "ws-a", access: expect.objectContaining({ mode: "delegated" }) });
    expect(mocks.leads).toHaveBeenCalledTimes(1);
  });

  it("skips a teammate whose assignment can no longer be resolved", async () => {
    mocks.members.mockResolvedValue([{ userId: MATE, isOwner: false, teamRole: "viewer", grantRow: {} }]);
    mocks.access.mockResolvedValue(null);
    const summary = await runMorningDigests(db([{ id: MATE, wanted: "true" }]), { now: () => PDT_8AM });
    expect(summary.sent).toBe(0);
    expect(mocks.sms).not.toHaveBeenCalled();
  });

  it("builds each workspace's digest in that workspace only", async () => {
    const two = db([], [
      { id: "ws-a", owner_user_id: OWNER },
      { id: "ws-b", owner_user_id: "owner-2" },
    ]);
    mocks.members.mockImplementation(async (_d: unknown, args: { ownerManagerUserId: string }) => [{ userId: args.ownerManagerUserId, isOwner: true, teamRole: null, grantRow: null }]);
    const summary = await runMorningDigests(two, { now: () => PDT_8AM });
    expect(summary.workspaces).toBe(2);
    expect(mocks.identity.mock.calls.map((c) => [c[1].managerUserId, c[1].workspaceId])).toEqual([[OWNER, "ws-a"], ["owner-2", "ws-b"]]);
    // Each fact reader got the context of its own workspace.
    expect(mocks.tours.mock.calls.map((c) => c[0].workspace.id)).toEqual(["ws-a", "ws-b"]);
    expect(mocks.sms.mock.calls.map((c) => c[1].managerUserId)).toEqual([OWNER, "owner-2"]);
  });

  it("only serves workspaces on the shared line when a pilot list is set", async () => {
    mocks.config.mockResolvedValue({ mode: "shared", sharedNumber: "+12065550000", messagingServiceSid: null, pilotWorkspaceIds: ["ws-b"] });
    const two = db([], [
      { id: "ws-a", owner_user_id: OWNER },
      { id: "ws-b", owner_user_id: "owner-2" },
    ]);
    mocks.members.mockImplementation(async (_d: unknown, args: { ownerManagerUserId: string }) => [{ userId: args.ownerManagerUserId, isOwner: true, teamRole: null, grantRow: null }]);
    await runMorningDigests(two, { now: () => PDT_8AM });
    expect(mocks.sms.mock.calls.map((c) => c[1].managerUserId)).toEqual(["owner-2"]);
  });

  it("sends nothing when there is nothing to say", async () => {
    mocks.tours.mockResolvedValue({ day: "d", confirmed: [], requests: [] });
    mocks.services.mockResolvedValue(0);
    mocks.rent.mockResolvedValue({ month: "m", paidCount: 0, unpaidCount: 0, paidCents: 0, unpaidCents: 0, unpaid: [] });
    mocks.leads.mockResolvedValue(0);
    const summary = await runMorningDigests(db(), { now: () => PDT_8AM });
    expect(summary).toMatchObject({ sent: 0, empty: 1 });
    expect(mocks.sms).not.toHaveBeenCalled();
  });

  it("counts a refused send (their own settings, no phone) as skipped, and a throw as failed", async () => {
    mocks.sms.mockResolvedValueOnce({ sent: false, reason: "not_routed" });
    expect((await runMorningDigests(db(), { now: () => PDT_8AM })).skipped).toBe(1);
    mocks.sms.mockRejectedValueOnce(new Error("boom"));
    expect((await runMorningDigests(db(), { now: () => PDT_8AM })).failed).toBe(1);
  });
});
