/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

/**
 * The assignment directory is the MANAGER's team and vendor list, and
 * `/api/portal-vendors` answers 403 to anyone else by design. The shared
 * calendar renders in the vendor portal too, so fetching it unconditionally put
 * a 403 in the console on every vendor calendar load (PRP-215) — an
 * authorization boundary working correctly, reported as a bug because the
 * client asked a question it had no business asking.
 */
// `vi.mock` is hoisted above these declarations, so the spies live on a
// hoisted holder the factories read lazily.
const spies = vi.hoisted(() => ({
  syncManagerVendorsFromServer: vi.fn(async () => []),
  syncProRelationshipsFromServer: vi.fn(async () => []),
}));

vi.mock("@/lib/manager-vendors-storage", () => ({
  MANAGER_VENDORS_EVENT: "manager-vendors",
  readOwnManagerVendorRows: () => [{ id: "v1", name: "Acme Plumbing" }],
  syncManagerVendorsFromServer: spies.syncManagerVendorsFromServer,
}));

vi.mock("@/lib/pro-relationships", () => ({
  readProRelationships: () => [],
  syncProRelationshipsFromServer: spies.syncProRelationshipsFromServer,
}));

const { syncManagerVendorsFromServer, syncProRelationshipsFromServer } = spies;

vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", email: "manager@example.com", ready: true }),
}));

import { useWorkAssignmentDirectory } from "@/hooks/use-work-assignment-directory";

beforeEach(() => {
  syncManagerVendorsFromServer.mockClear();
  syncProRelationshipsFromServer.mockClear();
});

describe("useWorkAssignmentDirectory", () => {
  it("loads the directory for a manager viewer", async () => {
    const { result } = renderHook(() => useWorkAssignmentDirectory({ managerUserId: "mgr-1" }));
    await waitFor(() => expect(syncManagerVendorsFromServer).toHaveBeenCalledTimes(1));
    expect(syncProRelationshipsFromServer).toHaveBeenCalledTimes(1);
    expect(result.current.vendors).toHaveLength(1);
    expect(result.current.teamMembers.length).toBeGreaterThan(0);
  });

  it("asks for nothing when the viewer is not a manager", async () => {
    const { result } = renderHook(() =>
      useWorkAssignmentDirectory({ managerUserId: "mgr-1", enabled: false }),
    );
    // Give the effect a chance to run before asserting it did not fetch.
    await waitFor(() => expect(result.current.teamMembers).toEqual([]));
    expect(syncManagerVendorsFromServer).not.toHaveBeenCalled();
    expect(syncProRelationshipsFromServer).not.toHaveBeenCalled();
    expect(result.current.vendors).toEqual([]);
  });
});
