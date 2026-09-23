/**
 * Part 3 of the work-numbers-per-workspace plan: a workspace may hold up to 2
 * work numbers via the `workspace_work_numbers` join table, and one number
 * may serve two workspaces. These pin the server module's cap, sharing,
 * removal, and cross-account authorization.
 */
import { describe, expect, it } from "vitest";
import { createWorkspaceMemoryDb } from "./support/workspace-memory-db";
import {
  WORKSPACE_WORK_NUMBER_LIMIT,
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

describe("assignNumberToWorkspace — sharing a number into a second workspace", () => {
  it("assigns the workspace's number to a sibling workspace of the same owner", async () => {
    const db = seed();
    const result = await assignNumberToWorkspace(db as never, prakrit, { numberId: "n-1", workspaceId: PRAKRIT_WS2 });
    expect(result).toEqual({ ok: true });

    const home = await listWorkspaceNumbers(db as never, PRAKRIT_WS);
    expect(home).toEqual([
      expect.objectContaining({
        numberId: "n-1",
        isPrimary: true,
        sharedWithWorkspaceIds: [PRAKRIT_WS2],
        sharedWithWorkspaceNames: ["Ballard houses"],
      }),
    ]);
    const shared = await listWorkspaceNumbers(db as never, PRAKRIT_WS2);
    expect(shared).toEqual([
      expect.objectContaining({
        numberId: "n-1",
        isPrimary: false,
        sharedWithWorkspaceIds: [PRAKRIT_WS],
        sharedWithWorkspaceNames: ["My workspace"],
      }),
    ]);
  });

  it("refuses assigning a number the actor does not already hold (owner re-derived, never trusted)", async () => {
    const db = seed({
      manager_sms_numbers: [
        { id: "n-1", manager_user_id: prakrit, workspace_id: PRAKRIT_WS, phone_number: "+12065550001", provision_state: "active" },
        { id: "n-2", manager_user_id: stranger, workspace_id: STRANGER_WS, phone_number: "+12065550099", provision_state: "active" },
      ],
      workspace_work_numbers: [
        { workspace_id: PRAKRIT_WS, number_id: "n-1", is_primary: true, created_at: "2026-02-02" },
        { workspace_id: STRANGER_WS, number_id: "n-2", is_primary: true, created_at: "2026-02-02" },
      ],
    });
    // Prakrit tries to assign the STRANGER's number into his own workspace.
    const result = await assignNumberToWorkspace(db as never, prakrit, { numberId: "n-2", workspaceId: PRAKRIT_WS2 });
    expect(result).toMatchObject({ ok: false, code: "not_authorized" });
  });

  it("refuses assigning into a workspace the actor does not own", async () => {
    const db = seed();
    const result = await assignNumberToWorkspace(db as never, prakrit, { numberId: "n-1", workspaceId: STRANGER_WS });
    expect(result).toMatchObject({ ok: false, code: "not_authorized" });
  });

  it("caps a workspace at 1 number", async () => {
    const db = seed({
      manager_sms_numbers: [
        { id: "n-1", manager_user_id: prakrit, workspace_id: PRAKRIT_WS, phone_number: "+12065550001", provision_state: "active" },
        { id: "n-2", manager_user_id: prakrit, workspace_id: PRAKRIT_WS2, phone_number: "+12065550002", provision_state: "active" },
      ],
      workspace_work_numbers: [
        { workspace_id: PRAKRIT_WS, number_id: "n-1", is_primary: true, created_at: "2026-02-02" },
        { workspace_id: PRAKRIT_WS2, number_id: "n-2", is_primary: true, created_at: "2026-02-02" },
      ],
    });
    expect((await listWorkspaceNumbers(db as never, PRAKRIT_WS)).length).toBe(WORKSPACE_WORK_NUMBER_LIMIT);
    const result = await assignNumberToWorkspace(db as never, prakrit, { numberId: "n-2", workspaceId: PRAKRIT_WS });
    expect(result).toMatchObject({ ok: false, code: "cap_exceeded" });
  });

  it("refuses re-assigning a number the workspace already holds", async () => {
    const db = seed();
    const result = await assignNumberToWorkspace(db as never, prakrit, { numberId: "n-1", workspaceId: PRAKRIT_WS });
    expect(result).toMatchObject({ ok: false, code: "already_assigned" });
  });
});

describe("unassignNumber", () => {
  it("removes a number from a workspace, leaving other holders untouched", async () => {
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

  it("promotes the earliest remaining holder to primary when the home copy is removed", async () => {
    const db = seed({
      workspace_work_numbers: [
        { workspace_id: PRAKRIT_WS, number_id: "n-1", is_primary: true, created_at: "2026-02-02" },
        { workspace_id: PRAKRIT_WS2, number_id: "n-1", is_primary: false, created_at: "2026-02-03" },
      ],
    });
    const result = await unassignNumber(db as never, prakrit, { numberId: "n-1", workspaceId: PRAKRIT_WS });
    expect(result).toEqual({ ok: true });
    const remaining = await listWorkspaceNumbers(db as never, PRAKRIT_WS2);
    expect(remaining).toEqual([expect.objectContaining({ numberId: "n-1", isPrimary: true })]);
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
