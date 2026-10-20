// Where a rent text leaves from, and the pay link it carries.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ shared: vi.fn(), workNumber: vi.fn(), line: vi.fn() }));
vi.mock("@/lib/one-number/send.server", () => ({ sendSharedLineMessage: mocks.shared }));
vi.mock("@/lib/proplane-sms-transport.server", () => ({ sendFromManagerWorkNumber: mocks.workNumber }));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({ resolveWorkspaceSendLine: mocks.line }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: vi.fn(async () => ({ kind: "normal" })),
  lookupRecordTestWorkspaceId: vi.fn(async () => null),
}));

import { sendWorkspaceText } from "@/lib/one-number/link-text.server";
import { mintRentReminderPayLink } from "@/lib/payments/rent-reminder-links.server";
import { sendResidentRentText } from "@/lib/payments/rent-text-send.server";
import { linksFakeDb, type Row } from "../helpers/links-fake-db";

const WS = "ws-a";
const world = (mode: string, over: { isService?: boolean; pilot?: string[] } = {}) =>
  linksFakeDb({
    portal_workspaces: [{ id: WS, owner_user_id: "owner-a", is_default: true, is_service: over.isService === true }],
    manager_property_records: [{ id: "prop-1", workspace_id: WS, manager_user_id: "owner-a" }],
    sms_runtime_config: [{ singleton: true, line_mode: mode, shared_number_e164: "+12065550100", shared_pilot_workspace_ids: over.pilot ?? [] }] as Row[],
  }).db;

const rent = (db: never, over: Record<string, unknown> = {}) =>
  sendResidentRentText(db, {
    ownerUserId: "owner-a", propertyId: "prop-1", phone: "+12065550142", body: "Rent is due.\nPay here:\nhttps://proplane.ai/l/tok",
    purpose: "payment_reminder", sendClass: "transactional", idempotencyKey: "k-1", residentUserId: "res-1", residentEmail: "r@e.com", ...over,
  } as never);

beforeEach(() => {
  mocks.shared.mockReset();
  mocks.workNumber.mockReset().mockResolvedValue({ ok: true, outboxId: "ob-1" });
  mocks.line.mockReset().mockResolvedValue({ phoneNumber: "+12065550111", numberId: "line-1" });
});

describe("a rent text leaves from the line of the workspace that holds the house", () => {
  it("on the PropLane line (shared mode) it goes through the shared sender as the resident, with its own consent purpose", async () => {
    mocks.shared.mockResolvedValue({ ok: true, messageSid: "SM1", segments: 1 });
    expect((await rent(world("shared"))).ok).toBe(true);
    expect(mocks.shared.mock.calls[0]![1]).toMatchObject({
      workspaceId: WS, ownerUserId: "owner-a", role: "resident", idempotencyKey: "k-1",
      delivery: { sendClass: "transactional", purpose: "payment_reminder", recipientUserId: "res-1" },
    });
    expect(mocks.workNumber).not.toHaveBeenCalled();
  });

  it("with its own work number it sends from THAT line, in the thread, as the resident", async () => {
    expect((await rent(world("per_workspace"))).ok).toBe(true);
    expect(mocks.workNumber).toHaveBeenCalledWith(expect.objectContaining({
      managerUserId: "owner-a", workspaceId: WS, propertyId: "prop-1", selectedWorkLineId: "line-1", sendClass: "transactional",
      purpose: "payment_reminder", counterpartyRole: "resident", residentUserId: "res-1", residentEmail: "r@e.com", skipLog: false,
    }));
  });

  it("an automated reminder keeps its class so quiet hours apply, on either door", async () => {
    await rent(world("per_workspace"), { sendClass: "automated", purpose: "weekly_rent_reminder" });
    expect(mocks.workNumber.mock.calls[0]![0]).toMatchObject({ sendClass: "automated", purpose: "weekly_rent_reminder" });
    mocks.shared.mockResolvedValue({ ok: true, messageSid: "SM1", segments: 1 });
    await rent(world("shared"), { sendClass: "automated", purpose: "weekly_rent_reminder" });
    expect(mocks.shared.mock.calls[0]![1].delivery).toMatchObject({ sendClass: "automated", purpose: "weekly_rent_reminder" });
  });

  it("PropLane's own service workspace with no number of its own texts from the service owner's line", async () => {
    mocks.workNumber
      .mockResolvedValueOnce({ ok: false, error: "workspace_has_no_work_number" })
      .mockResolvedValueOnce({ ok: true, outboxId: "ob-2" });
    mocks.line.mockResolvedValue(null);
    const result = await rent(world("per_workspace", { isService: true }));
    expect(result).toEqual({ ok: true, outboxId: "ob-2" });
    expect(mocks.workNumber).toHaveBeenCalledTimes(2);
    expect(mocks.workNumber.mock.calls[1]![0]).not.toHaveProperty("workspaceId");
    expect(mocks.workNumber.mock.calls[1]![0]).not.toHaveProperty("selectedWorkLineId");
  });

  it("any other workspace with no number of its own is refused, never given another customer's line", async () => {
    mocks.workNumber.mockResolvedValue({ ok: false, error: "workspace_has_no_work_number" });
    mocks.line.mockResolvedValue(null);
    expect(await rent(world("per_workspace"))).toEqual({ ok: false, error: "workspace_has_no_work_number" });
    expect(mocks.workNumber).toHaveBeenCalledTimes(1);
  });

  it("maps the shared sender's refusals onto the reminder claim's words, never falling back to another number", async () => {
    const cases: Array<[string, string]> = [["opted_out", "recipient_opted_out"], ["budget", "allowance_exhausted"], ["quiet_hours", "quiet_hours"]];
    for (const [reason, error] of cases) {
      mocks.shared.mockResolvedValueOnce({ ok: false, reason });
      expect(await rent(world("shared"))).toEqual({ ok: false, error });
    }
    expect(mocks.workNumber).not.toHaveBeenCalled();
  });

  it("puts every link in the body on its own line on the canonical host before it leaves", async () => {
    await rent(world("per_workspace"), { body: "Pay now https://proplane-x.vercel.app/l/tok." });
    expect(mocks.workNumber.mock.calls[0]![0].text).toBe("Pay now\nhttps://proplane.ai/l/tok");
  });

  it("is a plain refusal for a house whose workspace cannot be read", async () => {
    expect(await rent(world("per_workspace"), { propertyId: null, ownerUserId: "nobody" })).toEqual({ ok: false, error: "workspace_unavailable" });
  });
});

