// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const getUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/browser", () => ({ createSupabaseBrowserClient: () => ({ auth: { getUser } }) }));
vi.mock("@/components/auth/oauth-social-stack", () => ({ OAuthSocialStack: () => <div>Social sign in</div> }));
vi.mock("@/components/auth/auth-mobile-primitives", () => ({ AuthLegalConsent: () => null }));
vi.mock("@/components/ui/phone-number-field", () => ({ PhoneNumberField: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => <input aria-label="Phone number" value={value} onChange={(e) => onChange(e.target.value)} /> }));
import { EmailFirstSignup } from "@/components/auth/email-first-signup";
beforeEach(() => { getUser.mockResolvedValue({ data: { user: null } }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("email-first signup", () => {
  it("starts with email only and shows check email without collecting a password", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }); vi.stubGlobal("fetch", fetchMock);
    render(<EmailFirstSignup intent="resident" />);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "a@example.test" } });
    expect(document.querySelector('input[type="password"]')).toBeNull();
    fireEvent.click(screen.getByText("Continue with email"));
    await screen.findByText("Check your email for a link to continue.");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ email: "a@example.test", intent: "resident" });
  });
  it("asks verified managers for details and retains an explicit portal action", async () => {
    getUser.mockResolvedValue({ data: { user: { email: "a@example.test", email_confirmed_at: "2026-01-01" } } });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, redirectTo: "/portal" }) }); vi.stubGlobal("fetch", fetchMock);
    render(<EmailFirstSignup intent="manager" tier="pro" />);
    fireEvent.change(await screen.findByLabelText("Full name"), { target: { value: "Alex" } });
    fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "+12065550123" } });
    fireEvent.click(screen.getByText("Complete account"));
    await screen.findByText("Go to portal");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/auth/manager-register");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ email: "a@example.test", fullName: "Alex", phone: "+12065550123", tier: "pro" });
  });
  it.each([
    { intent: "manager" as const, tier: "business", billing: "annual" as const, expected: { email: "a@example.test", intent: "manager", tier: "business", billing: "annual" } },
    { intent: "resident" as const, listing: { propertyId: "home", listingRoomId: "room", bundleId: "bundle", applicationFormId: "form", rentalType: "short_term" }, expected: { email: "a@example.test", intent: "resident", propertyId: "home", listingRoomId: "room", bundleId: "bundle", applicationFormId: "form", rentalType: "short_term" } },
    { intent: "tour" as const, tourInquiryId: "tour-1", expected: { email: "a@example.test", intent: "tour", tourInquiryId: "tour-1" } },
    { intent: "manager_paid" as const, checkoutSessionId: "cs_1", expected: { email: "a@example.test", intent: "manager_paid", checkoutSessionId: "cs_1" } },
  ])("preserves bounded $intent context in the verification request", async ({ expected, ...props }) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }); vi.stubGlobal("fetch", fetchMock);
    render(<EmailFirstSignup {...props} />);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "a@example.test" } });
    fireEvent.click(screen.getByText("Continue with email"));
    await screen.findByText("Check your email for a link to continue.");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual(expected);
  });

  it("collects paid manager details only after verification", async () => {
    getUser.mockResolvedValue({ data: { user: { email: "a@example.test", email_confirmed_at: "2026-01-01" } } });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }); vi.stubGlobal("fetch", fetchMock);
    render(<EmailFirstSignup intent="manager_paid" checkoutSessionId="cs_1" />);
    fireEvent.change(await screen.findByLabelText("Full name"), { target: { value: "Alex" } });
    fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "+12065550123" } });
    fireEvent.click(screen.getByText("Complete account"));
    await screen.findByText("Go to portal");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ sessionId: "cs_1", fullName: "Alex", phone: "+12065550123" });
  });

  it("shows a start error without claiming a link was sent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "Try again later." }) }));
    render(<EmailFirstSignup intent="vendor" />);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "a@example.test" } });
    fireEvent.click(screen.getByText("Continue with email"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Try again later."));
    expect(screen.queryByText("Check your email for a link to continue.")).toBeNull();
  });
});
