// @vitest-environment jsdom
/**
 * The lease generator's landlord name is one workspace's answer. This mount must stay silent until
 * the workspace selection has loaded: an unqualified read resolves the ACCOUNT rung, and caching
 * that as the active workspace's name prints the wrong party on a document a resident signs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({ activeWorkspaceId: null as string | null }));

vi.mock("@/components/portal/workspace-provider", () => ({
  useWorkspaces: () => ({ active: h.activeWorkspaceId ? { id: h.activeWorkspaceId } : null }),
}));
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));
vi.mock("@/lib/manager-landlord-profile", () => ({
  cacheLandlordLegalName: vi.fn(),
  fetchAndCacheLandlordLegalName: vi.fn(async () => ""),
}));

import { LandlordLegalNameCacheSync } from "@/components/portal/landlord-legal-name-cache-sync";
import { cacheLandlordLegalName, fetchAndCacheLandlordLegalName } from "@/lib/manager-landlord-profile";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LandlordLegalNameCacheSync", () => {
  it("reads nothing and caches nothing while the workspace selection is still loading", async () => {
    h.activeWorkspaceId = null;
    render(<LandlordLegalNameCacheSync />);
    await waitFor(() => expect(document.body).toBeTruthy());
    expect(fetchAndCacheLandlordLegalName).not.toHaveBeenCalled();
    expect(cacheLandlordLegalName).not.toHaveBeenCalled();
  });

  it("reads the active workspace's own name once it is known", async () => {
    h.activeWorkspaceId = "ws-a";
    render(<LandlordLegalNameCacheSync />);
    await waitFor(() => expect(fetchAndCacheLandlordLegalName).toHaveBeenCalledWith("ws-a"));
  });
});
