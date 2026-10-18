import { describe, expect, it } from "vitest";
import {
  isSharedLineNumber,
  loadSharedLineConfig,
  PER_WORKSPACE_CONFIG,
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
      mode: "shared", sharedNumber: "+12065550100", messagingServiceSid: "MG123", pilotWorkspaceIds: [],
    });
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
