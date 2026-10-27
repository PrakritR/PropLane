// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhoneAuthForm } from "@/components/auth/phone-auth-form";
import { PHONE_AUTH_COPY } from "@/lib/auth/phone-auth-errors";

const { setSession } = vi.hoisted(() => ({ setSession: vi.fn() }));
vi.mock("@/lib/supabase/browser", () => ({ createSupabaseBrowserClient: () => ({ auth: { setSession } }) }));

const fetchMock = vi.fn();
const navigate = vi.fn();
let originalLocation: Location;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const verifyCalls = () => fetchMock.mock.calls.filter(([path]) => path === "/api/auth/phone/verify");
const startCalls = () => fetchMock.mock.calls.filter(([path]) => path === "/api/auth/phone/start");

async function reachCodeStep(number = "5103098345") {
  fetchMock.mockResolvedValueOnce(response({ challengeId: "challenge-1" }));
  fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: number } });
  fireEvent.click(screen.getByRole("button", { name: "Text me a code" }));
  return (await screen.findByLabelText("Verification code")) as HTMLInputElement;
}

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
});

describe("phone sign-in number field", () => {
  it("shows a fixed +1 and formats as you type", () => {
    render(<PhoneAuthForm />);
    const field = screen.getByLabelText("Phone number") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "5103" } });
    expect(field.value).toBe("(510) 3");
    fireEvent.change(field, { target: { value: "5103098345" } });
    expect(field.value).toBe("(510) 309-8345");
    expect(screen.getByText("+1")).toBeInTheDocument();
  });

  it.each(["+1 510-309-8345", "15103098345", "(510) 309 8345"])("accepts a paste of %j and sends +15103098345", async (pasted) => {
    render(<PhoneAuthForm />);
    await reachCodeStep(pasted);
    expect(JSON.parse(startCalls()[0][1].body)).toEqual({ phone: "+15103098345", purpose: "sign_in" });
    expect(screen.getByText("Code sent to (510) 309-8345")).toBeInTheDocument();
  });

  it("fills in the last number used on this device, and remembers the new one only after a successful sign-in", async () => {
    window.localStorage.setItem("axis:remembered-login-phone", "(425) 555-0123");
    render(<PhoneAuthForm />);
    await waitFor(() => expect((screen.getByLabelText("Phone number") as HTMLInputElement).value).toBe("(425) 555-0123"));
    fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "5103098345" } });
    const code = await reachCodeStep("5103098345");
    expect(window.localStorage.getItem("axis:remembered-login-phone")).toBe("(425) 555-0123");
    fetchMock.mockResolvedValueOnce(response({ ok: true, next: "/portal/dashboard" }));
    fireEvent.change(code, { target: { value: "482913" } });
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(window.localStorage.getItem("axis:remembered-login-phone")).toBe("(510) 309-8345");
    expect(window.localStorage.getItem("axis:last-login-method")).toBe("phone");
  });

  it("works with storage blocked", async () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage")!;
    Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
    try {
      render(<PhoneAuthForm />);
      const code = await reachCodeStep();
      fetchMock.mockResolvedValueOnce(response({ ok: true, next: "/portal/dashboard" }));
      fireEvent.change(code, { target: { value: "482913" } });
      await waitFor(() => expect(navigate).toHaveBeenCalledWith("/portal/dashboard"));
    } finally {
      Object.defineProperty(window, "localStorage", original);
    }
  });

  it("forwards a short or non-US number as typed and shows the server's plain sentence for it", async () => {
    render(<PhoneAuthForm />);
    fetchMock.mockResolvedValueOnce(response({ error: PHONE_AUTH_COPY.bad_number, kind: "bad_number" }, 400));
    fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "510" } });
    fireEvent.click(screen.getByRole("button", { name: "Text me a code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a 10-digit phone number.");
    expect(JSON.parse(startCalls()[0][1].body)).toEqual({ phone: "510", purpose: "sign_in" });
    fetchMock.mockResolvedValueOnce(response({ error: PHONE_AUTH_COPY.not_us, kind: "not_us" }, 400));
    fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "+44 20 7946 0958" } });
    fireEvent.click(screen.getByRole("button", { name: "Text me a code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("We can only text US and Canadian numbers.");
    expect(JSON.parse(startCalls()[1][1].body).phone).toBe("+44 20 7946 0958");
  });
});

