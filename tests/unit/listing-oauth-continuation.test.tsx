// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { NextRequest } from "next/server";
import { oauthContinuePath } from "@/lib/auth/oauth-redirect";
import { OAUTH_NEXT_COOKIE, persistOAuthNextPath, readOAuthNextPathFromRequest } from "@/lib/auth/oauth-next-cookie";

const state = vi.hoisted(() => ({ search: "", signup: vi.fn() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(state.search), useRouter: () => ({}) }));
vi.mock("@/components/auth/email-first-signup", () => ({ EmailFirstSignup: (props: unknown) => { state.signup(props); return null; } }));
import { PortalAuthForm } from "@/components/auth/portal-auth-form";
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("listing OAuth continuation", () => {
  it("passes the listing path and keeps its context through the callback cookie", () => {
    const path = "/resident/applications/apply?propertyId=home&listingRoomId=room&bundle=bundle&form=form&rentalType=short_term";
    state.search = `role=resident&next=${encodeURIComponent(path)}`;
    render(<PortalAuthForm />);
    expect(state.signup).toHaveBeenCalledWith(expect.objectContaining({ oauthNextPath: path, listing: { propertyId: "home", listingRoomId: "room", bundleId: "bundle", applicationFormId: "form", rentalType: "short_term" } }));
    const continuation = oauthContinuePath(path);
    persistOAuthNextPath(continuation);
    const cookie = document.cookie.split("; ").find((part) => part.startsWith(`${OAUTH_NEXT_COOKIE}=`));
    const request = new NextRequest("http://localhost/auth/callback", { headers: { cookie: cookie ?? "" } });
    expect(readOAuthNextPathFromRequest(request)).toBe(continuation);
    expect(new URL(continuation, "https://example.test").searchParams.get("next")).toBe(path);
  });
  it.each(["https://evil.example/resident/applications/apply?propertyId=home", "//evil.example/resident/applications/apply?propertyId=home", "/\\evil.example/resident/applications/apply?propertyId=home", "/resident/applications/apply?form=x"]) ("rejects unsafe or incomplete destination %s", (path) => {
    state.search = `role=resident&next=${encodeURIComponent(path)}`;
    render(<PortalAuthForm />);
    expect(state.signup).toHaveBeenCalledWith(expect.objectContaining({ oauthNextPath: undefined, listing: undefined }));
  });
});
