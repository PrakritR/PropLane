import { beforeEach, describe, expect, it, vi } from "vitest";

// Who pays for a personalized number: owner id -> entitlement. Nobody by default (nobody pays today).
const paid = vi.hoisted(() => ({ owners: {} as Record<string, "plan" | "add_on" | "unreadable"> }));
vi.mock("@/lib/one-number/personal-number-entitlement.server", () => ({
  managerPersonalNumberEntitlement: vi.fn(async (_db: unknown, owner: string) => {
    const via = paid.owners[owner];
    if (via === "unreadable") return { ok: false as const };
    return via ? { ok: true as const, entitled: true as const, via, tier: null } : { ok: true as const, entitled: false as const, tier: "free" as const };
  }),
}));
import {
  isSharedLineNumber,
  loadSharedLineConfig,
  PER_WORKSPACE_CONFIG,
  workspaceHasDedicatedNumber,
  workspaceOnSharedLine,
} from "@/lib/one-number/config.server";
import { fakeSharedLineDb } from "../helpers/shared-line-fake-db";

const row = (over: Record<string, unknown> = {}) => ({
  singleton: true,
  line_mode: "shared",
  shared_number_e164: "+12065550100",
  shared_messaging_service_sid: "MG123",
  shared_pilot_workspace_ids: [],
  ...over,
});

beforeEach(() => {
  for (const key of Object.keys(paid.owners)) delete paid.owners[key];
});

describe("loadSharedLineConfig", () => {
  it("reads a shared line", async () => {
    const { db } = fakeSharedLineDb({ sms_runtime_config: [row()] });
    expect(await loadSharedLineConfig(db)).toEqual({
      mode: "shared", sharedNumber: "+12065550100", messagingServiceSid: "MG123", pilotWorkspaceIds: [], dedicatedWorkspaceIds: [],
    });
  });

  const live = { provision_state: "active", registration_state: "approved", released_at: null };

  it("lists workspaces that hold a working number its owner pays for: home workspace and linked ones", async () => {
    paid.owners["o-pro"] = "plan";
    paid.owners["o-addon"] = "add_on";
    const { db } = fakeSharedLineDb({
      sms_runtime_config: [row()],
      manager_sms_numbers: [
        { id: "n1", manager_user_id: "o-pro", workspace_id: "ws-pro", phone_number: "+12065550111", ...live },
        { id: "n2", manager_user_id: "o-setup", workspace_id: "ws-setting-up", phone_number: "+12065550112", provision_state: "provisioning", registration_state: "pending", released_at: null },
        { id: "n3", manager_user_id: "o-addon", workspace_id: "ws-addon", phone_number: "+12065550113", ...live },
        { id: "n4", manager_user_id: "o-pro", workspace_id: "ws-released", phone_number: "+12065550114", ...live, released_at: "2026-10-01T00:00:00Z", provision_state: "released" },
        { id: "n5", manager_user_id: "o-pro", workspace_id: "ws-no-phone", phone_number: null, ...live },
        { id: "n6", manager_user_id: "o-lapsed", workspace_id: "ws-lapsed", phone_number: "+12065550116", ...live },
      ],
      workspace_work_numbers: [
        { number_id: "n1", workspace_id: "ws-linked" },
        { number_id: "n2", workspace_id: "ws-linked-setting-up" },
        { number_id: "n6", workspace_id: "ws-linked-lapsed" },
      ],
    });
    const config = await loadSharedLineConfig(db);
    expect([...(config.dedicatedWorkspaceIds ?? [])].sort()).toEqual(["ws-addon", "ws-linked", "ws-pro"]);
    expect(workspaceHasDedicatedNumber(config, "ws-pro")).toBe(true);
    expect(workspaceOnSharedLine(config, "ws-pro")).toBe(false);
    expect(workspaceOnSharedLine(config, "ws-addon")).toBe(false);
    expect(workspaceOnSharedLine(config, "ws-linked")).toBe(false);
    // No payment, a lapsed add-on, a number still being set up, a released one: all on the PropLane line.
    for (const id of ["ws-lapsed", "ws-linked-lapsed", "ws-setting-up", "ws-linked-setting-up", "ws-released", "ws-no-phone", "ws-free"]) {
      expect(workspaceOnSharedLine(config, id)).toBe(true);
    }
  });

  it("a number row with no paid entitlement leaves the workspace on the shared line (nobody pays today)", async () => {
    const { db } = fakeSharedLineDb({
      sms_runtime_config: [row()],
      manager_sms_numbers: [{ id: "n1", manager_user_id: "o-free", workspace_id: "ws-old", phone_number: "+12065550111", ...live }],
    });
    const config = await loadSharedLineConfig(db);
    expect(config.dedicatedWorkspaceIds).toEqual([]);
    expect(workspaceOnSharedLine(config, "ws-old")).toBe(true);
  });

  it("a lapsed add-on (canceled) is not entitled, so the workspace returns to the shared line", async () => {
    paid.owners["o-1"] = "add_on";
    const rows = { sms_runtime_config: [row()], manager_sms_numbers: [{ id: "n1", manager_user_id: "o-1", workspace_id: "ws-1", phone_number: "+12065550111", ...live }] };
    expect(workspaceOnSharedLine(await loadSharedLineConfig(fakeSharedLineDb(rows).db), "ws-1")).toBe(false);
    delete paid.owners["o-1"];
    expect(workspaceOnSharedLine(await loadSharedLineConfig(fakeSharedLineDb(rows).db), "ws-1")).toBe(true);
  });

  it("an entitlement that cannot be read fails closed to per_workspace", async () => {
    paid.owners["o-1"] = "unreadable";
    const { db } = fakeSharedLineDb({
      sms_runtime_config: [row()],
      manager_sms_numbers: [{ id: "n1", manager_user_id: "o-1", workspace_id: "ws-1", phone_number: "+12065550111", ...live }],
    });
    expect(await loadSharedLineConfig(db)).toEqual(PER_WORKSPACE_CONFIG);
  });

  it("reads a missing number table as nobody dedicated, and an unreadable one as per_workspace", async () => {
    const missing = fakeSharedLineDb({ sms_runtime_config: [row()] }, { broken: ["manager_sms_numbers"] });
    expect((await loadSharedLineConfig(missing.db)).dedicatedWorkspaceIds).toEqual([]);
    const db = {
      from(table: string) {
        const q: Record<string, unknown> = {
          select: () => q, eq: () => q, not: () => q, in: () => q,
          maybeSingle: async () => ({ data: row(), error: null }),
          then: (resolve: (r: unknown) => void) => resolve(table === "manager_sms_numbers" ? { data: null, error: { code: "XX000" } } : { data: [], error: null }),
        };
        return q;
      },
    } as never;
    expect(await loadSharedLineConfig(db)).toEqual(PER_WORKSPACE_CONFIG);
  });

  it("does not read the number tables while the line is per_workspace or shadow", async () => {
    const off = fakeSharedLineDb({ sms_runtime_config: [row({ line_mode: "per_workspace" })] });
    await loadSharedLineConfig(off.db);
    expect(off.touched).not.toContain("manager_sms_numbers");
    const shadow = fakeSharedLineDb({ sms_runtime_config: [row({ line_mode: "shadow" })] });
    expect((await loadSharedLineConfig(shadow.db)).dedicatedWorkspaceIds).toBeUndefined();
  });

  it("fails closed to per_workspace when the table is missing (code before migration)", async () => {
    const { db } = fakeSharedLineDb({}, { broken: ["sms_runtime_config"] });
    expect(await loadSharedLineConfig(db)).toEqual(PER_WORKSPACE_CONFIG);
  });

  it("fails closed when the row is missing, the mode is unknown, or shared has no number", async () => {
    expect(await loadSharedLineConfig(fakeSharedLineDb({ sms_runtime_config: [] }).db)).toEqual(PER_WORKSPACE_CONFIG);
    expect((await loadSharedLineConfig(fakeSharedLineDb({ sms_runtime_config: [row({ line_mode: "weird" })] }).db)).mode).toBe("per_workspace");
    expect(await loadSharedLineConfig(fakeSharedLineDb({ sms_runtime_config: [row({ shared_number_e164: null })] }).db)).toEqual(PER_WORKSPACE_CONFIG);
  });

  it("fails closed when the read throws", async () => {
    const db = { from() { throw new Error("boom"); } } as never;
    expect(await loadSharedLineConfig(db)).toEqual(PER_WORKSPACE_CONFIG);
  });

  it("keeps shadow mode without a number", async () => {
    const { db } = fakeSharedLineDb({ sms_runtime_config: [row({ line_mode: "shadow", shared_number_e164: null })] });
    expect((await loadSharedLineConfig(db)).mode).toBe("shadow");
  });
});

