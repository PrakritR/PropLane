/**
 * `assertManagerCommunicationAllowedForActiveWorkspace` is what the welcome / invite routes ask:
 * the plan of the ACTIVE workspace's owner (not the acting teammate), failing closed when the
 * workspace or the plan cannot be read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  active: vi.fn(),
  plan: vi.fn(),
  owner: "owner-1",
}));

vi.mock("@/lib/workspaces/active.server", () => ({ resolveActiveWorkspaceFromRequest: h.active }));
vi.mock("@/lib/manager-access-server", () => ({ getEffectiveManagerSkuTier: h.plan }));

import {
  MANAGER_COMMUNICATION_TRIAL_MESSAGE,
  assertManagerCommunicationAllowedForActiveWorkspace,
  communicationRefusalBody,
} from "@/lib/manager-communication-access.server";

const db = {
  from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { owner_user_id: h.owner }, error: null }) }) }),
  }),
} as never;

beforeEach(() => {
  h.active.mockReset();
  h.plan.mockReset();
  h.owner = "owner-1";
  h.active.mockResolvedValue({ id: "ws-1", ownerUserId: "owner-1" });
});

describe("assertManagerCommunicationAllowedForActiveWorkspace", () => {
  it("refuses a teammate acting in a trial owner's workspace, on the owner's plan", async () => {
    h.plan.mockResolvedValue({ ok: true, liveSignupTrial: true });
    const result = await assertManagerCommunicationAllowedForActiveWorkspace(db, "mate-1");
    expect(result).toEqual({ allowed: false, reason: "trial", status: 402, message: MANAGER_COMMUNICATION_TRIAL_MESSAGE });
    expect(h.plan).toHaveBeenCalledWith("owner-1");
  });

  it("allows a paid owner", async () => {
    h.plan.mockResolvedValue({ ok: true, liveSignupTrial: false });
    expect(await assertManagerCommunicationAllowedForActiveWorkspace(db, "mate-1")).toEqual({ allowed: true });
  });

  it("fails closed when the plan cannot be read", async () => {
    h.plan.mockResolvedValue({ ok: false });
    expect(await assertManagerCommunicationAllowedForActiveWorkspace(db, "mate-1")).toMatchObject({
      allowed: false,
      reason: "plan_unreadable",
      status: 503,
    });
  });

  it("fails closed when the active workspace cannot be resolved", async () => {
    h.active.mockRejectedValue(new Error("boom"));
    expect(await assertManagerCommunicationAllowedForActiveWorkspace(db, "mate-1")).toMatchObject({
      allowed: false,
      reason: "plan_unreadable",
      status: 503,
    });
    expect(h.plan).not.toHaveBeenCalled();
  });

  it("builds the refusal body routes answer with", () => {
    expect(
      communicationRefusalBody({ allowed: false, reason: "trial", status: 402, message: MANAGER_COMMUNICATION_TRIAL_MESSAGE }),
    ).toEqual({ ok: false, error: MANAGER_COMMUNICATION_TRIAL_MESSAGE, code: "communication_trial" });
  });
});
