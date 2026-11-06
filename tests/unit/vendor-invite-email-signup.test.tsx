// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
const getUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/browser", () => ({ createSupabaseBrowserClient: () => ({ auth: { getUser } }) }));
vi.mock("@/components/auth/vendor-google-sign-up-button", () => ({ VendorGoogleSignUpButton: () => <button>Google</button> }));
vi.mock("@/components/auth/vendor-apple-sign-up-button", () => ({ VendorAppleSignUpButton: () => <button>Apple</button> }));
vi.mock("@/components/ui/phone-number-field", () => ({ PhoneNumberField: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => <input aria-label="Phone number" value={value} onChange={(e) => onChange(e.target.value)} /> }));
import { VendorInviteEmailSignup } from "@/components/auth/vendor-invite-email-signup";
beforeEach(() => { getUser.mockResolvedValue({ data: { user: null } }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const props = { inviteToken: "invite-token", email: "vendor@example.test", initialFullName: "Vendor" };
describe("vendor invite verification", () => {
  it("starts mailbox verification with the exact invite and no password", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }); vi.stubGlobal("fetch", fetchMock);
    render(<VendorInviteEmailSignup {...props} />);
    fireEvent.click(await screen.findByText("Continue with email"));
    await screen.findByRole("heading", { name: "Check your email" });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ email: "vendor@example.test", intent: "vendor_invite", vendorInviteToken: "invite-token" });
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });
  it("does not redeem a token when a different email is signed in", async () => {
    getUser.mockResolvedValue({ data: { user: { email: "other@example.test", email_confirmed_at: "2026-01-01" } } });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }); vi.stubGlobal("fetch", fetchMock);
    render(<VendorInviteEmailSignup {...props} />);
    fireEvent.click(await screen.findByText("Continue with email"));
    await screen.findByRole("heading", { name: "Check your email" });
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/auth/email-onboarding/start");
  });
  it("redeems only a verified matching session with details and shows an explicit portal action", async () => {
    getUser.mockResolvedValue({ data: { user: { email: "vendor@example.test", email_confirmed_at: "2026-01-01" } } });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, redirectTo: "/vendor/onboarding" }) }); vi.stubGlobal("fetch", fetchMock);
    render(<VendorInviteEmailSignup {...props} />);
    fireEvent.change(await screen.findByLabelText("Phone number"), { target: { value: "+12065550123" } });
    fireEvent.click(screen.getByText("Accept invite"));
    await screen.findByText("Go to portal");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/auth/vendor-register");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ token: "invite-token", fullName: "Vendor", phone: "+12065550123" });
  });
  it("does not claim success when the account requires recovery", async () => {
    getUser.mockResolvedValue({ data: { user: { email: "vendor@example.test", email_confirmed_at: "2026-01-01" } } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ recoveryRequired: true, redirectTo: "/auth/recover-account" }) }));
    render(<VendorInviteEmailSignup {...props} />);
    fireEvent.change(await screen.findByLabelText("Phone number"), { target: { value: "+12065550123" } });
    fireEvent.click(screen.getByText("Accept invite"));
    expect(await screen.findByText("Continue recovery")).toBeTruthy();
    expect(screen.queryByText("Go to portal")).toBeNull();
  });

  it("shows a revoked or expired invite error without claiming success", async () => {
    getUser.mockResolvedValue({ data: { user: { email: "vendor@example.test", email_confirmed_at: "2026-01-01" } } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "Invite expired." }) }));
    render(<VendorInviteEmailSignup {...props} />);
    fireEvent.change(await screen.findByLabelText("Phone number"), { target: { value: "+12065550123" } });
    fireEvent.click(screen.getByText("Accept invite"));
    expect((await screen.findByRole("alert")).textContent).toBe("Invite expired.");
    expect(screen.queryByText("Go to portal")).toBeNull();
  });
});