describe("isSharedLineNumber / workspaceOnSharedLine", () => {
  const shared = { mode: "shared" as const, sharedNumber: "+12065550100", messagingServiceSid: null, pilotWorkspaceIds: [] };

  it("compares E.164 regardless of formatting, and is false in per_workspace mode", () => {
    expect(isSharedLineNumber(shared, "(206) 555-0100")).toBe(true);
    expect(isSharedLineNumber(shared, "+1 206 555 0100")).toBe(true);
    expect(isSharedLineNumber(shared, "+12065550199")).toBe(false);
    expect(isSharedLineNumber(shared, "")).toBe(false);
    expect(isSharedLineNumber({ ...shared, mode: "per_workspace" }, "+12065550100")).toBe(false);
    expect(isSharedLineNumber({ ...shared, sharedNumber: null }, "+12065550100")).toBe(false);
  });

  it("serves every workspace with no pilot list, only listed ones with one, none unless mode is shared", () => {
    expect(workspaceOnSharedLine(shared, "ws-1")).toBe(true);
    const pilot = { ...shared, pilotWorkspaceIds: ["ws-1"] };
    expect(workspaceOnSharedLine(pilot, "ws-1")).toBe(true);
    expect(workspaceOnSharedLine(pilot, "ws-2")).toBe(false);
    expect(workspaceOnSharedLine(pilot, null)).toBe(false);
    expect(workspaceOnSharedLine(shared, null)).toBe(false);
    expect(workspaceOnSharedLine({ ...shared, sharedNumber: null }, "ws-1")).toBe(false);
    expect(workspaceOnSharedLine({ ...shared, mode: "shadow" }, "ws-1")).toBe(false);
    expect(workspaceOnSharedLine(PER_WORKSPACE_CONFIG, "ws-1")).toBe(false);
  });
});
