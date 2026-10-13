import { describe, expect, it } from "vitest";
import { buildManagerAttentionRows, type ManagerAttentionInput } from "@/lib/manager-attention-queue";

const FULL: ManagerAttentionInput = {
  basePath: "/portal",
  overdueChargeCount: 2,
  overdueBalanceLabel: "$4,765",
  pendingApplicationCount: 3,
  managerSignatureLeaseCount: 1,
  pendingTourCount: 1,
  messagingNeedsSetup: true,
  messagingSettingsHref: "/portal/profile",
  draftPropertyCount: 2,
  draftsHref: "/portal/properties/drafts",
  unreadConversationCount: 4,
};

describe("manager attention queue (title and action only)", () => {
  it("draws no muted sentence under any row", () => {
    const rows = buildManagerAttentionRows(FULL);
    expect(rows.map((r) => r.id)).toEqual(["overdue", "applications", "leases", "tours", "messaging", "drafts", "inbox"]);
    for (const row of rows) expect(row.detail).toBeUndefined();
  });

  it("carries the overdue figure in the title instead", () => {
    const [overdue] = buildManagerAttentionRows(FULL);
    expect(overdue!.title).toBe("2 overdue charges · $4,765");
  });
});
