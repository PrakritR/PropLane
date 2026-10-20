import { beforeEach, describe, expect, it, vi } from "vitest";
import { automationsFakeDb } from "../helpers/automations-fake-db";
import { emptyHouseInfo, setHouseInfoValue } from "@/lib/house-info";

const h = vi.hoisted(() => ({ send: vi.fn(), post: vi.fn(), ready: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/automations/send.server", () => ({ sendResidentAutomationText: h.send }));
vi.mock("@/lib/house-groups/post.server", () => ({ postToHouseGroup: h.post }));
vi.mock("@/lib/house-groups/ready.server", () => ({ houseGroupReady: h.ready }));
vi.mock("../../src/lib/tools/audit", () => ({ writeAuditLog: h.audit }));
vi.mock("@/lib/automations/sources.server", () => ({
  loadHouseDirectory: async (_db: unknown, ids: string[]) =>
    new Map(
      ids.map((id) => [
        id,
        {
          ownerUserId: "owner", workspaceId: "ws", propertyId: id, propertyLabel: id === "P1" ? "5259 Brooklyn" : "4709A 8th Ave",
          houseInfo: setHouseInfoValue(emptyHouseInfo(), "access", "doorCode", "4821"),
        },
      ]),
    ),
  loadLeaseSubjects: async () => [
    { leaseId: "L1", ownerUserId: "owner", workspaceId: "ws", propertyId: "P1", propertyLabel: "5259 Brooklyn", roomLabel: null, residentName: "Maya Chen", firstName: "Maya", residentUserId: "u1", residentEmail: "m@x.com", phoneKey: "2065550100", signedKey: null, moveIn: null, moveOut: null },
  ],
}));

import { announceToHouseTool, announcementIdFor } from "@/lib/tools/domains/announce";

const houses = [
  { id: "P1", manager_user_id: "owner", workspace_id: "ws", property_data: { title: "5259 Brooklyn" } },
  { id: "P2", manager_user_id: "owner", workspace_id: "ws", property_data: { title: "4709A 8th Ave" } },
];

function ctx(over: Record<string, unknown> = {}, ids = ["P1", "P2"]) {
  const fake = automationsFakeDb({
    manager_property_records: houses,
    workspace_automation_presets: [{ workspace_id: "ws", preset: "announcement", mode: "auto" }],
  });
  return {
    fake,
    ctx: { landlordId: "owner", userId: "owner", db: fake.db, workspace: { id: "ws", name: "W", isDefault: true, narrowing: false, propertyIds: ids }, ...over } as never,
  };
}

beforeEach(() => {
  h.send.mockReset().mockResolvedValue({ ok: true });
  h.post.mockReset().mockResolvedValue({ ok: true, messageSid: "SM" });
  h.ready.mockReset().mockResolvedValue(false);
  h.audit.mockReset().mockResolvedValue({ recorded: true });
});

describe("announce_to_house", () => {
  it("asks which house when there are several and none is named", async () => {
    const { ctx: c } = ctx();
    await expect(announceToHouseTool.preview(c, { text: "Water is off Tuesday 9-12." })).rejects.toThrow(/Which house: 5259 Brooklyn, 4709A 8th Ave, or all\?/);
  });

  it("previews a named house and a single-house workspace without asking", async () => {
    const { ctx: c } = ctx();
    const preview = await announceToHouseTool.preview(c, { text: "Water is off Tuesday 9-12.", houseIds: ["P1"] });
    expect(preview.fields).toEqual([{ label: "Houses", value: "5259 Brooklyn" }, { label: "Text", value: "Water is off Tuesday 9-12." }]);
    const solo = ctx({}, ["P1"]);
    await expect(announceToHouseTool.preview(solo.ctx, { text: "Water is off." })).resolves.toMatchObject({ kind: "announce_to_house" });
  });

  it("refuses a name, an amount or the door code, and says why", async () => {
    const { ctx: c } = ctx();
    await expect(announceToHouseTool.preview(c, { text: "Maya, move your bike", houseIds: ["P1"] })).rejects.toThrow(/cannot name a resident/);
    await expect(announceToHouseTool.preview(c, { text: "Rent is $900", allHouses: true })).rejects.toThrow(/Money stays one on one/);
    await expect(announceToHouseTool.preview(c, { text: "Code is 4821", allHouses: true })).rejects.toThrow(/never go in a group text/);
  });

  it("never reaches a house outside the actor's workspace, whatever id the model sends", async () => {
    const { ctx: c } = ctx({}, ["P1"]);
    await expect(announceToHouseTool.preview(c, { text: "Water is off.", houseIds: ["P2"] })).rejects.toThrow(/None of those houses are yours/);
  });

  it("needs a resolved workspace", async () => {
    const { ctx: c } = ctx({ workspace: undefined });
    await expect(announceToHouseTool.preview(c, { text: "Water is off.", allHouses: true })).rejects.toThrow(/workspace/);
  });

  it("sends on confirm, once: the same text in the same hour is the same announcement", async () => {
    const { ctx: c } = ctx({}, ["P1"]);
    const out = await announceToHouseTool.handler(c, { text: "Water is off Tuesday 9-12." });
    expect(out.reply).toBe("Announced to 1 house.");
    expect(h.send).toHaveBeenCalledTimes(1);
    h.audit.mockResolvedValueOnce({ recorded: false, duplicate: true });
    expect((await announceToHouseTool.handler(c, { text: "Water is off Tuesday 9-12." })).reply).toBe("That announcement already went out.");
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("tells the manager when announcements are off or waiting", async () => {
    const off = automationsFakeDb({ manager_property_records: houses, workspace_automation_presets: [{ workspace_id: "ws", preset: "announcement", mode: "off" }] });
    const c = { landlordId: "owner", userId: "owner", db: off.db, workspace: { id: "ws", name: "W", isDefault: true, narrowing: false, propertyIds: ["P1"] } } as never;
    expect((await announceToHouseTool.handler(c, { text: "Water is off." })).reply).toMatch(/switched off/);
    const draft = automationsFakeDb({ manager_property_records: houses, workspace_automation_presets: [{ workspace_id: "ws", preset: "announcement", mode: "draft" }] });
    const d = { landlordId: "owner", userId: "owner", db: draft.db, workspace: { id: "ws", name: "W", isDefault: true, narrowing: false, propertyIds: ["P1"] } } as never;
    expect((await announceToHouseTool.handler(d, { text: "Water is off." })).reply).toMatch(/waiting for your approval/);
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe("announcementIdFor", () => {
  const base = { ownerUserId: "o", workspaceId: "w", houseIds: ["P2", "P1"], text: " Water is off ", now: new Date("2026-11-01T10:05:00Z") };
  it("is stable within the hour regardless of house order, and changes with the text or the hour", () => {
    const a = announcementIdFor(base);
    expect(announcementIdFor({ ...base, houseIds: ["P1", "P2"], now: new Date("2026-11-01T10:55:00Z") })).toBe(a);
    expect(announcementIdFor({ ...base, text: "Water is on" })).not.toBe(a);
    expect(announcementIdFor({ ...base, now: new Date("2026-11-01T11:05:00Z") })).not.toBe(a);
  });
});
