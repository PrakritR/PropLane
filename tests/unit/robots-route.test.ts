import { beforeEach, describe, expect, it, vi } from "vitest";

const headersMock = vi.fn();

vi.mock("next/headers", () => ({
  headers: () => headersMock(),
}));

describe("robots route", () => {
  beforeEach(() => {
    headersMock.mockReset();
  });

  it("disallows everything on staging and other non-canonical hosts", async () => {
    headersMock.mockResolvedValue(
      new Headers({ host: "staging-prop-lane.space" }),
    );
    const robots = (await import("@/app/robots")).default;
    const body = await robots();
    expect(body).toEqual({
      rules: { userAgent: "*", disallow: "/" },
    });
    expect(body).not.toHaveProperty("sitemap");
  });

  it("keeps marketing allow-list on proplane.ai", async () => {
    headersMock.mockResolvedValue(new Headers({ host: "proplane.ai" }));
    // Re-import after mock change — module may be cached; call again is fine
    // because robots() reads headers() each time.
    vi.resetModules();
    vi.doMock("next/headers", () => ({
      headers: () => headersMock(),
    }));
    headersMock.mockResolvedValue(new Headers({ host: "proplane.ai" }));
    const robots = (await import("@/app/robots")).default;
    const body = await robots();
    expect(body.rules).toMatchObject({
      userAgent: "*",
      allow: "/",
      disallow: ["/portal/", "/resident/", "/vendor/", "/admin/", "/api/", "/auth/"],
    });
    expect(body.sitemap).toBe("https://proplane.ai/sitemap.xml");
    expect(body.host).toBe("https://proplane.ai");
  });

  it("treats www.proplane.ai as indexable", async () => {
    vi.resetModules();
    vi.doMock("next/headers", () => ({
      headers: () => headersMock(),
    }));
    headersMock.mockResolvedValue(new Headers({ host: "www.proplane.ai" }));
    const robots = (await import("@/app/robots")).default;
    const body = await robots();
    expect(body.host).toBe("https://proplane.ai");
    expect(body.rules).toMatchObject({ allow: "/" });
  });
});
