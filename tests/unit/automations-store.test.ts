import { describe, expect, it, vi } from "vitest";
import { automationsFakeDb } from "../helpers/automations-fake-db";
import { getAutomationPreset } from "@/lib/automations/presets";
import {
  claimRun,
  finishRun,
  listHeldRuns,
  loadAutomationSettings,
  loadOffPresetResolver,
  loadOptedInWorkspaces,
  reapStuckRuns,
  resolveAutomation,
  saveAutomationSetting,
} from "@/lib/automations/store.server";

describe("settings", () => {
  it("reads nothing, not an error, before the migration has run", async () => {
    const f = automationsFakeDb({}, { broken: ["workspace_automation_presets", "workspace_automation_runs"] });
    expect((await loadAutomationSettings(f.db, "ws")).size).toBe(0);
    expect((await loadOptedInWorkspaces(f.db)).size).toBe(0);
    expect(await listHeldRuns(f.db, "ws")).toEqual([]);
    expect(await claimRun(f.db, { workspaceId: "ws", ownerUserId: "o", preset: "welcome", idempotencyKey: "k", audience: "resident", mode: "auto" })).toBeNull();
  });

  it("saves a pick, keeps the wording when only the mode changes, and resets it with null", async () => {
    const f = automationsFakeDb();
    expect(await saveAutomationSetting(f.db, { workspaceId: "ws", preset: "welcome", mode: "auto", template: "Hi {first_name}", userId: "u" })).toEqual({ ok: true });
    expect(await saveAutomationSetting(f.db, { workspaceId: "ws", preset: "welcome", mode: "draft", userId: "u" })).toEqual({ ok: true });
    let saved = (await loadAutomationSettings(f.db, "ws")).get("welcome")!;
    expect(saved).toEqual({ mode: "draft", template: "Hi {first_name}" });
    await saveAutomationSetting(f.db, { workspaceId: "ws", preset: "welcome", mode: "draft", template: null, userId: "u" });
    saved = (await loadAutomationSettings(f.db, "ws")).get("welcome")!;
    expect(saved.template).toBeNull();
    expect(resolveAutomation(getAutomationPreset("welcome")!, saved).template).toBe(getAutomationPreset("welcome")!.template);
    expect([...(await loadOptedInWorkspaces(f.db))]).toEqual(["ws"]);
  });

  it("surfaces a failed write with its error code instead of swallowing it", async () => {
    const f = automationsFakeDb({}, { broken: ["workspace_automation_presets"] });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await saveAutomationSetting(f.db, { workspaceId: "ws", preset: "welcome", mode: "auto", userId: "u" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBeTruthy();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("ignores a stored row for a preset that no longer exists", async () => {
    const f = automationsFakeDb({ workspace_automation_presets: [{ workspace_id: "ws", preset: "retired", mode: "auto" }] });
    expect((await loadAutomationSettings(f.db, "ws")).size).toBe(0);
  });
});

describe("the run ledger", () => {
  const claim = { workspaceId: "ws", ownerUserId: "o", preset: "welcome" as const, idempotencyKey: "welcome:L1", audience: "resident" as const, mode: "auto" as const };

  it("claims a moment once", async () => {
    const f = automationsFakeDb();
    expect(await claimRun(f.db, claim)).toBeTruthy();
    expect(await claimRun(f.db, claim)).toBeNull();
    // The same key in another workspace is another moment.
    expect(await claimRun(f.db, { ...claim, workspaceId: "ws2" })).toBeTruthy();
  });

  it("lists held runs for the workspace only, newest first", async () => {
    const f = automationsFakeDb();
    const a = (await claimRun(f.db, claim))!;
    await finishRun(f.db, a, { status: "held", body: "Hello" });
    const other = (await claimRun(f.db, { ...claim, workspaceId: "ws2", idempotencyKey: "x" }))!;
    await finishRun(f.db, other, { status: "held", body: "Other" });
    const held = await listHeldRuns(f.db, "ws");
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ id: a, preset: "welcome", body: "Hello" });
  });

  it("reaps a run a crashed tick left sending, so the moment can fire again", async () => {
    const f = automationsFakeDb({
      workspace_automation_runs: [
        { id: "old", workspace_id: "ws", idempotency_key: "a", status: "sending", created_at: "2026-11-01T00:00:00Z" },
        { id: "new", workspace_id: "ws", idempotency_key: "b", status: "sending", created_at: "2026-11-01T11:58:00Z" },
        { id: "done", workspace_id: "ws", idempotency_key: "c", status: "sent", created_at: "2026-11-01T00:00:00Z" },
      ],
    });
    await reapStuckRuns(f.db, new Date("2026-11-01T12:00:00Z"));
    expect(f.rows.workspace_automation_runs!.map((r) => r.id).sort()).toEqual(["done", "new"]);
  });
});

describe("loadOffPresetResolver: what the existing senders ask", () => {
  const workspaces = [
    { id: "ws-a", owner_user_id: "owner", is_default: true },
    { id: "ws-b", owner_user_id: "owner", is_default: false },
  ];
  it("says off only for the workspace the house is in", async () => {
    const f = automationsFakeDb({
      portal_workspaces: workspaces,
      workspace_automation_presets: [{ workspace_id: "ws-b", preset: "rent_late_3d", mode: "off" }, { workspace_id: "ws-a", preset: "rent_due_3d", mode: "auto" }],
      manager_property_records: [{ id: "P-b", manager_user_id: "owner", workspace_id: "ws-b" }, { id: "P-a", manager_user_id: "owner", workspace_id: "ws-a" }],
    });
    const off = await loadOffPresetResolver(f.db, "owner");
    expect(off.isOff("rent_late_3d", "P-b")).toBe(true);
    expect(off.isOff("rent_late_3d", "P-a")).toBe(false);
    expect(off.isOff("rent_due_3d", "P-b")).toBe(false);
    // A house with no workspace of its own belongs to the owner's default workspace.
    expect(off.isOff("rent_late_3d", null)).toBe(false);
  });

  it("fails open: a missing table never mutes rent", async () => {
    const f = automationsFakeDb({ portal_workspaces: workspaces }, { broken: ["workspace_automation_presets"] });
    const off = await loadOffPresetResolver(f.db, "owner");
    expect(off.isOff("rent_due_3d", "P-a")).toBe(false);
    expect(off.isOff("rent_late_3d", null)).toBe(false);
  });

  it("is quiet for an owner with nothing switched off", async () => {
    const f = automationsFakeDb({ portal_workspaces: workspaces });
    expect((await loadOffPresetResolver(f.db, "owner")).isOff("move_out", "P")).toBe(false);
  });
});