describe("phone sign-in code step", () => {
  it("signs in on the 6th digit with exactly one verify, even if autofill, paste and typing all land", async () => {
    render(<PhoneAuthForm nextPath="/resident/communication" />);
    const code = await reachCodeStep();
    let release!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((done) => { release = done; }));
    fireEvent.change(code, { target: { value: "482913" } });
    fireEvent.change(code, { target: { value: "482913" } });
    fireEvent.submit(screen.getByRole("form", { name: "Phone verification" }));
    expect(verifyCalls()).toHaveLength(1);
    expect(JSON.parse(verifyCalls()[0][1].body)).toEqual({ challengeId: "challenge-1", code: "482913", purpose: "sign_in", next: "/resident/communication" });
    release(response({ ok: true, next: "/resident/dashboard" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/resident/dashboard"));
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("does not submit before the 6th digit and extracts the code from a pasted text message", async () => {
    render(<PhoneAuthForm />);
    const code = await reachCodeStep();
    fireEvent.change(code, { target: { value: "48291" } });
    expect(verifyCalls()).toHaveLength(0);
    fetchMock.mockResolvedValueOnce(response({ ok: true }));
    fireEvent.change(code, { target: { value: "Your PropLane code is 482913. It expires in 10 minutes." } });
    await waitFor(() => expect(verifyCalls()).toHaveLength(1));
    expect(JSON.parse(verifyCalls()[0][1].body).code).toBe("482913");
  });

  it("goes to /auth/continue when the server gave no destination, and ignores an unsafe or looping one", async () => {
    for (const next of [undefined, "//evil.example", "/auth/continue", "https://evil.example"]) {
      navigate.mockReset();
      fetchMock.mockReset();
      cleanup();
      render(<PhoneAuthForm nextPath="/portal/properties" />);
      const code = await reachCodeStep();
      fetchMock.mockResolvedValueOnce(response(next === undefined ? { ok: true } : { ok: true, next }));
      fireEvent.change(code, { target: { value: "482913" } });
      await waitFor(() => expect(navigate).toHaveBeenCalledWith("/auth/continue?next=%2Fportal%2Fproperties"));
    }
  });

  it("a wrong code shows its sentence, empties the boxes and lets the next code go through", async () => {
    render(<PhoneAuthForm />);
    const code = await reachCodeStep();
    fetchMock.mockResolvedValueOnce(response({ error: PHONE_AUTH_COPY.wrong_code, kind: "wrong_code" }, 400));
    fireEvent.change(code, { target: { value: "111111" } });
    expect(await screen.findByRole("alert")).toHaveTextContent(PHONE_AUTH_COPY.wrong_code);
    await waitFor(() => expect(code.value).toBe(""));
    fetchMock.mockResolvedValueOnce(response({ ok: true, next: "/portal/dashboard" }));
    fireEvent.change(code, { target: { value: "482913" } });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/portal/dashboard"));
  });

  it("an expired code is replaced automatically only when the server says the cap allows it", async () => {
    render(<PhoneAuthForm />);
    const code = await reachCodeStep();
    fetchMock.mockResolvedValueOnce(response({ error: PHONE_AUTH_COPY.expired, kind: "expired", canResend: true }, 400))
      .mockResolvedValueOnce(response({ challengeId: "challenge-2" }));
    fireEvent.change(code, { target: { value: "111111" } });
    expect(await screen.findByRole("status")).toHaveTextContent("That code expired. We sent a new one.");
    expect(startCalls()).toHaveLength(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("an expired code with no sends left shows the sentence and a Send a new code button, and sends nothing", async () => {
    render(<PhoneAuthForm />);
    const code = await reachCodeStep();
    fetchMock.mockResolvedValueOnce(response({ error: PHONE_AUTH_COPY.expired, kind: "expired", canResend: false }, 400));
    fireEvent.change(code, { target: { value: "111111" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("That code expired.");
    expect(screen.getByRole("button", { name: "Send a new code" })).toBeEnabled();
    expect(startCalls()).toHaveLength(1);
  });

  it("holds Resend for 30 seconds with a countdown", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], shouldAdvanceTime: true });
    render(<PhoneAuthForm />);
    await reachCodeStep();
    expect(screen.getByRole("button", { name: /Resend in 0:(30|29)/ })).toBeDisabled();
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByRole("button", { name: /Resend in 0:(20|19)/ })).toBeDisabled();
    await act(async () => { vi.advanceTimersByTime(21_000); });
    expect(screen.getByRole("button", { name: "Resend code" })).toBeEnabled();
  });

  it("Change returns to the number step", async () => {
    render(<PhoneAuthForm />);
    await reachCodeStep();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(await screen.findByLabelText("Phone number")).toHaveValue("(510) 309-8345");
    expect(screen.queryByLabelText("Verification code")).not.toBeInTheDocument();
  });

  it("uses Web OTP where the browser has it, once, and aborts it when the step is left", async () => {
    let signal: AbortSignal | undefined;
    const get = vi.fn((options: { signal: AbortSignal }) => { signal = options.signal; return Promise.resolve({ code: "482913" }); });
    vi.stubGlobal("OTPCredential", class {});
    Object.defineProperty(navigator, "credentials", { configurable: true, value: { get } });
    fetchMock.mockResolvedValueOnce(response({ challengeId: "challenge-1" })).mockResolvedValueOnce(response({ ok: true, next: "/portal/dashboard" }));
    render(<PhoneAuthForm />);
    fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "5103098345" } });
    fireEvent.click(screen.getByRole("button", { name: "Text me a code" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/portal/dashboard"));
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toMatchObject({ otp: { transport: ["sms"] } });
    expect(verifyCalls()).toHaveLength(1);
    cleanup();
    expect(signal?.aborted).toBe(true);
    Object.defineProperty(navigator, "credentials", { configurable: true, value: undefined });
  });
});

describe("phone sign-in switched off", () => {
  it("a 409 from the server tells the parent to hide the phone box and shows the off sentence", async () => {
    const onPhoneOff = vi.fn();
    render(<PhoneAuthForm onPhoneOff={onPhoneOff} />);
    fetchMock.mockResolvedValueOnce(response({ error: PHONE_AUTH_COPY.off, kind: "off", phoneOff: true }, 409));
    fireEvent.change(screen.getByLabelText("Phone number"), { target: { value: "5103098345" } });
    fireEvent.click(screen.getByRole("button", { name: "Text me a code" }));
    await waitFor(() => expect(onPhoneOff).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("alert")).toHaveTextContent("Phone sign-in isn't available right now. Use Apple, Google or email.");
  });

  it("the switch turned off after the code was sent is handled the same way", async () => {
    const onPhoneOff = vi.fn();
    render(<PhoneAuthForm onPhoneOff={onPhoneOff} />);
    const code = await reachCodeStep();
    fetchMock.mockResolvedValueOnce(response({ error: PHONE_AUTH_COPY.off, kind: "off", phoneOff: true }, 409));
    fireEvent.change(code, { target: { value: "482913" } });
    await waitFor(() => expect(onPhoneOff).toHaveBeenCalledTimes(1));
  });
});
