// @vitest-environment jsdom
// /auth/create-account?role=resident leads with "Mobile number -> Text me a code -> Code", then Google, then email.
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const params = vi.hoisted(() => ({ value: new URLSearchParams("role=resident") }));
vi.mock("next/navigation", () => ({ useSearchParams: () => params.value, useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/components/auth/phone-auth-form", () => ({
  PhoneAuthForm: (props: { signupIntent?: string }) => <div data-testid="phone-form" data-intent={props.signupIntent} />,
}));
vi.mock("@/components/auth/oauth-social-stack", () => ({ OAuthSocialStack: () => <div data-testid="oauth" /> }));
vi.mock("@/lib/supabase/browser", () => ({ createSupabaseBrowserClient: () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }));

import { PortalAuthForm } from "@/components/auth/portal-auth-form";

afterEach(cleanup);

describe("resident create-account", () => {
  it("phone first, then Google, then email, when phone sign-in is on", async () => {
    render(<PortalAuthForm phoneSignup />);
    const phone = await screen.findByTestId("phone-form");
    const oauth = screen.getByTestId("oauth");
    const email = screen.getByLabelText("Email");
    expect(phone.getAttribute("data-intent")).toBe("resident_signup");
    expect(phone.compareDocumentPosition(oauth) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(oauth.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is the unchanged Google + email form when phone sign-in is off", async () => {
    render(<PortalAuthForm phoneSignup={false} />);
    await screen.findByLabelText("Email");
    expect(screen.queryByTestId("phone-form")).toBeNull();
  });

  it("only the resident role gets the phone option", async () => {
    params.value = new URLSearchParams("role=generic");
    render(<PortalAuthForm phoneSignup />);
    await screen.findByLabelText("Email");
    expect(screen.queryByTestId("phone-form")).toBeNull();
    params.value = new URLSearchParams("role=resident");
  });

  it("the page reads the switch on the server and the form adds no new auth primitive", () => {
    const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
    expect(read("src/app/auth/create-account/page.tsx")).toContain("readPhoneSignInPreference");
    const form = read("src/components/auth/portal-auth-form.tsx");
    expect(form).toContain('signupIntent="resident_signup"');
    expect(form).not.toContain("new-password");
    expect(form).not.toContain("fetch(");
  });
});
