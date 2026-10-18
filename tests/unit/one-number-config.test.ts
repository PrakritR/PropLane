import { describe, expect, it } from "vitest";
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

describe("loadSharedLineConfig", () => {
  it("reads a shared line", async () => {
    const { db } = fakeSharedLineDb({ sms_runtime_config: [row()] });
    expect(await loadSharedLineConfig(db)).toEqual({
      mode: "shared", sharedNumber: "+12065550100", messagingServiceSid: "MG123", pilotWorkspaceIds: [], dedicatedWorkspaceIds: [],
    });
  });

  it("lists workspaces that hold a usable number of their own: home workspace and linked ones", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const { db } = fakeSharedLineDb({
      sms_runtime_config: [row()],
      manager_sms_numbers: [
        { id: "n1", workspace_id: "ws-pro", provision_state: "active", grace_expires_at: null },
        { id: "n2", workspace_id: "ws-grace", provision_state: "released", grace_expires_at: future },
        { id: "n3", workspace_id: "ws-gone", provision_state: "released", grace_expires_at: past },
        { id: "n4", workspace_id: "ws-prov", provision_state: "provisioning", grace_expires_at: null },
      ],
      workspace_work_numbers: [
        { number_id: "n1", workspace_id: "ws-linked" },
        { number_id: "n3", workspace_id: "ws-linked-gone" },
      ],
    });
    const config = await loadSharedLineConfig(db);
    expect([...(config.dedicatedWorkspaceIds ?? [])].sort()).toEqual(["ws-grace", "ws-linked", "ws-pro", "ws-prov"]);
    expect(workspaceHasDedicatedNumber(config, "ws-pro")).toBe(true);
    expect(workspaceHasDedicatedNumber(config, "ws-gone")).toBe(false);
    expect(workspaceOnSharedLine(config, "ws-pro")).toBe(false);
    expect(workspaceOnSharedLine(config, "ws-linked")).toBe(false);
    expect(workspaceOnSharedLine(config, "ws-free")).toBe(true);
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
