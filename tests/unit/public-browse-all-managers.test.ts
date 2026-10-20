// /rent/browse lists live homes from EVERY manager who posted (service or not). The PropLane line's service-only catalog
// (`getServicePublicListings`, `workspaceIds`) must never reach the public catalog route or the browse page.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPublicListings: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/public-listings.server", () => ({ getPublicListings: mocks.getPublicListings }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveTestWorkspaceRequestScope: vi.fn(async () => ({ kind: "none" })) }));
vi.mock("@/lib/server-ttl-cache", () => ({
  createTtlCache: () => ({ get: async (_k: string, load: () => Promise<unknown>) => load(), clear: () => undefined }),
  serverSnapshotCacheEnabled: () => false,
}));

import { GET } from "@/app/api/property-records/public/route";

const listings = [
  { id: "service-home", workspaceId: "ws-service", managerUserId: "owner-1", address: "5259 Brooklyn Ave NE" },
  { id: "free-home", workspaceId: "ws-free", managerUserId: "mgr-free", address: "12 Elm St" },
  { id: "pro-home", workspaceId: "ws-pro", managerUserId: "mgr-pro", address: "77 Oak Dr", contactSmsPhone: "+12065550111" },
];

describe("public catalog behind /rent/browse", () => {
  beforeEach(() => {
    mocks.getPublicListings.mockReset();
    mocks.getPublicListings.mockResolvedValue(listings);
  });

  it("returns every manager's live home, not only the PropLane-managed ones", async () => {
    const res = await GET();
    const json = (await res.json()) as { listings: { id: string }[] };
    expect(json.listings.map((l) => l.id)).toEqual(["service-home", "free-home", "pro-home"]);
  });

  it("asks for the whole catalog: no workspace restriction", async () => {
    await GET();
    expect(mocks.getPublicListings).toHaveBeenCalledTimes(1);
    expect(mocks.getPublicListings.mock.calls[0]![0]).toEqual({ testWorkspaceId: null });
  });

  it("keeps the service-only filter out of the public route and the browse page", () => {
    const root = process.cwd();
    for (const file of [
      "src/app/api/property-records/public/route.ts",
      "src/components/marketing/rent-browse-page-client.tsx",
      "src/components/marketing/resident-housing-browse.tsx",
    ]) {
      const source = readFileSync(join(root, file), "utf8");
      expect(source, file).not.toMatch(/getServicePublicListings|loadServiceWorkspaceIds|workspaceIds|is_service/);
    }
  });
});
