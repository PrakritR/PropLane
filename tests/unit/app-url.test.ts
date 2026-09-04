import { describe, expect, it, afterEach } from "vitest";
import { leadInviteAppOrigin } from "@/lib/lead-invite.server";
import { resolveAppOrigin, resolveEmailLinkBaseUrl, resolveShareableAppOrigin } from "@/lib/app-url";

describe("resolveShareableAppOrigin", () => {
  const prevCanonical = process.env.NEXT_PUBLIC_CANONICAL_APP_URL;
  const prevApp = process.env.NEXT_PUBLIC_APP_URL;

  afterEach(() => {
    process.env.NEXT_PUBLIC_CANONICAL_APP_URL = prevCanonical;
    process.env.NEXT_PUBLIC_APP_URL = prevApp;
  });

  it("prefers canonical URL over vercel deployment", () => {
    process.env.NEXT_PUBLIC_CANONICAL_APP_URL = "https://axis.example";
    process.env.NEXT_PUBLIC_APP_URL = "https://axis-2.vercel.app";
    expect(resolveShareableAppOrigin("https://axis-2.vercel.app")).toBe("https://axis.example");
  });

  it("prefers non-vercel browser origin when canonical is unset", () => {
    delete process.env.NEXT_PUBLIC_CANONICAL_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://axis-2.vercel.app";
    expect(resolveShareableAppOrigin("https://axis.example")).toBe("https://axis.example");
  });

  it("falls back to vercel env when only vercel origins are available", () => {
    delete process.env.NEXT_PUBLIC_CANONICAL_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://axis-2.vercel.app";
    expect(resolveShareableAppOrigin("https://axis-2.vercel.app")).toBe("https://axis-2.vercel.app");
  });

  it("falls back to localhost default", () => {
    delete process.env.NEXT_PUBLIC_CANONICAL_APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(resolveShareableAppOrigin()).toBe("http://localhost:3000");
  });

  it("honors localhost browser port over NEXT_PUBLIC_APP_URL (agent sandboxes)", () => {
    delete process.env.NEXT_PUBLIC_CANONICAL_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    expect(resolveShareableAppOrigin("http://localhost:3011")).toBe("http://localhost:3011");
    expect(resolveShareableAppOrigin("http://localhost:3010")).toBe("http://localhost:3010");
  });
});

describe("resolveEmailLinkBaseUrl", () => {
  const prevCanonical = process.env.NEXT_PUBLIC_CANONICAL_APP_URL;
  const prevApp = process.env.NEXT_PUBLIC_APP_URL;

  afterEach(() => {
    process.env.NEXT_PUBLIC_CANONICAL_APP_URL = prevCanonical;
    process.env.NEXT_PUBLIC_APP_URL = prevApp;
  });

  it("uses localhost APP_URL for local email testing", () => {
    delete process.env.NEXT_PUBLIC_CANONICAL_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    expect(resolveEmailLinkBaseUrl()).toBe("http://localhost:3000");
  });

  it("never returns a vercel.app host", () => {
    delete process.env.NEXT_PUBLIC_CANONICAL_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://axis-2.vercel.app";
    expect(resolveEmailLinkBaseUrl()).toBe("https://prop-lane.space");
  });

  it("never returns the legacy axis-seattle-housing.com host", () => {
    process.env.NEXT_PUBLIC_CANONICAL_APP_URL = "https://www.axis-seattle-housing.com";
    process.env.NEXT_PUBLIC_APP_URL = "https://www.axis-seattle-housing.com";
    expect(resolveEmailLinkBaseUrl()).toBe("https://prop-lane.space");
  });

  it("prefers a configured PropLane host over legacy env values", () => {
    process.env.NEXT_PUBLIC_CANONICAL_APP_URL = "https://prop-lane.space";
    process.env.NEXT_PUBLIC_APP_URL = "https://www.axis-seattle-housing.com";
    expect(resolveEmailLinkBaseUrl()).toBe("https://prop-lane.space");
  });
});

describe("leadInviteAppOrigin", () => {
  const prevCanonical = process.env.NEXT_PUBLIC_CANONICAL_APP_URL;
  const prevApp = process.env.NEXT_PUBLIC_APP_URL;

  afterEach(() => {
    process.env.NEXT_PUBLIC_CANONICAL_APP_URL = prevCanonical;
    process.env.NEXT_PUBLIC_APP_URL = prevApp;
  });

  it("uses the same canonical base as outbound emails", () => {
    delete process.env.NEXT_PUBLIC_CANONICAL_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = "https://www.axis-seattle-housing.com";
    expect(leadInviteAppOrigin("https://preview.vercel.app")).toBe("https://prop-lane.space");
  });
});

describe("resolveAppOrigin", () => {
  const prev = process.env.NEXT_PUBLIC_APP_URL;
  const prevCanonical = process.env.NEXT_PUBLIC_CANONICAL_APP_URL;

  afterEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = prev;
    process.env.NEXT_PUBLIC_CANONICAL_APP_URL = prevCanonical;
  });

  it("uses localhost request origin even when env points to production", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://axis-2.vercel.app";
    const req = new Request("http://localhost:3000/api/stripe/checkout", { method: "POST" });
    expect(resolveAppOrigin(req)).toBe("http://localhost:3000");
  });

  it("uses Host header port when dev server binds 0.0.0.0 (cursor-2 @3011)", () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    const req = new Request("http://0.0.0.0:3011/api/auth/signup", {
      method: "POST",
      headers: { host: "localhost:3011" },
    });
    expect(resolveAppOrigin(req)).toBe("http://localhost:3011");
  });

  it("uses production env URL for non-local requests", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://axis-2.vercel.app";
    const req = new Request("https://axis-2.vercel.app/api/stripe/checkout", { method: "POST" });
    expect(resolveAppOrigin(req)).toBe("https://axis-2.vercel.app");
  });

  it("uses canonical URL for non-local Stripe return URLs", () => {
    process.env.NEXT_PUBLIC_CANONICAL_APP_URL = "https://axis.example";
    process.env.NEXT_PUBLIC_APP_URL = "https://axis-2.vercel.app";
    const req = new Request("https://axis-2.vercel.app/api/stripe/checkout", { method: "POST" });
    expect(resolveAppOrigin(req)).toBe("https://axis.example");
  });

  it("falls back to request origin when env is unset", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const req = new Request("https://custom.example/api/stripe/checkout", { method: "POST" });
    expect(resolveAppOrigin(req)).toBe("https://custom.example");
  });
});
