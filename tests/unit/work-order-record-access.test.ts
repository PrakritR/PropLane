import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A section of a service record a co-manager can open must not come back empty for them: the
 * completion-photo read admits exactly who the record list admits.
 */
const scope = vi.hoisted(() => ({
  linked: new Set<string>(),
  workspacePropertyIds: null as string[] | null,
  owned: [] as Array<{ id: string }>,
}));

vi.mock("@/lib/auth/co-manager-module-scope", () => ({
  linkedPropertyIdsForModule: async () => new Set(scope.linked),
  resolveManagerWorkspaceRowScope: async () => ({ propertyIds: scope.workspacePropertyIds, untaggedOwnedVisible: true }),
  rowInWorkspaceScope: (propertyId: string | null | undefined, s: { propertyIds: string[] | null; untaggedOwnedVisible: boolean }) => {
    if (s.propertyIds === null) return true;
    const pid = (propertyId ?? "").trim();
    return pid ? s.propertyIds.includes(pid) : s.untaggedOwnedVisible;
  },
}));

import { mayReadWorkOrderRecord } from "@/lib/work-order-record-access.server";

const db = {
  from: () => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: scope.owned }) }) }) }),
} as never;

const record = (over: Record<string, unknown> = {}) => ({
  managerUserId: "owner",
  vendorUserId: "vendor",
  rowData: { id: "wo1", propertyId: "p1" },
  ...over,
}) as Parameters<typeof mayReadWorkOrderRecord>[2];

describe("mayReadWorkOrderRecord", () => {
  beforeEach(() => {
    scope.linked = new Set();
    scope.workspacePropertyIds = null;
    scope.owned = [];
  });

  it("admits the owning manager and the assigned vendor", async () => {
    expect(await mayReadWorkOrderRecord(db, "owner", record())).toBe(true);
    expect(await mayReadWorkOrderRecord(db, "vendor", record())).toBe(true);
  });

  it("admits a co-manager holding the house with Services access", async () => {
    scope.linked = new Set(["p1"]);
    expect(await mayReadWorkOrderRecord(db, "co", record())).toBe(true);
  });

  it("refuses a manager with no claim on the house, and one whose workspace excludes it", async () => {
    expect(await mayReadWorkOrderRecord(db, "co", record())).toBe(false);
    scope.linked = new Set(["p1"]);
    scope.workspacePropertyIds = ["p2"];
    expect(await mayReadWorkOrderRecord(db, "co", record())).toBe(false);
  });

  it("refuses when the record names no house, and when there is no signed-in user", async () => {
    scope.linked = new Set(["p1"]);
    expect(await mayReadWorkOrderRecord(db, "co", record({ rowData: { id: "wo1" } }))).toBe(false);
    expect(await mayReadWorkOrderRecord(db, "", record())).toBe(false);
  });
});
