// @vitest-environment jsdom
//
// EVIDENCE HARNESS — phone sign-in (studio plan phone-signin-1026), rendered for a reviewer screenshot:
// the sign-in door with the phone box first (Apple / Google under it, email behind a link), the +1 number
// field as it formats what is typed, the six-box code step, and the same door when the switch is off.
// Set EVIDENCE_DIR to write each surface's HTML next to the generated app.css.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { writeEvidenceSurface } from "../helpers/evidence-dom";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-is-native-app", () => ({ useIsNativeApp: () => ({ isNative: false, platform: null }) }));
vi.mock("@/lib/native/detect-native", () => ({ detectNativePlatformSync: () => null }));
vi.mock("@/lib/native/open-url", () => ({ isNativeOAuthInProgress: () => false }));
vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => ({ auth: { setSession: vi.fn(), getSession: vi.fn() } }),
}));
vi.mock("@/lib/auth/recover-implicit-auth-hash", () => ({ recoverImplicitAuthHash: vi.fn().mockResolvedValue({ recovered: false }) }));

import { NativeAuthHub } from "@/components/auth/native-auth-hub";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { PHONE_AUTH_COPY } from "@/lib/auth/phone-auth-errors";

const fetchMock = vi.fn();
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  window.localStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const hub = (phoneFirst = true) => render(<AppUiProvider><NativeAuthHub phoneFirst={phoneFirst} /></AppUiProvider>);

describe("evidence: the sign-in door", () => {
  it("phone first: the +1 box formats as you type, Apple and Google under it, email behind a link", async () => {
    hub();
    const field = (await screen.findByLabelText("Phone number")) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "5103098345" } });
    expect(field.value).toBe("(510) 309-8345");
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use email instead" })).toBeTruthy();
    expect(screen.queryByPlaceholderText("Email")).toBeNull();
    writeEvidenceSurface(
      "20-signin-phone-first",
      "Sign in: the phone box first with a fixed +1 and (510) 309-8345 formatted as typed, Apple and Google under it, email behind Use email instead.",
    );
  });

  it("the code step is six boxes, and says which number the code went to", async () => {
    hub();
    fetchMock.mockResolvedValueOnce(response({ challengeId: "challenge-1" }));
    fireEvent.change(await screen.findByLabelText("Phone number"), { target: { value: "5103098345" } });
    fireEvent.click(screen.getByRole("button", { name: "Text me a code" }));
    const code = (await screen.findByLabelText("Verification code")) as HTMLInputElement;
    expect(screen.getByText("Code sent to (510) 309-8345")).toBeTruthy();
    fireEvent.change(code, { target: { value: "4829" } });
    const boxes = Array.from(document.querySelector('[data-testid="phone-code-boxes"]')!.querySelectorAll("span"));
    expect(boxes.map((b) => b.textContent)).toEqual(["4", "8", "2", "9", "", ""]);
    writeEvidenceSurface(
      "21-signin-code-six-boxes",
      "Sign in, code step: six boxes filling as the code is typed, 'Code sent to (510) 309-8345', with resend and a way back to the number.",
    );
  });

  it("email on request: the same door with the email form opened", async () => {
    hub();
    fireEvent.click(await screen.findByRole("button", { name: "Use email instead" }));
    expect(await screen.findByPlaceholderText("Email")).toBeTruthy();
    writeEvidenceSurface("22-signin-email-opened", "The same door after Use email instead: email and password open, the phone box still above it.");
  });

  it("the switch flipped off: the phone box is replaced by one plain sentence and email opens", async () => {
    hub();
    fetchMock.mockResolvedValueOnce(response({ error: PHONE_AUTH_COPY.off, kind: "off", phoneOff: true }, 409));
    fireEvent.change(await screen.findByLabelText("Phone number"), { target: { value: "5103098345" } });
    fireEvent.click(screen.getByRole("button", { name: "Text me a code" }));
    await waitFor(() => expect(screen.queryByLabelText("Phone number")).toBeNull());
    expect(screen.getByRole("alert").textContent).toContain("Phone sign-in isn't available right now.");
    writeEvidenceSurface("23-signin-phone-off", "Phone sign-in turned off between load and Continue: the box is gone, one sentence says so, Apple / Google / email still work.");
  });
});
