// @vitest-environment jsdom
//
// EVIDENCE HARNESS — the end-user surface behind the phone fix: the sign-in screen's three states, rendered for a
// reviewer screenshot. The fetch answers are the EXACT bodies `POST /api/auth/phone/verify` returns in
// `tests/unit/evidence-admin-phone-code-sign-in.test.ts` (same route, real verifyPhoneChallenge):
//   1. the number step, 2. the code step, 3. the refused state (what production showed for every number before the
//   schema fix, and now only for an unreadable account), 4. the admin's accepted code landing on /admin.
// Set EVIDENCE_DIR to write each surface's HTML next to the generated app.css.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PhoneAuthForm } from "@/components/auth/phone-auth-form";
import { PHONE_AUTH_COPY } from "@/lib/auth/phone-auth-errors";
import { writeEvidenceSurface } from "../helpers/evidence-dom";

const { setSession } = vi.hoisted(() => ({ setSession: vi.fn() }));
vi.mock("@/lib/supabase/browser", () => ({ createSupabaseBrowserClient: () => ({ auth: { setSession } }) }));

const fetchMock = vi.fn();
const navigate = vi.fn();
let originalLocation: Location;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  fetchMock.mockReset();
  setSession.mockReset().mockResolvedValue({ error: null });
  navigate.mockReset();
  window.localStorage.clear();
  vi.stubGlobal("fetch", fetchMock);
  originalLocation = window.location;
  Object.defineProperty(window, "location", { configurable: true, value: { ...originalLocation, replace: navigate } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
});

async function reachCodeStep() {
  fetchMock.mockResolvedValueOnce(response({ challengeId: "11111111-1111-4111-8111-111111111111" }));
  fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "2065550100" } });
  fireEvent.click(screen.getByRole("button", { name: "Text me a code" }));
  return (await screen.findByLabelText("Verification code")) as HTMLInputElement;
}

describe("phone sign-in screen, end to end", () => {
  it("number step → code step → the code is accepted and an admin lands on /admin", async () => {
    render(<PhoneAuthForm />);
    fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "2065550100" } });
    expect((screen.getByLabelText("Phone number") as HTMLInputElement).value).toBe("(206) 555-0100");
    writeEvidenceSurface("phone-sign-in-1-number", "1. Sign in by phone number — the number step (+1 is fixed)");

    fetchMock.mockResolvedValueOnce(response({ challengeId: "11111111-1111-4111-8111-111111111111" }));
    fireEvent.click(screen.getByRole("button", { name: "Text me a code" }));
    const code = (await screen.findByLabelText("Verification code")) as HTMLInputElement;
    expect(screen.getByText("Code sent to (206) 555-0100")).toBeInTheDocument();
    writeEvidenceSurface("phone-sign-in-2-code", "2. The texted code — PropLane sent it to (206) 555-0100");

    // The admin's accepted code: the body is what the real route returned in the HTTP transcript.
    fetchMock.mockResolvedValueOnce(response({ ok: true, next: "/admin" }));
    fireEvent.change(code, { target: { value: "482913" } });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/admin"));
    expect(setSession).not.toHaveBeenCalled(); // the session arrived as cookies from the route, not in the body
    writeEvidenceSurface("phone-sign-in-3-accepted", "3. Code accepted — this admin's session opens at /admin (captain, Oct 26)");
    expect(window.localStorage.getItem("axis:last-login-method")).toBe("phone");
  });

  it("the refused state: exactly what production showed before the schema fix", async () => {
    render(<PhoneAuthForm />);
    const code = await reachCodeStep();
    fetchMock.mockResolvedValueOnce(response({ error: PHONE_AUTH_COPY.generic, kind: "generic" }, 400));
    fireEvent.change(code, { target: { value: "482913" } });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(PHONE_AUTH_COPY.generic);
    expect(navigate).not.toHaveBeenCalled();
    writeEvidenceSurface(
      "phone-sign-in-4-refused",
      "4. The refusal production showed for every number (profiles.phone was numeric → phone_auth_bind 42804); after the fix only an unreadable account sees it",
    );
  });
});
