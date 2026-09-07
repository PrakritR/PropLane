/**
 * PRP-429 — an unloaded portfolio must never read as an empty one.
 *
 * `syncManagerPortfolioFromServer` used to resolve `void`, so every caller had
 * to fall back to the local store, which is empty both for a brand-new account
 * and for one whose fetch failed. The first-listing onboarding acted on that and
 * seeded a phantom "Property · New listing" draft onto established portfolios.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { syncPropertyPipelineFromServer, syncProRelationshipsFromServer } = vi.hoisted(() => ({
  syncPropertyPipelineFromServer: vi.fn<() => Promise<boolean>>(),
  syncProRelationshipsFromServer: vi.fn<() => Promise<void>>(),
}));

vi.mock("@/lib/demo-property-pipeline", () => ({
  syncPropertyPipelineFromServer,
  readAllExtraListings: () => [],
  readAllPendingManagerProperties: () => [],
  readExtraListingsForUser: () => [],
  readPendingManagerPropertiesForUser: () => [],
  readScopedExtraListings: () => [],
  buildMockPropertyFromDraft: () => null,
}));

vi.mock("@/lib/pro-relationships", () => ({
  syncProRelationshipsFromServer,
  readProRelationships: () => [],
}));

vi.mock("@/lib/portal-data-store", () => ({
  readCachedAccountLinkInvites: () => [],
}));

import { syncManagerPortfolioFromServer } from "@/lib/manager-portfolio-access";

describe("syncManagerPortfolioFromServer reports whether the portfolio loaded", () => {
  beforeEach(() => {
    syncPropertyPipelineFromServer.mockReset();
    syncProRelationshipsFromServer.mockReset();
    syncProRelationshipsFromServer.mockResolvedValue(undefined);
  });

  it("resolves true when the pipeline sync landed", async () => {
    syncPropertyPipelineFromServer.mockResolvedValue(true);
    expect(await syncManagerPortfolioFromServer("mgr-1", { force: true })).toBe(true);
  });

  it("resolves false when the pipeline sync reports failure", async () => {
    syncPropertyPipelineFromServer.mockResolvedValue(false);
    expect(await syncManagerPortfolioFromServer("mgr-1", { force: true })).toBe(false);
  });

  it("resolves false when a sync throws instead of returning", async () => {
    syncPropertyPipelineFromServer.mockRejectedValue(new Error("offline"));
    expect(await syncManagerPortfolioFromServer("mgr-1", { force: true })).toBe(false);
  });

  it("resolves false without a user id, and never calls the server", async () => {
    expect(await syncManagerPortfolioFromServer("   ")).toBe(false);
    expect(syncPropertyPipelineFromServer).not.toHaveBeenCalled();
  });
});
