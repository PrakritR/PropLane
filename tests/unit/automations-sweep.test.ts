import { beforeEach, describe, expect, it, vi } from "vitest";
import { automationsFakeDb } from "../helpers/automations-fake-db";
import { emptyHouseInfo, setHouseInfoValue } from "@/lib/house-info";
import type { HouseSubject, LeaseSubject } from "@/lib/automations/moments";

const h = vi.hoisted(() => ({
  mode: "per_workspace" as "per_workspace" | "shared",
  leases: [] as unknown[],
  houses: new Map<string, unknown>(),
  rentDue: new Set<string>(),
  services: [] as unknown[],
  locked: false,
  send: vi.fn(),
  post: vi.fn(),
  ready: vi.fn(),
}));

vi.mock("@/lib/one-number/config.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/one-number/config.server")>();
  return {
    ...actual,
    loadSharedLineConfig: async () => ({ mode: h.mode, sharedNumber: "+12065550000", messagingServiceSid: null, pilotWorkspaceIds: [] }),
  };
});
vi.mock("@/lib/automations/sources.server", () => ({
  loadLeaseSubjects: async () => h.leases,
  loadHouseDirectory: async () => h.houses,
  loadRentDueToday: async () => h.rentDue,
  loadRecentlyScheduledServices: async () => h.services,
}));
vi.mock("@/lib/one-number/links.server", () => ({ mintPhoneBoundLink: async () => ({ url: "https://proplane.ai/l/tok" }) }));
vi.mock("@/lib/tools/resident-context", () => ({
  loadMoveInDetailsLock: async () => ({ moveInDetailsLocked: h.locked, moveInDetailsLockFormId: null, moveInDetailsLockReadFailed: false }),
}));
vi.mock("@/lib/automations/send.server", () => ({ sendResidentAutomationText: h.send }));
vi.mock("@/lib/house-groups/post.server", () => ({ postToHouseGroup: h.post }));
vi.mock("@/lib/house-groups/ready.server", () => ({ houseGroupReady: h.ready }));

import { runAutomationSweep } from "@/lib/automations/sweep.server";

// 2026-11-01 10:00 PST (DST ended that morning).
const NOW = new Date("2026-11-01T18:00:00Z");

const lease = (over: Partial<LeaseSubject> = {}): LeaseSubject => ({
  leaseId: "L1",
  ownerUserId: "owner",
  workspaceId: "ws",
  propertyId: "P1",
  propertyLabel: "5259 Brooklyn",
  roomLabel: "Room 3",
  residentName: "Maya Chen",
  firstName: "Maya",
  residentUserId: "u1",
  residentEmail: "maya@example.com",
  phoneKey: "2065550100",
  signedKey: "2026-11-01",
  moveIn: "2026-11-03",
  moveOut: null,
  ...over,
});

function seedHouse() {
  let info = emptyHouseInfo();
  info = setHouseInfoValue(info, "access", "doorCode", "4821");
  info = setHouseInfoValue(info, "wifi", "network", "BrooklynNet");
  info = setHouseInfoValue(info, "wifi", "password", "Sunset-Maple-9");
  info = setHouseInfoValue(info, "access", "parking", "Street parking");
  const house: HouseSubject = { ownerUserId: "owner", workspaceId: "ws", propertyId: "P1", propertyLabel: "5259 Brooklyn", houseInfo: info, roomSecrets: [] };
  return house;
}

const optedIn = (mode: string) => ({ workspace_automation_presets: [{ workspace_id: "ws", preset: "welcome", mode }] });

beforeEach(() => {
  h.mode = "per_workspace";
  h.leases = [lease()];
  h.houses = new Map([["P1", seedHouse()]]);
  h.rentDue = new Set();
  h.services = [];
  h.locked = false;
  h.send.mockReset().mockResolvedValue({ ok: true });
  h.post.mockReset().mockResolvedValue({ ok: true, messageSid: "SM" });
  h.ready.mockReset().mockResolvedValue(true);
});