describe("sendWorkspaceText basis", () => {
  it("a code is control class on the work-number door too", async () => {
    await sendWorkspaceText(world("per_workspace"), {
      workspaceId: WS, phoneKey: "2065550142", body: "123456 is your PropLane code.", role: "resident", idempotencyKey: "phone-code:c1", basis: { kind: "code" },
    });
    expect(mocks.workNumber.mock.calls[0]![0]).toMatchObject({ sendClass: "control", purpose: "phone_link_code", skipLog: true });
  });
});

describe("mintRentReminderPayLink", () => {
  const charges = [{ id: "c1", propertyId: "prop-1", residentUserId: "res-1" }];
  const verified = "2026-09-01T00:00:00Z";
  const mint = (db: never, over: Record<string, unknown> = {}) =>
    mintRentReminderPayLink(db, { ownerUserId: "owner-a", charges, phone: "(206) 555-0142", phoneVerifiedAt: verified, ...over } as never);

  it("mints a phone-bound rent link for the verified phone, naming exactly these charges in the house's workspace", async () => {
    const w = linksFakeDb({
      portal_workspaces: [{ id: WS, owner_user_id: "owner-a", is_default: true }],
      manager_property_records: [{ id: "prop-1", workspace_id: WS, manager_user_id: "owner-a" }],
    });
    const out = await mint(w.db);
    expect(out.kind).toBe("phone_bound");
    expect(out.url).toMatch(/^https?:\/\/[^/]+\/l\/[A-Za-z0-9_-]{40,}$/);
    expect(w.rows.phone_bound_links![0]).toMatchObject({ phone_key: "2065550142", purpose: "rent", target_type: "charge", target_id: "c1", workspace_id: WS, requires_otp: true });
  });

  it("each reminder gets its own link and yesterday's keeps working", async () => {
    const w = linksFakeDb({
      portal_workspaces: [{ id: WS, owner_user_id: "owner-a", is_default: true }],
      manager_property_records: [{ id: "prop-1", workspace_id: WS, manager_user_id: "owner-a" }],
    });
    const first = await mint(w.db);
    const second = await mint(w.db);
    expect(first.url).not.toBe(second.url);
    expect(w.rows.phone_bound_links).toHaveLength(2);
    expect(w.rows.phone_bound_links!.every((l) => !l.revoked_at)).toBe(true);
  });

  it("falls back to the portal Payments page without a verified phone, without a resident on the charge, or on any refusal", async () => {
    const w = linksFakeDb({
      portal_workspaces: [{ id: WS, owner_user_id: "owner-a", is_default: true }],
      manager_property_records: [{ id: "prop-1", workspace_id: WS, manager_user_id: "owner-a" }],
    });
    for (const out of [
      await mint(w.db, { phoneVerifiedAt: null }),
      await mint(w.db, { phone: "" }),
      await mint(w.db, { charges: [{ id: "c1", propertyId: "prop-1", residentUserId: null }] }),
      await mint(w.db, { charges: [{ id: "a,b", propertyId: "prop-1", residentUserId: "res-1" }] }),
      await mint(linksFakeDb({}, { broken: ["portal_workspaces"] }).db),
    ]) {
      expect(out.kind).toBe("portal");
      expect(out.url).toContain("/resident/payments");
    }
    expect(w.rows.phone_bound_links ?? []).toHaveLength(0);
  });
});
