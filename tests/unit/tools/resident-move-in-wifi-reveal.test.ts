import { beforeEach, describe, expect, it, vi } from "vitest";

const reveal = vi.hoisted(() => ({ current: { revealed: false, reason: "not_yet", revealAtIso: "2026-11-19T18:00:00.000Z" } as Record<string, unknown> }));
vi.mock("@/lib/check-in.server", () => ({ residentCheckInReveal: vi.fn(async () => reveal.current) }));

import { getMoveInInfoTool } from "@/lib/tools/domains/resident/lease";
import { emptyHouseInfo, setHouseInfoValue } from "@/lib/house-info";
import { RESIDENT_SYSTEM_PROMPT } from "@/lib/agent/system-prompts";
import { RESIDENT_SYSTEM_PROMPT as PORTAL_PROMPT } from "@/lib/agent/resident-system-prompt";
import { makeResidentToolCtx, type FakeRow } from "./fake-resident-ctx";

const RESIDENT = { id: "resident_a", email: "resa@axis.test" };

function tables(): Record<string, FakeRow[]> {
  let info = setHouseInfoValue(emptyHouseInfo(), "wifi", "network", "NET-MAPLE");
  info = setHouseInfoValue(info, "wifi", "password", "WIFIPASS-9911");
  info = setHouseInfoValue(info, "access", "doorCode", "FRONTDOOR-7788");
  info = setHouseInfoValue(info, "internal", "lockboxCode", "LOCKBOX-INTERNAL-5521");
  info = setHouseInfoValue(info, "internal", "pantryCode", "PANTRY-INTERNAL-3310");
  return {
    manager_application_records: [
      {
        id: "APP-A",
        manager_user_id: "manager_1",
        resident_email: RESIDENT.email,
        updated_at: "2026-06-01T00:00:00.000Z",
        row_data: {
          id: "APP-A",
          residentUserId: RESIDENT.id,
          email: RESIDENT.email,
          bucket: "approved",
          stage: "Approved",
          property: "Maple House",
          assignedPropertyId: "prop_1",
          manualResidentDetails: { roomNumber: "Room A" },
        },
      },
    ],
    manager_property_records: [
      {
        id: "prop_1",
        manager_user_id: "manager_1",
        row_data: {},
        property_data: {
          id: "prop_1",
          title: "Maple House",
          buildingName: "Maple House",
          address: "1 Maple St, Seattle, WA",
          listingSubmission: {
            v: 1,
            buildingName: "Maple House",
            address: "1 Maple St, Seattle, WA",
            zip: "98115",
            houseRulesText: "RULES-QUIET-AFTER-10",
            rooms: [
              { id: "room_a", name: "Room A", doorCode: "OWNROOM-1111" },
              { id: "room_b", name: "Room B", doorCode: "PEERROOM-2222" },
            ],
            bathrooms: [],
            sharedSpaces: [],
            quickFacts: [],
            bundles: [],
            housePhotoDataUrls: [],
            houseInfo: info,
          },
        },
      },
    ],
  };
}

const ALWAYS_HIDDEN = ["PEERROOM-2222", "LOCKBOX-INTERNAL-5521", "PANTRY-INTERNAL-3310"];
type Res = { codesLocked?: boolean; codesNotice?: string; moveIn: { wifiNetworkName: string | null; wifiPassword: string | null; roomDoorCode: string | null } };

describe("get_move_in_info: Wi-Fi and move-in details for a resident", () => {
  beforeEach(() => {
    reveal.current = { revealed: false, reason: "not_yet", revealAtIso: "2026-11-19T18:00:00.000Z" };
  });

  it("before the reveal: network name only, no password, no codes, an unlock time, rules still given", async () => {
    const { ctx } = makeResidentToolCtx(tables(), { moveInDetailsLocked: false });
    const res = (await getMoveInInfoTool.handler(ctx, {})) as Res;
    const json = JSON.stringify(res);
    expect(res.moveIn.wifiNetworkName).toBe("NET-MAPLE");
    expect(res.moveIn.wifiPassword).toBeNull();
    expect(res.moveIn.roomDoorCode).toBeNull();
    expect(res.codesLocked).toBe(true);
    expect(res.codesNotice).toMatch(/day before check-in/);
    expect(json).toContain("RULES-QUIET-AFTER-10");
    for (const secret of ["WIFIPASS-9911", "FRONTDOOR-7788", "OWNROOM-1111", ...ALWAYS_HIDDEN]) expect(json).not.toContain(secret);
  });

  it("after the reveal: Wi-Fi password and OWN room code only; a peer's room code and Internal never appear", async () => {
    reveal.current = { revealed: true, reason: "revealed", revealAtIso: "2026-11-19T18:00:00.000Z" };
    const { ctx } = makeResidentToolCtx(tables(), { moveInDetailsLocked: false });
    const res = (await getMoveInInfoTool.handler(ctx, {})) as Res;
    const json = JSON.stringify(res);
    expect(res.moveIn.wifiNetworkName).toBe("NET-MAPLE");
    expect(res.moveIn.wifiPassword).toBe("WIFIPASS-9911");
    expect(res.moveIn.roomDoorCode).toBe("OWNROOM-1111");
    expect(json).toContain("RULES-QUIET-AFTER-10");
    for (const secret of ALWAYS_HIDDEN) expect(json).not.toContain(secret);
  });

  it("a resident who has not signed (phase not approved) gets no Wi-Fi at all", async () => {
    reveal.current = { revealed: true, reason: "revealed", revealAtIso: null };
    const { ctx } = makeResidentToolCtx(tables(), { moveInDetailsLocked: false, phase: "applicant" as never });
    const json = JSON.stringify(await getMoveInInfoTool.handler(ctx, {}));
    for (const secret of ["WIFIPASS-9911", "NET-MAPLE", "OWNROOM-1111", ...ALWAYS_HIDDEN]) expect(json).not.toContain(secret);
  });

  it("both resident prompts send move-in / Wi-Fi questions to get_move_in_info", () => {
    expect(RESIDENT_SYSTEM_PROMPT).toContain("get_move_in_info");
    expect(PORTAL_PROMPT).toContain("get_move_in_info");
  });
});
