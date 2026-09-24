/**
 * One work number per workspace — cross-workspace sharing is refused.
 * Primary/home numbers cannot be removed once set up; legacy shared-in
 * rows can still be cleared with unassign.
 */
import { describe, expect, it } from "vitest";
import { createWorkspaceMemoryDb } from "./support/workspace-memory-db";
import {
  assignNumberToWorkspace,
  listWorkspaceNumbers,
  unassignNumber,
} from "@/lib/sms/work-numbers.server";

const prakrit = "prakrit";
const stranger = "stranger";
const PRAKRIT_WS = "ws-prakrit";
const PRAKRIT_WS2 = "ws-prakrit-seattle";
const STRANGER_WS = "ws-stranger";

function seed(extra: Record<string, Record<string, unknown>[]> = {}) {
  return createWorkspaceMemoryDb({
    portal_workspaces: [
      { id: PRAKRIT_WS, owner_user_id: prakrit, name: "My workspace", is_default: true, created_at: "2026-02-01" },
      { id: PRAKRIT_WS2, owner_user_id: prakrit, name: "Ballard houses", is_default: false, created_at: "2026-03-01" },
      { id: STRANGER_WS, owner_user_id: stranger, name: "Stranger's workspace", is_default: true, created_at: "2026-02-01" },
    ],
    manager_sms_numbers: [
      { id: "n-1", manager_user_id: prakrit, workspace_id: PRAKRIT_WS, phone_number: "+12065550001", provision_state: "active" },
    ],
    workspace_work_numbers: [
      { workspace_id: PRAKRIT_WS, number_id: "n-1", is_primary: true, created_at: "2026-02-02" },
    ],
    ...extra,
  });
}

describe("listWorkspaceNumbers", () => {
  it("lists the workspace's own number as primary, unshared", async () => {
    const db = seed();
    const numbers = await listWorkspaceNumbers(db as never, PRAKRIT_WS);
    expect(numbers).toEqual([
      {
        numberId: "n-1",
        phoneNumber: "+12065550001",
        isPrimary: true,
        provisionState: "active",
        sharedWithWorkspaceIds: [],
        sharedWithWorkspaceNames: [],
      },
    ]);
  });

  it("is empty for a workspace with no numbers", async () => {
    const db = seed();
    expect(await listWorkspaceNumbers(db as never, PRAKRIT_WS2)).toEqual([]);
  });
});

describe("assignNumberToWorkspace — sharing is retired", () => {
  it("refuses every cross-workspace assign", async () => {
    const db = seed();
    const result = await assignNumberToWorkspace(db as never, prakrit, { numberId: "n-1", workspaceId: PRAKRIT_WS2 });
    expect(result).toMatchObject({ ok: false, code: "not_authorized" });
    expect(await listWorkspaceNumbers(db as never, PRAKRIT_WS2)).toEqual([]);
  });

  it("refuses even when the actor owns both workspaces", async () => {
    const db = seed();
    const result = await assignNumberToWorkspace(db as never, prakrit, { numberId: "n-1", workspaceId: PRAKRIT_WS2 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/one workspace/i);
    }
  });
});

describe("unassignNumber", () => {
  it("clears a legacy shared-in hold, leaving the home workspace untouched", async () => {
    const db = seed({
      workspace_work_numbers: [
        { workspace_id: PRAKRIT_WS, number_id: "n-1", is_primary: true, created_at: "2026-02-02" },
        { workspace_id: PRAKRIT_WS2, number_id: "n-1", is_primary: false, created_at: "2026-02-03" },
      ],
    });
    const result = await unassignNumber(db as never, prakrit, { numberId: "n-1", workspaceId: PRAKRIT_WS2 });
    expect(result).toEqual({ ok: true });
    expect(await listWorkspaceNumbers(db as never, PRAKRIT_WS2)).toEqual([]);
    const remaining = await listWorkspaceNumbers(db as never, PRAKRIT_WS);
    expect(remaining).toEqual([expect.objectContaining({ numberId: "n-1", isPrimary: true, sharedWithWorkspaceIds: [] })]);
  });

  it("refuses removing a workspace's own set-up (primary/home) number", async () => {
    const db = seed({
      workspace_work_numbers: [
        { workspace_id: PRAKRIT_WS, number_id: "n-1", is_primary: true, created_at: "2026-02-02" },
        { workspace_id: PRAKRIT_WS2, number_id: "n-1", is_primary: false, created_at: "2026-02-03" },
      ],
    });
    const result = await unassignNumber(db as never, prakrit, { numberId: "n-1", workspaceId: PRAKRIT_WS });
    expect(result).toMatchObject({ ok: false, code: "setup_locked" });
    expect(await listWorkspaceNumbers(db as never, PRAKRIT_WS)).toEqual([
      expect.objectContaining({ numberId: "n-1", isPrimary: true }),
    ]);
  });

  it("refuses removing a number for a workspace the actor does not own", async () => {
    const db = seed();
    const result = await unassignNumber(db as never, stranger, { numberId: "n-1", workspaceId: PRAKRIT_WS });
    expect(result).toMatchObject({ ok: false, code: "not_authorized" });
  });

  it("refuses removing a number the workspace does not hold", async () => {
    const db = seed();
    const result = await unassignNumber(db as never, prakrit, { numberId: "n-not-held", workspaceId: PRAKRIT_WS });
    expect(result).toMatchObject({ ok: false, code: "not_found" });
  });
});
