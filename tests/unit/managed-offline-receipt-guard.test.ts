import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveManaged = vi.fn();
vi.mock("@/lib/managed-finance/resolve.server", () => ({ resolveManagedForProperties: (...a: unknown[]) => resolveManaged(...a) }));

import { offlineReceiptRefusedForManagedRent } from "@/lib/managed-finance/offline-receipt-guard.server";

describe("rent on a PropLane-managed workspace cannot be marked paid by hand", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses rent on a managed house", async () => {
    resolveManaged.mockResolvedValue({ workspaceId: "w", policy: {} });
    expect(await offlineReceiptRefusedForManagedRent({} as never, { kind: "rent", propertyId: "p1" })).toBe(true);
  });

  it("allows rent on a self-serve house, and anything that is not rent", async () => {
    resolveManaged.mockResolvedValue(null);
    expect(await offlineReceiptRefusedForManagedRent({} as never, { kind: "rent", propertyId: "p1" })).toBe(false);
    resolveManaged.mockResolvedValue({ workspaceId: "w", policy: {} });
    expect(await offlineReceiptRefusedForManagedRent({} as never, { kind: "security_deposit", propertyId: "p1" })).toBe(false);
  });

  it("fails closed for rent when the workspace cannot be read", async () => {
    resolveManaged.mockRejectedValue(new Error("db down"));
    expect(await offlineReceiptRefusedForManagedRent({} as never, { kind: "rent", propertyId: "p1" })).toBe(true);
  });
});
