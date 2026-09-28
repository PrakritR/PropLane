import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-requested-path": "/resident/tours?status=scheduled" }),
}));

vi.mock("@/lib/auth/admin-preview", () => ({
  getAdminPreviewFromCookies: vi.fn(async () => null),
}));

vi.mock("@/lib/auth/portal-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/portal-access")>()),
  getPortalAccessContext: vi.fn(),
}));

import { getPortalAccessContext } from "@/lib/auth/portal-access";
import { assertPortalLayoutRole } from "@/lib/auth/portal-layout-guard";

describe("assertPortalLayoutRole resident tour access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lets a manager with the resident role open tour routes while the manager portal cookie is active", async () => {
    vi.mocked(getPortalAccessContext).mockResolvedValue({
      user: { id: "dual-1", email: "mgr@example.com" },
      profile: { role: "manager", email: "mgr@example.com" },
      roles: ["manager", "resident"],
      effectiveRole: "manager",
    } as never);

    await expect(
      assertPortalLayoutRole("resident", "resident", { allowResidentTourAccess: true }),
    ).resolves.toBeUndefined();
  });

  it("still redirects a manager-only account away from the resident portal", async () => {
    vi.mocked(getPortalAccessContext).mockResolvedValue({
      user: { id: "mgr-1", email: "mgr@example.com" },
      profile: { role: "manager", email: "mgr@example.com" },
      roles: ["manager"],
      effectiveRole: "manager",
    } as never);

    await expect(
      assertPortalLayoutRole("resident", "resident", { allowResidentTourAccess: true }),
    ).rejects.toThrow("redirect:/auth/sign-in?next=%2Fresident%2Ftours%3Fstatus%3Dscheduled");
  });

  it("preserves the requested tour path for a signed-out visitor", async () => {
    vi.mocked(getPortalAccessContext).mockResolvedValue({
      user: null,
      profile: null,
      roles: [],
      effectiveRole: null,
    } as never);

    await expect(
      assertPortalLayoutRole("resident", "resident", { allowResidentTourAccess: true }),
    ).rejects.toThrow("redirect:/auth/sign-in?next=%2Fresident%2Ftours%3Fstatus%3Dscheduled");
  });
});
