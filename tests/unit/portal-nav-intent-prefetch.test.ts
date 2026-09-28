import { afterEach, describe, expect, it, vi } from "vitest";
import { prefetchPortalHref } from "@/lib/portal-nav-client";

describe("portal navigation intent prefetch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps explicit desktop intent prefetch available while automatic warming is disabled", () => {
    vi.stubEnv("NODE_ENV", "production");
    const router = { prefetch: vi.fn() } as unknown as Parameters<typeof prefetchPortalHref>[0];

    prefetchPortalHref(router, "/portal/properties");

    expect(router.prefetch).toHaveBeenCalledWith("/portal/properties");
  });
});
