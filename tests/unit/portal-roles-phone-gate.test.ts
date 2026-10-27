import { beforeEach, describe, expect, it, vi } from "vitest";
import { redirect } from "next/navigation";

const getPortalAccessContext = vi.fn();
vi.mock("@/lib/auth/portal-access", () => ({
  getPortalAccessContext: (...args: unknown[]) => getPortalAccessContext(...args),
  reachablePortalRoles: () => [],
}));

import { GET } from "@/app/api/auth/portal-roles/route";
import { phoneGateRedirectTo } from "@/lib/auth/phone-gate-redirect";

/** The chooser printed "NEXT_REDIRECT" because the phone gate's redirect() was caught and returned as a 500 message. */
describe("portal-roles under the phone gate", () => {
  beforeEach(() => {
    getPortalAccessContext.mockReset();
  });

  it("answers 403 with redirectTo when the phone gate redirects, never NEXT_REDIRECT", async () => {
    getPortalAccessContext.mockImplementation(async () => redirect("/auth/verify-phone"));
    const res = await GET();
    const text = await res.text();
    expect(res.status).toBe(403);
    expect(text).not.toContain("NEXT_REDIRECT");
    expect(JSON.parse(text)).toEqual({ error: "Verify your phone to continue.", redirectTo: "/auth/verify-phone" });
  });

  it("drops an off-site redirect target without ever printing NEXT_REDIRECT", async () => {
    getPortalAccessContext.mockImplementation(async () => redirect("https://evil.example/x"));
    const res = await GET();
    const text = await res.text();
    expect(res.status).toBe(403);
    expect(text).not.toContain("NEXT_REDIRECT");
    expect(text).not.toContain("evil.example");
    expect(JSON.parse(text)).toEqual({ error: "Verify your phone to continue." });
  });

  it("keeps a normal error as a 500 with its message", async () => {
    getPortalAccessContext.mockRejectedValue(new Error("db down"));
    const res = await GET();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "db down" });
  });

  it("the client only follows a same-origin relative redirectTo", () => {
    expect(phoneGateRedirectTo({ redirectTo: "/auth/verify-phone?next=%2Fresident" })).toBe("/auth/verify-phone?next=%2Fresident");
    expect(phoneGateRedirectTo({ redirectTo: "//evil.example" })).toBeNull();
    expect(phoneGateRedirectTo({ redirectTo: "https://evil.example" })).toBeNull();
    expect(phoneGateRedirectTo({ error: "x" })).toBeNull();
    expect(phoneGateRedirectTo(null)).toBeNull();
  });

  it("carries the page the client was heading to onto the bare gate", () => {
    expect(phoneGateRedirectTo({ redirectTo: "/auth/verify-phone" }, "/resident/stays/request")).toBe(
      "/auth/verify-phone?next=%2Fresident%2Fstays%2Frequest",
    );
    // An auth screen, an API path and an off-site next are never carried.
    expect(phoneGateRedirectTo({ redirectTo: "/auth/verify-phone" }, "/auth/choose-portal")).toBe("/auth/verify-phone");
    expect(phoneGateRedirectTo({ redirectTo: "/auth/verify-phone" }, "/api/auth/portal-roles")).toBe("/auth/verify-phone");
    expect(phoneGateRedirectTo({ redirectTo: "/auth/verify-phone" }, "//evil.example")).toBe("/auth/verify-phone");
    expect(phoneGateRedirectTo({ redirectTo: "/auth/verify-phone" }, "")).toBe("/auth/verify-phone");
    // A gate href that already carries a destination is left alone.
    expect(phoneGateRedirectTo({ redirectTo: "/auth/verify-phone?next=%2Fresident" }, "/portal/dashboard")).toBe(
      "/auth/verify-phone?next=%2Fresident",
    );
  });
});
