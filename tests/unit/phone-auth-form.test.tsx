// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhoneAuthForm } from "@/components/auth/phone-auth-form";

const { setSession } = vi.hoisted(() => ({ setSession: vi.fn() }));
vi.mock("@/lib/supabase/browser", () => ({ createSupabaseBrowserClient: () => ({ auth: { setSession } }) }));
vi.mock("@/lib/analytics/track-client", () => ({ track: vi.fn() }));

const fetchMock = vi.fn();
const navigate = vi.fn();
let originalLocation: Location;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const submit = () => fireEvent.submit(screen.getByRole("form", { name: "Phone verification" }));

beforeEach(() => {
  fetchMock.mockReset();
  setSession.mockReset().mockResolvedValue({ error: null });
  navigate.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  originalLocation = window.location;
  Object.defineProperty(window, "location", { configurable: true, value: { ...originalLocation, replace: navigate } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
});

describe("phone authentication form", () => {
  it("coalesces repeated submissions while a code is being sent", async () => {
    let resolve!: (value: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((done) => { resolve = done; }));
    render(<PhoneAuthForm />);
    fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "+14255550123" } });
    submit();
    submit();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Text me a code" })).toBeDisabled();
    resolve(response({ challengeId: "only-one" }));
    expect(await screen.findByLabelText("Verification code")).toBeEnabled();
  });

  it("prefills the number typed at signup (unverified) on the verify screen, and lands on the carried destination", async () => {
    fetchMock.mockResolvedValueOnce(response({ enabled: true, verified: false, needsOldNumber: false, phone: "+12065550177" }));
    render(<PhoneAuthForm mode="verify_phone" nextPath="/resident/stays/request?listing=h1&room=r1" />);
    await waitFor(() => expect((screen.getByLabelText("Phone number") as HTMLInputElement).value).toBe("+12065550177"));
    // Still sends a code: the prefill proves nothing.
    expect(screen.getByRole("button", { name: "Send code" })).toBeEnabled();
  });

  it("offers a status retry without allowing a verification request before the status succeeds", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(response({ enabled: true, verified: false, needsOldNumber: false, phone: null }));
    render(<PhoneAuthForm mode="verify_phone" />);
    const retry = await screen.findByRole("button", { name: "Try again" });
    submit();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole("button", { name: "Send code" })).toBeEnabled());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("submits phone and one-time code directly from the DOM, installs the session, and preserves the destination", async () => {
    const session = { access_token: "access", refresh_token: "refresh" };
    fetchMock.mockResolvedValueOnce(response({ challengeId: "challenge" })).mockResolvedValueOnce(response({ ok: true, session }));
    render(<PhoneAuthForm nextPath="/resident/communication" />);
    (screen.getByLabelText("Phone number") as HTMLInputElement).value = "+14255550123";
    submit();
    const code = await screen.findByLabelText("Verification code");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ phone: "+14255550123", purpose: "sign_in" });
    (code as HTMLInputElement).value = "123456";
    submit();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/auth/continue?next=%2Fresident%2Fcommunication"));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ challengeId: "challenge", code: "123456", purpose: "sign_in", next: "/resident/communication" });
    expect(setSession).toHaveBeenCalledWith(session);
  });

  it("requires the old code before collecting the new number", async () => {
    fetchMock.mockResolvedValueOnce(response({ enabled: true, verified: true, needsOldNumber: true, phone: "+14255550123" }))
      .mockResolvedValueOnce(response({ challengeId: "old" }))
      .mockResolvedValueOnce(response({ ok: true, oldNumberVerified: true }))
      .mockResolvedValueOnce(response({ challengeId: "new" }))
      .mockResolvedValueOnce(response({ ok: true }));
    render(<PhoneAuthForm mode="verify_phone" />);
    await waitFor(() => expect(screen.getByLabelText("Current phone number")).toHaveValue("+14255550123"));
    expect(screen.queryByLabelText("New phone number")).not.toBeInTheDocument();
    submit();
    fireEvent.change(await screen.findByLabelText("Verification code"), { target: { value: "123456" } });
    submit();
    const newNumber = await screen.findByLabelText("New phone number");
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.change(newNumber, { target: { value: "+14255550456" } });
    submit();
    fireEvent.change(await screen.findByLabelText("Verification code"), { target: { value: "654321" } });
    submit();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/auth/continue"));
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ phone: "+14255550123", purpose: "change_number_old" });
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({ phone: "+14255550456", purpose: "change_number_new" });
  });

  it("does not advance the number-change flow without server proof of the old code", async () => {
    fetchMock.mockResolvedValueOnce(response({ enabled: true, verified: true, needsOldNumber: true, phone: "+14255550123" }))
      .mockResolvedValueOnce(response({ challengeId: "old" })).mockResolvedValueOnce(response({ ok: true }));
    render(<PhoneAuthForm mode="verify_phone" />);
    await waitFor(() => expect(screen.getByLabelText("Current phone number")).toHaveValue("+14255550123"));
    submit();
    fireEvent.change(await screen.findByLabelText("Verification code"), { target: { value: "123456" } });
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not verify your phone");
    expect(screen.queryByLabelText("New phone number")).not.toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps a missing-phone account in verification after a neutral taken-phone refusal", async () => {
    fetchMock.mockResolvedValueOnce(response({ enabled: true, verified: false, needsOldNumber: false, phone: null }))
      .mockResolvedValueOnce(response({ challengeId: "attach" }))
      .mockResolvedValueOnce(response({ error: "Could not verify your phone. Please try again." }, 400));
    render(<PhoneAuthForm mode="verify_phone" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Send code" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "+14255550123" } });
    submit();
    fireEvent.change(await screen.findByLabelText("Verification code"), { target: { value: "123456" } });
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not verify your phone");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).purpose).toBe("verify_phone");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("refuses malformed codes locally, holds Resend for 30 seconds, then clears a stale code on resend", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], shouldAdvanceTime: true });
    try {
      fetchMock.mockResolvedValueOnce(response({ challengeId: "first" })).mockResolvedValueOnce(response({ challengeId: "second" }));
      render(<PhoneAuthForm />);
      fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "+14255550123" } });
      submit();
      fireEvent.change(await screen.findByLabelText("Verification code"), { target: { value: "abc" } });
      submit();
      expect(await screen.findByRole("alert")).toHaveTextContent("Enter the 6-digit code");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: /Resend in 0:\d\d/ })).toBeDisabled();
      await act(async () => { vi.advanceTimersByTime(31_000); });
      fireEvent.click(await screen.findByRole("button", { name: "Resend code" }));
      await waitFor(() => expect(screen.getByLabelText("Verification code")).toHaveValue(""));
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the form available after a transport failure and rejects unsafe redirect destinations", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Connection interrupted"))
      .mockResolvedValueOnce(response({ challengeId: "retry" })).mockResolvedValueOnce(response({ ok: true, next: "//evil.invalid" }));
    render(<PhoneAuthForm />);
    fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "+14255550123" } });
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection interrupted");
    submit();
    fireEvent.change(await screen.findByLabelText("Verification code"), { target: { value: "123456" } });
    submit();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/auth/continue"));
  });

  it("does not enter a portal when setting the returned native session fails", async () => {
    fetchMock.mockResolvedValueOnce(response({ challengeId: "challenge" }))
      .mockResolvedValueOnce(response({ ok: true, session: { access_token: "a", refresh_token: "b" } }));
    setSession.mockResolvedValue({ error: new Error("failed") });
    render(<PhoneAuthForm />);
    fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "+14255550123" } });
    submit();
    fireEvent.change(await screen.findByLabelText("Verification code"), { target: { value: "123456" } });
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not verify your phone");
    expect(navigate).not.toHaveBeenCalled();
  });
});
