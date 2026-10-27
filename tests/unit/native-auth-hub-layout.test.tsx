// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-is-native-app", () => ({ useIsNativeApp: () => ({ isNative: false, platform: null }) }));
vi.mock("@/lib/native/detect-native", () => ({ detectNativePlatformSync: () => null }));
vi.mock("@/lib/native/open-url", () => ({ isNativeOAuthInProgress: () => false }));
vi.mock("@/lib/supabase/browser", () => ({ createSupabaseBrowserClient: () => ({ auth: { setSession: vi.fn(), getSession: vi.fn() } }) }));
vi.mock("@/lib/auth/recover-implicit-auth-hash", () => ({ recoverImplicitAuthHash: vi.fn().mockResolvedValue({ recovered: false }) }));

import { NativeAuthHub } from "@/components/auth/native-auth-hub";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { PHONE_AUTH_COPY } from "@/lib/auth/phone-auth-errors";

const hub = (phoneFirst: boolean) => render(<AppUiProvider><NativeAuthHub phoneFirst={phoneFirst} /></AppUiProvider>);
const fetchMock = vi.fn();

beforeEach(() => {
  window.localStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("sign-in layout: phone first, email on request", () => {
  it("phone on: phone box, then Apple and Google, then Use email instead; the email form starts closed", async () => {
    hub(true);
    expect(await screen.findByLabelText("Phone number")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Text me a code" })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Email")).not.toBeInTheDocument();
    const useEmail = screen.getByRole("button", { name: "Use email instead" });
    const phone = screen.getByLabelText("Phone number");
    const apple = screen.getByRole("button", { name: /Apple/ });
    expect(phone.compareDocumentPosition(apple) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(apple.compareDocumentPosition(useEmail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(useEmail);
    expect(await screen.findByPlaceholderText("Email")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Password")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use email instead" })).not.toBeInTheDocument();
  });

  it("phone on, but this device last signed in by email: the email form starts open", async () => {
    window.localStorage.setItem("axis:last-login-method", "email");
    hub(true);
    expect(await screen.findByPlaceholderText("Email")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use email instead" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Phone number")).toBeInTheDocument();
  });

  it("an old device that only ever remembered an email also starts open", async () => {
    window.localStorage.setItem("axis:remembered-login-email", "a@b.test");
    hub(true);
    expect(await screen.findByPlaceholderText("Email")).toHaveValue("a@b.test");
  });

  it("phone off at load: no phone box, no off message, the email form is open", async () => {
    hub(false);
    expect(await screen.findByPlaceholderText("Email")).toBeInTheDocument();
    expect(screen.queryByLabelText("Phone number")).not.toBeInTheDocument();
    expect(screen.queryByText(PHONE_AUTH_COPY.off)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use email instead" })).not.toBeInTheDocument();
  });

  it("the switch flipped off between load and Continue: the phone box is replaced by the off sentence and email opens", async () => {
    hub(true);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: PHONE_AUTH_COPY.off, kind: "off", phoneOff: true }), { status: 409 }));
    fireEvent.change(await screen.findByLabelText("Phone number"), { target: { value: "5103098345" } });
    fireEvent.click(screen.getByRole("button", { name: "Text me a code" }));
    await waitFor(() => expect(screen.queryByLabelText("Phone number")).not.toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("Phone sign-in isn't available right now. Use Apple, Google or email.");
    expect(screen.getByPlaceholderText("Email")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Apple/ })).toBeInTheDocument();
  });
});
