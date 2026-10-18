import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: { mode: "per_workspace" } as Record<string, unknown>,
  sendFromManagerWorkNumber: vi.fn(),
}));

vi.mock("@/lib/one-number/shared-line-number.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/one-number/shared-line-number.server")>()),
  readSharedLineConfig: vi.fn(async () => ({
    mode: "per_workspace", sharedNumber: null, messagingServiceSid: null, pilotWorkspaceIds: [], ...mocks.config,
  })),
}));
vi.mock("@/lib/proplane-sms-transport.server", () => ({ sendFromManagerWorkNumber: mocks.sendFromManagerWorkNumber }));

import { sendSharedLineMessage, sharedLineFailureReason } from "@/lib/one-number/send.server";
import { buildSharedLineSignOff } from "@/lib/one-number/shared-line-number.server";

const base = {
  workspaceId: "ws-1", ownerUserId: "owner-1", toPhone: "+12065550142", body: "Your tour is booked.",
  role: "prospect" as const, idempotencyKey: "turn-1",
};

describe("sendSharedLineMessage", () => {
  beforeEach(() => {
    mocks.config = { mode: "per_workspace" };
    mocks.sendFromManagerWorkNumber.mockReset().mockResolvedValue({ ok: true, sid: "SM1", durablyAccepted: true });
  });

  it("refuses unless the line is shared, and never touches the transport", async () => {
    await expect(sendSharedLineMessage({} as never, base)).resolves.toEqual({ ok: false, reason: "not_shared_mode" });
    mocks.config = { mode: "shadow", sharedNumber: "+12065550100" };
    await expect(sendSharedLineMessage({} as never, base)).resolves.toEqual({ ok: false, reason: "not_shared_mode" });
    expect(mocks.sendFromManagerWorkNumber).not.toHaveBeenCalled();
  });

  it("needs the shared number to be attached", async () => {
    mocks.config = { mode: "shared", sharedNumber: null };
    await expect(sendSharedLineMessage({} as never, base)).resolves.toEqual({ ok: false, reason: "no_shared_number" });
  });

  it("holds a workspace outside the pilot back", async () => {
    mocks.config = { mode: "shared", sharedNumber: "+12065550100", pilotWorkspaceIds: ["ws-2"] };
    await expect(sendSharedLineMessage({} as never, base)).resolves.toEqual({ ok: false, reason: "not_shared_mode" });
  });

  it("goes through the work-number transport with the workspace, an idempotent key, a GSM-7 body and the sign-off", async () => {
    mocks.config = { mode: "shared", sharedNumber: "+12065550100", pilotWorkspaceIds: [] };
    const result = await sendSharedLineMessage({} as never, {
      ...base, body: "It’s booked 😊", signOff: "5259 Brooklyn team",
    });
    expect(result).toEqual({ ok: true, messageSid: "SM1", segments: 1 });
    expect(mocks.sendFromManagerWorkNumber).toHaveBeenCalledWith(expect.objectContaining({
      managerUserId: "owner-1", workspaceId: "ws-1", to: "+12065550142",
      text: "It's booked\n- 5259 Brooklyn team", dedupeKey: "shared-line:turn-1",
      counterpartyRole: "prospect", sendClass: "transactional",
    }));
  });

  it("maps refusals onto the contract reasons", async () => {
    mocks.config = { mode: "shared", sharedNumber: "+12065550100" };
    const cases: Array<[string, string]> = [
      ["recipient_opted_out", "opted_out"],
      ["quiet_hours", "quiet_hours"],
      ["comms_billing_insufficient_credit", "budget"],
      ["campaign_segment_budget_exhausted", "budget"],
      ["number_not_attached", "provider_error"],
    ];
    for (const [error, reason] of cases) {
      mocks.sendFromManagerWorkNumber.mockResolvedValueOnce({ ok: false, error });
      await expect(sendSharedLineMessage({} as never, base)).resolves.toMatchObject({ ok: false, reason });
    }
    expect(sharedLineFailureReason(undefined)).toEqual({ reason: "provider_error", detail: undefined });
  });

  it("refuses an empty body", async () => {
    mocks.config = { mode: "shared", sharedNumber: "+12065550100" };
    await expect(sendSharedLineMessage({} as never, { ...base, body: "😊" })).resolves.toMatchObject({ ok: false, reason: "provider_error" });
  });
});

describe("sign-off", () => {
  it("is '<name> team', trimmed, and absent for an empty name", () => {
    expect(buildSharedLineSignOff("  5259   Brooklyn ")).toBe("5259 Brooklyn team");
    expect(buildSharedLineSignOff("")).toBeNull();
    expect(buildSharedLineSignOff(null)).toBeNull();
  });
});