describe("runAutomationSweep", () => {
  it("fires nothing for a workspace that never opened Automations and is not on the shared line", async () => {
    const f = automationsFakeDb();
    const summary = await runAutomationSweep(f.db, NOW);
    expect(summary.fired).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
    expect(f.rows.workspace_automation_runs ?? []).toHaveLength(0);
  });

  it("serves a workspace on the shared line with every new preset in draft", async () => {
    h.mode = "shared";
    const f = automationsFakeDb();
    const summary = await runAutomationSweep(f.db, NOW);
    expect(summary.fired).toBe(2);
    expect(h.send).not.toHaveBeenCalled();
    expect((f.rows.workspace_automation_runs ?? []).map((r) => r.preset).sort()).toEqual(["move_in_3d", "welcome"]);
    expect((f.rows.workspace_automation_runs ?? []).every((r) => r.status === "held")).toBe(true);
  });

  it("sends the welcome and the move-in details in auto, each exactly once across ticks", async () => {
    const f = automationsFakeDb({
      workspace_automation_presets: [
        { workspace_id: "ws", preset: "welcome", mode: "auto" },
        { workspace_id: "ws", preset: "move_in_3d", mode: "auto" },
      ],
    });
    expect((await runAutomationSweep(f.db, NOW)).fired).toBe(2);
    expect((await runAutomationSweep(f.db, new Date(NOW.getTime() + 5 * 60_000))).fired).toBe(0);
    const texts = h.send.mock.calls.map((c) => String(c[1].text));
    expect(h.send).toHaveBeenCalledTimes(2);
    const details = texts.find((t) => t.includes("Door code"))!;
    expect(details).toContain("Door code 4821");
    expect(details).toContain("Wi-Fi BrooklynNet, password Sunset-Maple-9");
    expect(texts.find((t) => t.startsWith("Welcome, Maya!"))).toContain("https://proplane.ai/l/tok");
  });

  it("keeps the door code and Wi-Fi password out of the text while move-in details are locked", async () => {
    h.locked = true;
    const f = automationsFakeDb({ workspace_automation_presets: [{ workspace_id: "ws", preset: "move_in_3d", mode: "auto" }] });
    await runAutomationSweep(f.db, NOW);
    const text = String(h.send.mock.calls[0]![1].text);
    expect(text).not.toMatch(/4821|Sunset|Door code|password/);
    expect(text).toContain("move-in is Nov 3");
  });

  it("never texts a resident with no verified phone", async () => {
    h.leases = [lease({ phoneKey: null })];
    const f = automationsFakeDb(optedIn("auto"));
    const summary = await runAutomationSweep(f.db, NOW);
    expect(summary.no_phone).toBeGreaterThan(0);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("posts the rent-due reminder to the house group once, with no amount or name", async () => {
    h.leases = [];
    h.rentDue = new Set(["P1"]);
    h.houses = new Map([["P1", seedHouse()]]);
    // houses are read from the leases' properties, so seed a lease-less house through a roster of one.
    h.leases = [lease({ signedKey: "2026-01-01", moveIn: "2026-01-10" })];
    const f = automationsFakeDb({ workspace_automation_presets: [{ workspace_id: "ws", preset: "rent_due_day", mode: "auto" }] });
    await runAutomationSweep(f.db, NOW);
    await runAutomationSweep(f.db, new Date(NOW.getTime() + 5 * 60_000));
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post.mock.calls[0]![1].text).toBe("Friendly reminder: rent is due today. Check your texts for your pay link.");
  });

  it("tells the house about a booked service only when it is house-wide, and never names a resident", async () => {
    h.leases = [lease({ signedKey: "2026-01-01", moveIn: "2026-01-10" })];
    h.services = [
      { entityId: "W1", ownerUserId: "owner", propertyId: "P1", unit: "Common area", title: "Kitchen sink", window: "Tue 10-12", scheduledAtIso: "2026-11-03T18:00:00Z" },
      { entityId: "W2", ownerUserId: "owner", propertyId: "P1", unit: "Room 3", title: "Heater", window: "Wed 2-4", scheduledAtIso: null },
    ];
    h.ready.mockResolvedValue(false);
    const f = automationsFakeDb({ workspace_automation_presets: [{ workspace_id: "ws", preset: "maintenance_booked", mode: "auto" }] });
    await runAutomationSweep(f.db, NOW);
    // No group: the house-wide notice falls back to each resident one on one.
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(String(h.send.mock.calls[0]![1].text)).toBe("Service visit booked at 5259 Brooklyn: Kitchen sink, Tue 10-12. Please keep the area clear.");
    expect(h.send.mock.calls[0]![1].idempotencyKey).toBe("maintenance:W1:2026-11-03T18:00:00Z:2065550100");
  });
});
