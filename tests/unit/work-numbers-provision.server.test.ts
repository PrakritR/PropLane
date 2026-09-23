/**
 * provisionNumberForWorkspace gates a work-number purchase by the account-wide
 * included + extra_work_number budget, and refuses buying a genuine SECOND
 * home number for a workspace that already has one — `manager_sms_numbers`
 * keeps its one-row-per-home-workspace shape, so a real second number for
 * that workspace can only come from sharing (assignNumberToWorkspace), never
 * a second purchase into the same home slot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceMemoryDb } from "./support/workspace-memory-db";

const mocks = vi.hoisted(() => ({
  getEffectiveManagerSkuTier: vi.fn(),
  loadManagerPlanAddonQuantities: vi.fn(),
  provisionManagerNumber: vi.fn(),
}));

vi.mock("@/lib/manager-access-server", () => ({
  getEffectiveManagerSkuTier: mocks.getEffectiveManagerSkuTier,
}));
vi.mock("@/lib/plan-addons.server", () => ({
  loadManagerPlanAddonQuantities: mocks.loadManagerPlanAddonQuantities,
}));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({
  provisionManagerNumber: mocks.provisionManagerNumber,
}));

import { provisionNumberForWorkspace } from "@/lib/sms/work-numbers.server";

const prakrit = "prakrit";
const stranger = "stranger";
const PRAKRIT_WS = "ws-prakrit";
const PRAKRIT_WS2 = "ws-prakrit-2";

function seed(extra: Record<string, Record<string, unknown>[]> = {}) {
  return createWorkspaceMemoryDb({
    portal_workspaces: [
      { id: PRAKRIT_WS, owner_user_id: prakrit, name: "My workspace", is_default: true, created_at: "2026-02-01" },
    ],
    manager_sms_numbers: [],
    workspace_work_numbers: [],
    ...extra,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEffectiveManagerSkuTier.mockResolvedValue({ ok: true, tier: "business" });
  mocks.loadManagerPlanAddonQuantities.mockResolvedValue({
    ok: true,
    quantities: { extra_comms_credit: 0, extra_resident: 0, extra_work_number: 0, extra_workspace: 0, extra_seat: 0 },
  });
  mocks.provisionManagerNumber.mockResolvedValue({ ok: true, number: "+12065550001", state: "provisioning", alreadyProvisioned: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("provisionNumberForWorkspace", () => {
  it("refuses a workspace the actor does not own", async () => {
    const db = seed();
    const result = await provisionNumberForWorkspace(db as never, stranger, { workspaceId: PRAKRIT_WS });
    expect(result).toMatchObject({ ok: false, code: "not_authorized" });
    expect(mocks.provisionManagerNumber).not.toHaveBeenCalled();
  });

  it("refuses a workspace already at the 1-number cap", async () => {
    const db = seed({
      manager_sms_numbers: [
        { id: "n-other", manager_user_id: prakrit, workspace_id: PRAKRIT_WS2, phone_number: "+12065559999", provision_state: "active" },
      ],
      workspace_work_numbers: [
        { workspace_id: PRAKRIT_WS, number_id: "n-a", is_primary: false, created_at: "2026-02-02" },
        { workspace_id: PRAKRIT_WS, number_id: "n-b", is_primary: false, created_at: "2026-02-03" },
      ],
    });
    const result = await provisionNumberForWorkspace(db as never, prakrit, { workspaceId: PRAKRIT_WS });
    expect(result).toMatchObject({ ok: false, code: "cap_exceeded" });
    expect(mocks.provisionManagerNumber).not.toHaveBeenCalled();
  });

  it("refuses buying a second HOME number once the workspace already holds one", async () => {
    const db = seed({
      manager_sms_numbers: [
        { id: "n-1", manager_user_id: prakrit, workspace_id: PRAKRIT_WS, phone_number: "+12065550001", provision_state: "active" },
      ],
      workspace_work_numbers: [{ workspace_id: PRAKRIT_WS, number_id: "n-1", is_primary: true, created_at: "2026-02-02" }],
    });
    const result = await provisionNumberForWorkspace(db as never, prakrit, { workspaceId: PRAKRIT_WS });
    expect(result).toMatchObject({ ok: false, code: "cap_exceeded" });
    expect(mocks.provisionManagerNumber).not.toHaveBeenCalled();
  });

  it("refuses once the account is at its included + extra_work_number budget", async () => {
    mocks.loadManagerPlanAddonQuantities.mockResolvedValue({
      ok: true,
      quantities: { extra_comms_credit: 0, extra_resident: 0, extra_work_number: 0, extra_workspace: 0, extra_seat: 0 },
    });
    // Business includes 1 per owned workspace; this account owns 1 workspace
    // and already holds 1 home number account-wide — at budget.
    const db = seed({
      manager_sms_numbers: [
        { id: "n-1", manager_user_id: prakrit, workspace_id: PRAKRIT_WS2, phone_number: "+12065550001", provision_state: "active" },
      ],
      portal_workspaces: [
        { id: PRAKRIT_WS, owner_user_id: prakrit, name: "My workspace", is_default: true, created_at: "2026-02-01" },
      ],
    });
    const result = await provisionNumberForWorkspace(db as never, prakrit, { workspaceId: PRAKRIT_WS });
    expect(result).toMatchObject({ ok: false, code: "budget_exceeded" });
    expect(mocks.provisionManagerNumber).not.toHaveBeenCalled();
  });

  it("provisions and syncs the join table as primary when within budget and the workspace has no home number", async () => {
    const db = seed();
    const result = await provisionNumberForWorkspace(db as never, prakrit, { workspaceId: PRAKRIT_WS });
    expect(result).toMatchObject({ ok: true, number: "+12065550001" });
    expect(mocks.provisionManagerNumber).toHaveBeenCalledWith(db, prakrit, { workspaceId: PRAKRIT_WS });
  });
});
