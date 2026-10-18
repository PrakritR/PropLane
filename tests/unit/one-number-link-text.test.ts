import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ shared: vi.fn(), workNumber: vi.fn() }));
vi.mock("@/lib/one-number/send.server", () => ({ sendSharedLineMessage: mocks.shared }));
vi.mock("@/lib/proplane-sms-transport.server", () => ({ sendFromManagerWorkNumber: mocks.workNumber }));

import { roleForLinkPurpose, sendWorkspacePhoneText } from "@/lib/one-number/link-text.server";
import { linksFakeDb, type Row } from "../helpers/links-fake-db";

const WS = "ws-a";
const input = { workspaceId: WS, phoneKey: "2065550142", body: "123456 is your PropLane code.", role: "prospect" as const, idempotencyKey: "phone-code:c1" };
const world = (mode: string, pilot: string[] = []) =>
  linksFakeDb({
    portal_workspaces: [{ id: WS, owner_user_id: "owner-a" }],
    sms_runtime_config: [{ singleton: true, line_mode: mode, shared_number_e164: "+12065550100", shared_pilot_workspace_ids: pilot }] as Row[],
  }).db;

beforeEach(() => {
  mocks.shared.mockReset();
  mocks.workNumber.mockReset();
  mocks.workNumber.mockResolvedValue({ ok: true });
});

describe("sendWorkspacePhoneText", () => {
  it("per-workspace mode sends from the workspace's own work number, unlogged, never on the shared line", async () => {
    expect(await sendWorkspacePhoneText(world("per_workspace"), input)).toBe(true);
    expect(mocks.shared).not.toHaveBeenCalled();
    expect(mocks.workNumber).toHaveBeenCalledWith(expect.objectContaining({
      managerUserId: "owner-a", to: "+12065550142", text: input.body, sendClass: "transactional", skipLog: true, dedupeKey: "phone-code:c1",
    }));
  });

  it("shared mode goes through the shared-line sender with the workspace and role", async () => {
    mocks.shared.mockResolvedValue({ ok: true, messageSid: "SM1", segments: 1 });
    expect(await sendWorkspacePhoneText(world("shared"), input)).toBe(true);
    expect(mocks.shared.mock.calls[0]![1]).toMatchObject({
      workspaceId: WS, ownerUserId: "owner-a", toPhone: "+12065550142", role: "prospect", idempotencyKey: "phone-code:c1",
    });
    expect(mocks.workNumber).not.toHaveBeenCalled();
  });

  it("a real shared-line refusal is a refusal, not a fallback to another number", async () => {
    for (const reason of ["opted_out", "budget", "quiet_hours"] as const) {
      mocks.shared.mockResolvedValue({ ok: false, reason });
      expect(await sendWorkspacePhoneText(world("shared"), input)).toBe(false);
    }
    expect(mocks.workNumber).not.toHaveBeenCalled();
  });

  it("only while the shared sender is not live does a shared workspace fall back to its work number", async () => {
    mocks.shared.mockResolvedValue({ ok: false, reason: "not_shared_mode" });
    expect(await sendWorkspacePhoneText(world("shared"), input)).toBe(true);
    expect(mocks.workNumber).toHaveBeenCalledTimes(1);
  });

  it("a pilot list that leaves the workspace out uses the work number", async () => {
    expect(await sendWorkspacePhoneText(world("shared", ["other"]), input)).toBe(true);
    expect(mocks.shared).not.toHaveBeenCalled();
  });

  it("returns false for a bad phone, a missing workspace or a refused work-number send", async () => {
    expect(await sendWorkspacePhoneText(world("per_workspace"), { ...input, phoneKey: "12" })).toBe(false);
    expect(await sendWorkspacePhoneText(world("per_workspace"), { ...input, workspaceId: "nope" })).toBe(false);
    mocks.workNumber.mockResolvedValue({ ok: false, error: "recipient_opted_out" });
    expect(await sendWorkspacePhoneText(world("per_workspace"), input)).toBe(false);
  });
});

describe("roleForLinkPurpose", () => {
  it("bills a code as the role the person is acting in", () => {
    expect(roleForLinkPurpose("rent")).toBe("resident");
    expect(roleForLinkPurpose("move_in")).toBe("resident");
    expect(roleForLinkPurpose("lease")).toBe("applicant");
    expect(roleForLinkPurpose("job")).toBe("vendor");
    expect(roleForLinkPurpose("application")).toBe("prospect");
    expect(roleForLinkPurpose("tour")).toBe("prospect");
    expect(roleForLinkPurpose("gallery")).toBe("prospect");
  });
});
