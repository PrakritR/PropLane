// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const link = vi.hoisted(() => ({ linkIdentity: vi.fn(async () => ({ error: null })) }));
vi.mock("@/lib/supabase/browser", () => ({ createSupabaseBrowserClient: () => ({ auth: { linkIdentity: link.linkIdentity } }) }));
vi.mock("@/lib/auth/oauth-next-cookie", () => ({ persistOAuthSignInContext: vi.fn() }));
vi.mock("@/lib/auth/password-reset-url", () => ({ resolveOAuthBrowserOrigin: () => "https://proplane.test" }));
vi.mock("@/lib/auth/native-oauth-callback", () => ({ resolveOAuthCallbackRedirectUrl: (o: string) => `${o}/auth/callback` }));

import { PersonalAccountForm } from "@/components/public/personal-account-form";

let bodies: Record<string, unknown>[];
beforeEach(() => {
  bodies = [];
  link.linkIdentity.mockClear();
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ ok: true, signedIn: true, nextPath: "/resident/communication", propertyPath: "/resident/applications/apply?propertyId=p1" }), { status: 200 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const prefill = { houseLabel: "5259 Brooklyn", maskedPhone: "•••• 0142" };
const q = (a: string) => document.querySelector(`[data-attr="${a}"]`) as HTMLElement;

describe("the personal account form", () => {
  it("asks for name, email and a password; Create account needs a name and an 8+ character password", () => {
    render(<PersonalAccountForm token="t" prefill={prefill} />);
    expect(q("personal-account-password").getAttribute("type")).toBe("password");
    const finish = q("personal-account-finish") as HTMLButtonElement;
    fireEvent.change(q("personal-account-name"), { target: { value: "Maya Chen" } });
    fireEvent.change(q("personal-account-password"), { target: { value: "short" } });
    expect(finish.disabled).toBe(true);
    fireEvent.change(q("personal-account-password"), { target: { value: "correct horse" } });
    expect(finish.disabled).toBe(false);
  });

  it("finishes into the ready screen: the conversation and the asked-about home", async () => {
    render(<PersonalAccountForm token="t" prefill={prefill} />);
    fireEvent.change(q("personal-account-name"), { target: { value: "Maya Chen" } });
    fireEvent.change(q("personal-account-password"), { target: { value: "correct horse" } });
    fireEvent.click(q("personal-account-finish"));
    await waitFor(() => expect(q("personal-account-open-conversation")).not.toBeNull());
    expect(bodies[0]).toMatchObject({ fullName: "Maya Chen", password: "correct horse" });
    expect(q("personal-account-open-conversation").getAttribute("href")).toBe("/resident/communication");
    expect(q("personal-account-open-property").getAttribute("href")).toContain("propertyId=p1");
  });

  it("Continue with Google makes the phone-proven account first, then links Google to it (no password sent)", async () => {
    render(<PersonalAccountForm token="t" prefill={prefill} />);
    fireEvent.change(q("personal-account-name"), { target: { value: "Maya Chen" } });
    fireEvent.click(q("personal-account-google"));
    await waitFor(() => expect(link.linkIdentity).toHaveBeenCalledTimes(1));
    expect(bodies[0]).toMatchObject({ provider: "google" });
    expect(bodies[0]).not.toHaveProperty("password");
    expect(link.linkIdentity).toHaveBeenCalledWith({ provider: "google", options: { redirectTo: "https://proplane.test/auth/callback" } });
  });

  it("when Google cannot be linked the account is still ready", async () => {
    link.linkIdentity.mockResolvedValueOnce({ error: { message: "manual linking disabled" } } as never);
    render(<PersonalAccountForm token="t" prefill={prefill} />);
    fireEvent.change(q("personal-account-name"), { target: { value: "Maya Chen" } });
    fireEvent.click(q("personal-account-google"));
    await waitFor(() => expect(q("personal-account-done")).not.toBeNull());
  });
});
