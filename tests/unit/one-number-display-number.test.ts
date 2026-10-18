import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

vi.mock("@/lib/one-number/personal-number-entitlement.server", () => ({
  managerPersonalNumberEntitlement: vi.fn(async () => ({ ok: true as const, entitled: true as const, via: "plan" as const, tier: "pro" as const })),
}));
const own = vi.hoisted(() => ({} as Record<string, string | null>));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({
  resolveActiveManagerSendNumber: vi.fn(async (_db: unknown, _owner: string, workspaceId?: string | null) => own[workspaceId ?? "default"] ?? null),
}));
vi.mock("@/lib/manager-assistant-email/manager-assistant-email.server", () => ({
  resolveActiveManagerWorkEmail: vi.fn(async () => null),
}));

import { loadDoorCardTextCode } from "@/lib/one-number/entry-codes.server";
import { resolveSharedLineNumberFor, resolveWorkspaceDisplayNumber } from "@/lib/one-number/display-number.server";
import { loadHouseOwnerSmsPhone } from "@/lib/house-printables/load.server";
import { resolveManagerReachabilityForResident } from "@/lib/manager-reachability-for-resident.server";
import { workspaceWorkNumber } from "@/lib/sms/manager-messaging-number";

const OWNER = "owner-1";
const SHARED = "+12065550100";
const OWN = "+12065550111";

function world(mode: "shared" | "per_workspace" = "shared", pilot: string[] = []) {
  return createMemoryDb({
    sms_runtime_config: [{ singleton: true, line_mode: mode, shared_number_e164: SHARED, shared_messaging_service_sid: "MG1", shared_pilot_workspace_ids: pilot }],
    portal_workspaces: [
      { id: "ws-free", name: "Free Homes", owner_user_id: OWNER, is_default: true },
      { id: "ws-pro", name: "Pro Homes", owner_user_id: OWNER, is_default: false },
    ],
    manager_sms_numbers: [{ id: "n-pro", manager_user_id: OWNER, workspace_id: "ws-pro", phone_number: OWN, provision_state: "active", registration_state: "approved", released_at: null }],
    workspace_work_numbers: [],
    manager_property_records: [
      { id: "h-free", manager_user_id: OWNER, workspace_id: "ws-free" },
      { id: "h-pro", manager_user_id: OWNER, workspace_id: "ws-pro" },
    ],
    sms_entry_codes: [
      { code: "FREE5", property_id: "h-free", owner_user_id: OWNER, workspace_id: "ws-free", active: true, created_at: "2026-10-01" },
      { code: "PRO5", property_id: "h-pro", owner_user_id: OWNER, workspace_id: "ws-pro", active: true, created_at: "2026-10-01" },
    ],
    profiles: [{ id: OWNER, phone: null, phone_verified_at: null, sms_from_number: "+12064440999" }],
  });
}

beforeEach(() => {
  for (const key of Object.keys(own)) delete own[key];
  own["ws-pro"] = OWN;
});

describe("resolveWorkspaceDisplayNumber", () => {
  it("shows a workspace's own number when it has one", async () => {
    expect(await resolveWorkspaceDisplayNumber(world() as never, OWNER, "ws-pro")).toBe(OWN);
  });
  it("shows the PropLane line for a workspace on it", async () => {
    expect(await resolveWorkspaceDisplayNumber(world() as never, OWNER, "ws-free")).toBe(SHARED);
    expect(await resolveSharedLineNumberFor(world() as never, OWNER, null)).toBe(SHARED);
  });
  it("never shows the shared line for a workspace that holds a number of its own but cannot send from it yet", async () => {
    own["ws-pro"] = null;
    expect(await resolveWorkspaceDisplayNumber(world() as never, OWNER, "ws-pro")).toBeNull();
  });
  it("shows nothing for a workspace outside the pilot", async () => {
    expect(await resolveWorkspaceDisplayNumber(world("shared", ["ws-pro"]) as never, OWNER, "ws-free")).toBeNull();
  });
  it("per_workspace is exactly today: the own number or nothing", async () => {
    expect(await resolveWorkspaceDisplayNumber(world("per_workspace") as never, OWNER, "ws-free")).toBeNull();
    expect(await resolveWorkspaceDisplayNumber(world("per_workspace") as never, OWNER, "ws-pro")).toBe(OWN);
  });
});

describe("where the number is shown", () => {
  it("the resident welcome reachability line names the number the workspace texts from", async () => {
    const free = await resolveManagerReachabilityForResident(world() as never, OWNER, "ws-free");
    expect(free.workPhoneLabel).toContain("555-0100");
    const pro = await resolveManagerReachabilityForResident(world() as never, OWNER, "ws-pro");
    expect(pro.workPhoneLabel).toContain("555-0111");
  });

  it("the house printable's Text button says the PropLane line for a shared-line house, else the owner's own number", async () => {
    expect(await loadHouseOwnerSmsPhone(world() as never, OWNER, "ws-free")).toBe(SHARED);
    expect(await loadHouseOwnerSmsPhone(world() as never, OWNER, "ws-pro")).toBe("+12064440999");
    expect(await loadHouseOwnerSmsPhone(world("per_workspace") as never, OWNER, "ws-free")).toBe("+12064440999");
  });

  it("the door card prints a text code only for a house on the shared line", async () => {
    const free = await loadDoorCardTextCode(world() as never, { propertyId: "h-free", ownerUserId: OWNER });
    expect(free).toMatchObject({ code: "FREE5" });
    expect(free?.callToAction).toBe("Text FREE5 to (206) 555-0100");
    expect(await loadDoorCardTextCode(world() as never, { propertyId: "h-pro", ownerUserId: OWNER })).toBeNull();
    expect(await loadDoorCardTextCode(world("per_workspace") as never, { propertyId: "h-free", ownerUserId: OWNER })).toBeNull();
  });
});

describe("workspaceWorkNumber (the client's one answer)", () => {
  it("an owner with a number of its own reads it", () => {
    expect(workspaceWorkNumber({ workspaceRole: "primary", number: { phoneNumber: OWN }, sharedLine: { number: SHARED, onSharedLine: false } })).toBe(OWN);
  });
  it("an owner on the PropLane line reads the line", () => {
    expect(workspaceWorkNumber({ workspaceRole: "primary", number: null, sharedLine: { number: SHARED, onSharedLine: true } })).toBe(SHARED);
  });
  it("a teammate reads the owner's line, else the PropLane line", () => {
    expect(workspaceWorkNumber({ workspaceRole: "co_manager", workspaceNumber: { phoneNumber: OWN }, sharedLine: { number: SHARED, onSharedLine: false } })).toBe(OWN);
    expect(workspaceWorkNumber({ workspaceRole: "co_manager", workspaceNumber: { phoneNumber: null }, sharedLine: { number: SHARED, onSharedLine: true } })).toBe(SHARED);
  });
  it("per_workspace (no sharedLine) and a workspace off the line read nothing", () => {
    expect(workspaceWorkNumber({ workspaceRole: "primary", number: null, sharedLine: null })).toBeNull();
    expect(workspaceWorkNumber({ workspaceRole: "primary", number: null })).toBeNull();
    expect(workspaceWorkNumber({ workspaceRole: "primary", number: null, sharedLine: { number: SHARED, onSharedLine: false } })).toBeNull();
  });
});
