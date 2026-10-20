// The monthly owner text must reach an owner whose only consent is their own verified profile phone.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

const mocks = vi.hoisted(() => ({ text: vi.fn(), email: vi.fn(), finances: vi.fn() }));
vi.mock("@/lib/one-number/link-text.server", () => ({ sendWorkspacePhoneText: mocks.text }));
vi.mock("@/lib/manager-notice-email.server", () => ({ sendManagerNoticeEmail: mocks.email }));
vi.mock("@/lib/managed-finance/finances.server", () => ({ loadOwnerFinances: mocks.finances }));

import { sendMonthlyOwnerStatements } from "@/lib/owner-management/monthly-statements.server";

const NOW = new Date("2026-10-01T18:00:00Z");

beforeEach(() => {
  vi.resetAllMocks();
  mocks.text.mockResolvedValue(true);
  mocks.email.mockResolvedValue({ status: "sent" });
  mocks.finances.mockResolvedValue({
    statement: {
      rows: [{}], beginningCents: 0, endingCents: 336_000,
      totals: { rentGrossCents: 400_000, feeCents: -40_000, vendorChargesCents: -24_000, otherCents: 0, netCents: 336_000, withdrawalsCents: 0 },
    },
    workspace: { name: "Seattle Homes" },
  });
});

describe("sendMonthlyOwnerStatements texting", () => {
  it("texts a verified-phone owner under the manager-notice basis, never a code or an application grant", async () => {
    const db = createMemoryDb({
      managed_workspace_fee_policies: [{ workspace_id: "ws-m", owner_user_id: "owner-1", status: "active", signed_at: "2026-09-01T00:00:00Z" }],
      portal_workspaces: [{ id: "ws-m", owner_user_id: "mgr-1", name: "Seattle Homes" }],
      profiles: [{ id: "owner-1", phone: "+12065550123", phone_verified_at: "2026-09-01T00:00:00Z" }],
    });
    expect(await sendMonthlyOwnerStatements(db as never, NOW)).toEqual({ sent: 1, skipped: 0 });
    expect(mocks.text).toHaveBeenCalledTimes(1);
    expect(mocks.text.mock.calls[0]![1]).toMatchObject({
      workspaceId: "ws-m", phoneKey: "+12065550123", role: "manager",
      basis: { kind: "manager_notice", topic: "owner_statement", recipientUserId: "owner-1" },
    });
  });

  it("a month whose email AND text both failed is re-driven next run, then sent once", async () => {
    const db = createMemoryDb({
      managed_workspace_fee_policies: [{ workspace_id: "ws-m", owner_user_id: "owner-1", status: "active", signed_at: "2026-09-01T00:00:00Z" }],
      portal_workspaces: [{ id: "ws-m", owner_user_id: "mgr-1", name: "Seattle Homes" }],
      profiles: [{ id: "owner-1", phone: "+12065550123", phone_verified_at: "2026-09-01T00:00:00Z" }],
    });
    // A provider outage: the row is claimed but nothing is delivered, so no stamp is written.
    mocks.email.mockResolvedValue({ status: "failed" });
    mocks.text.mockResolvedValue(false);
    expect(await sendMonthlyOwnerStatements(db as never, NOW)).toEqual({ sent: 0, skipped: 1 });
    const claimed = (db.__tables.owner_statements ?? [])[0]!;
    expect(claimed).toMatchObject({ workspace_id: "ws-m", month_key: "2026-09" });
    expect(claimed.emailed_at ?? null).toBeNull();
    expect(claimed.texted_at ?? null).toBeNull();

    mocks.email.mockResolvedValue({ status: "sent" });
    mocks.text.mockResolvedValue(true);
    expect(await sendMonthlyOwnerStatements(db as never, NOW)).toEqual({ sent: 1, skipped: 0 });
    expect((db.__tables.owner_statements ?? [])[0]!.texted_at).toBeTruthy();
    expect(mocks.text).toHaveBeenCalledTimes(2);

    // And a delivered month is never sent twice.
    expect(await sendMonthlyOwnerStatements(db as never, NOW)).toEqual({ sent: 0, skipped: 1 });
    expect(mocks.text).toHaveBeenCalledTimes(2);
  });

  it("keeps a stamp that already succeeded when the other channel failed", async () => {
    const db = createMemoryDb({
      managed_workspace_fee_policies: [{ workspace_id: "ws-m", owner_user_id: "owner-1", status: "active", signed_at: "2026-09-01T00:00:00Z" }],
      portal_workspaces: [{ id: "ws-m", owner_user_id: "mgr-1", name: "Seattle Homes" }],
      profiles: [{ id: "owner-1", phone: "+12065550123", phone_verified_at: "2026-09-01T00:00:00Z" }],
    });
    mocks.text.mockResolvedValue(false);
    expect(await sendMonthlyOwnerStatements(db as never, NOW)).toEqual({ sent: 1, skipped: 0 });
    const row = (db.__tables.owner_statements ?? [])[0]!;
    expect(row.emailed_at).toBeTruthy();
    expect(row.texted_at ?? null).toBeNull();
  });

  it("does not text an owner whose phone is not verified", async () => {
    const db = createMemoryDb({
      managed_workspace_fee_policies: [{ workspace_id: "ws-m", owner_user_id: "owner-1", status: "active", signed_at: "2026-09-01T00:00:00Z" }],
      portal_workspaces: [{ id: "ws-m", owner_user_id: "mgr-1", name: "Seattle Homes" }],
      profiles: [{ id: "owner-1", phone: "+12065550123", phone_verified_at: null }],
    });
    await sendMonthlyOwnerStatements(db as never, NOW);
    expect(mocks.text).not.toHaveBeenCalled();
  });
});
