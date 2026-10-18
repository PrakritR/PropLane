import { describe, expect, it } from "vitest";
import {
  isMissingSchemaError,
  readSharedLineConfig,
  resolveSharedLineHumanSend,
  sharedLineActiveFor,
} from "@/lib/one-number/shared-line-number.server";
import { isMissingWorkspaceColumn, withWorkspaceStamp } from "@/lib/one-number/workspace-stamp";

function dbWith(tables: Record<string, { data: unknown; error?: unknown }>) {
  return {
    from: (table: string) => {
      const answer = tables[table];
      if (!answer) throw new Error(`Unexpected table ${table}`);
      const q: Record<string, unknown> = {
        select: () => q, eq: () => q,
        maybeSingle: async () => ({ data: answer.data, error: answer.error ?? null }),
      };
      return q;
    },
  } as never;
}

describe("readSharedLineConfig", () => {
  it("reads the shared line columns", async () => {
    const config = await readSharedLineConfig(dbWith({
      sms_runtime_config: { data: { line_mode: "shared", shared_number_e164: "+12065550100", shared_messaging_service_sid: "MG9", shared_pilot_workspace_ids: ["a", "b"] } },
    }));
    expect(config).toEqual({ mode: "shared", sharedNumber: "+12065550100", messagingServiceSid: "MG9", pilotWorkspaceIds: ["a", "b"] });
  });

  it.each([
    ["missing column 42703", { data: null, error: { code: "42703" } }],
    ["missing table 42P01", { data: null, error: { code: "42P01" } }],
    ["PostgREST PGRST205", { data: null, error: { code: "PGRST205" } }],
    ["row without the new columns", { data: { mode: "automatic" } }],
    ["unknown mode", { data: { line_mode: "bogus" } }],
  ])("reads %s as per_workspace", async (_label, answer) => {
    const config = await readSharedLineConfig(dbWith({ sms_runtime_config: answer }));
    expect(config.mode).toBe("per_workspace");
  });

  it("reads a throwing client as per_workspace", async () => {
    await expect(readSharedLineConfig(dbWith({}))).resolves.toMatchObject({ mode: "per_workspace" });
  });

  it("classifies missing-schema errors", () => {
    expect(isMissingSchemaError({ code: "42703" })).toBe(true);
    expect(isMissingSchemaError({ code: "23505" })).toBe(false);
    expect(isMissingSchemaError(null)).toBe(false);
  });
});

describe("sharedLineActiveFor", () => {
  const shared = { mode: "shared" as const, sharedNumber: "+12065550100", messagingServiceSid: null, pilotWorkspaceIds: [] };
  it("needs shared mode, an attached number and a workspace", () => {
    expect(sharedLineActiveFor(shared, "ws-1")).toBe(true);
    expect(sharedLineActiveFor(shared, null)).toBe(false);
    expect(sharedLineActiveFor({ ...shared, mode: "shadow" }, "ws-1")).toBe(false);
    expect(sharedLineActiveFor({ ...shared, mode: "per_workspace" }, "ws-1")).toBe(false);
    expect(sharedLineActiveFor({ ...shared, sharedNumber: null }, "ws-1")).toBe(false);
  });
  it("honours the pilot list; empty means everyone", () => {
    expect(sharedLineActiveFor({ ...shared, pilotWorkspaceIds: ["ws-2"] }, "ws-1")).toBe(false);
    expect(sharedLineActiveFor({ ...shared, pilotWorkspaceIds: ["ws-1"] }, "ws-1")).toBe(true);
  });
});

describe("workspace stamps", () => {
  it("stamps when a workspace is known and degrades when the column is missing", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const result = await withWorkspaceStamp("ws-1", async (stamp) => {
      seen.push(stamp);
      return stamp.workspace_id ? { error: { code: "42703", message: 'column "workspace_id" does not exist' } } : { error: null };
    });
    expect(seen).toEqual([{ workspace_id: "ws-1" }, {}]);
    expect(result.error).toBeNull();
  });

  it("does not retry a real error and adds nothing without a workspace", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const failed = await withWorkspaceStamp("ws-1", async (stamp) => { seen.push(stamp); return { error: { code: "23505" } }; });
    expect(seen).toHaveLength(1);
    expect(failed.error).toEqual({ code: "23505" });
    const none = await withWorkspaceStamp(null, async (stamp) => { seen.push(stamp); return { error: null }; });
    expect(none.error).toBeNull();
    expect(seen.at(-1)).toEqual({});
    expect(isMissingWorkspaceColumn({ message: "Could not find the 'workspace_id' column of 'sms_outbox' in the schema cache" })).toBe(true);
  });
});

describe("resolveSharedLineHumanSend", () => {
  const shared = { line_mode: "shared", shared_number_e164: "+12065550100" };
  it("is null per_workspace (no sign-off, no change)", async () => {
    const db = dbWith({ sms_runtime_config: { data: { line_mode: "per_workspace" } } });
    await expect(resolveSharedLineHumanSend(db, { ownerUserId: "o" })).resolves.toBeNull();
  });

  it("names the paying workspace and signs with the house, else the workspace name", async () => {
    const withHouse = dbWith({
      sms_runtime_config: { data: shared },
      portal_workspaces: { data: { id: "ws-1", name: "Seattle Homes" } },
      manager_property_records: { data: { id: "p1", property_data: { buildingName: "5259 Brooklyn", unitLabel: "A" } } },
    });
    await expect(resolveSharedLineHumanSend(withHouse, { ownerUserId: "o", propertyId: "p1" })).resolves.toEqual({
      workspaceId: "ws-1", signOff: "5259 Brooklyn team",
    });
    const noHouse = dbWith({
      sms_runtime_config: { data: shared },
      portal_workspaces: { data: { id: "ws-1", name: "Seattle Homes" } },
    });
    await expect(resolveSharedLineHumanSend(noHouse, { ownerUserId: "o" })).resolves.toEqual({
      workspaceId: "ws-1", signOff: "Seattle Homes team",
    });
  });
});
