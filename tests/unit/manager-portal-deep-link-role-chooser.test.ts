import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => { throw new Error(`redirect:${path}`); }),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
}));
vi.mock("@/lib/auth/admin-preview", () => ({
  getAdminPreviewFromCookies: vi.fn(async () => null),
}));
vi.mock("@/lib/auth/portal-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/portal-access")>()),
  getPortalAccessContext: vi.fn(),
}));

import { headers } from "next/headers";
import { getPortalAccessContext } from "@/lib/auth/portal-access";
import { getProPortalRenderContext } from "@/lib/portals/pro-nav";

describe("manager portal deep link role chooser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(headers).mockResolvedValue(new Headers({
      "x-requested-path": "/portal/applications?bucket=pending",
    }) as never);
  });

  it.each([null, "resident"])("retains the requested Applications URL when active role is %s", async (effectiveRole) => {
    vi.mocked(getPortalAccessContext).mockResolvedValue({
      user: { id: "manager-1", email: "manager@test.example" },
      profile: { role: "manager" },
      roles: ["manager", "resident"],
      effectiveRole,
    } as never);

    await expect(getProPortalRenderContext()).rejects.toThrow(
      "redirect:/auth/choose-portal?next=%2Fportal%2Fapplications%3Fbucket%3Dpending",
    );
  });
});
