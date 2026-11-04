// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { VendorQuotePublicPage } from "@/app/(public)/vendor-quote/vendor-quote-public-page";

const publicProjection = {
  sessionBinding: "session-a",
  reference: "SR-2048",
  category: "Plumbing",
  city: "Seattle",
  problemDescription: "Kitchen sink leak",
  senderName: "PropLane",
  senderEmail: "service@example.test",
  expiresAt: "2026-10-20T12:00:00.000Z",
  currentVersion: 3,
  quote: null,
  windows: [],
  canStopEmail: true,
  smsConsent: "not_requested" as const,
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("public vendor quote response page", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/vendor-quote");
    window.sessionStorage.clear();
    window.location.hash = "#capability-secret";
  });

  it("exchanges the fragment once, removes it from history, and supports email-only answers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, projection: publicProjection, followUpReply: "Can you confirm access hours?" }),
    } as Response);
    render(<VendorQuotePublicPage />);

    await screen.findByRole("heading", { name: "Respond to a service request" });
    expect(window.location.hash).toBe("");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/public/vendor-quote/exchange");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ token: "capability-secret", purpose: "response" });
    expect(window.sessionStorage.length).toBe(1);
    expect(window.sessionStorage.getItem("proplane:vendor-quote-session-binding")).toBe("session-a");
    expect(screen.getByText("Problem")).toBeTruthy();
    expect(screen.getByText("Kitchen sink leak")).toBeTruthy();
    expect(screen.getByLabelText(/labor amount/i)).toBeTruthy();
    expect(screen.getByLabelText(/materials amount/i)).toBeTruthy();
    expect(screen.getByLabelText(/diagnostic fee/i)).toBeTruthy();
    expect(screen.getByLabelText(/estimated duration/i)).toBeTruthy();
    expect(screen.getByLabelText(/question for the sender/i)).toBeTruthy();
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("button", { name: "Create SMS challenge" }).hasAttribute("disabled")).toBe(true);
    expect((screen.getByLabelText(/mobile number/i) as HTMLInputElement).value).toBe("");

    fireEvent.change(screen.getByLabelText(/question for the sender/i), { target: { value: "Can you confirm access hours?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send response" }));
    await waitFor(() => expect(screen.getByText("Your response is saved.")).toBeTruthy());
    expect(screen.getByText("Can you confirm access hours?")).toBeTruthy();
    expect(screen.getByLabelText(/question for the sender/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create SMS challenge" })).toBeTruthy();
    expect(fetchMock.mock.calls[1][0]).toBe("/api/public/vendor-quote/response");
    expect(fetchMock.mock.calls[1][1]?.credentials).toBe("same-origin");
    expect((fetchMock.mock.calls[1][1]?.headers as Record<string, string>)["X-Vendor-Quote-Binding"]).toBe("session-a");
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/public/vendor-quote/sms-challenge")).toBe(false);
  });

  it("shows a conflict without replacing the draft or resubmitting", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, projection: publicProjection }) } as Response)
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ ok: false, error: "Refresh and review the latest quote before sending." }) } as Response);
    render(<VendorQuotePublicPage />);
    await screen.findByRole("heading", { name: "Respond to a service request" });
    fireEvent.change(screen.getByLabelText(/labor amount/i), { target: { value: "250" } });
    fireEvent.click(screen.getByRole("button", { name: "Send response" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Refresh and review the latest quote before sending.");
    expect((screen.getByLabelText(/labor amount/i) as HTMLInputElement).value).toBe("250");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shows a withdrawal link as an explicit confirmation rather than changing email preferences on open", async () => {
    window.location.hash = "#stop=withdrawal-secret";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, projection: publicProjection }),
    } as Response);
    render(<VendorQuotePublicPage />);
    await screen.findByRole("heading", { name: "Email preferences" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/public/vendor-quote/exchange");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ token: "withdrawal-secret", purpose: "withdrawal" });
    expect(screen.getByRole("button", { name: "Stop quote emails" })).toBeTruthy();
    expect(screen.getByText(/Stop emails about this quote/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop quote emails" }));
    await screen.findByRole("heading", { name: "Quote emails have stopped." });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/public/vendor-quote/withdrawal");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ action: "stop_email" });
  });

  it("does not silently switch a tab to a different quote session after reload", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, projection: publicProjection }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, projection: { ...publicProjection, sessionBinding: "session-b" } }) } as Response);
    const firstRender = render(<VendorQuotePublicPage />);
    await screen.findByRole("heading", { name: "Respond to a service request" });
    expect(window.sessionStorage.getItem("proplane:vendor-quote-session-binding")).toBe("session-a");

    firstRender.unmount();
    window.history.replaceState(null, "", "/vendor-quote");
    render(<VendorQuotePublicPage />);
    await screen.findByText("This quote link is no longer available.");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/public/vendor-quote/session");
    expect(window.sessionStorage.getItem("proplane:vendor-quote-session-binding")).toBe("session-a");
    expect(screen.queryByRole("heading", { name: "Respond to a service request" })).toBeNull();
  });

  it("creates an SMS challenge only after explicit consent and an E.164 number", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, projection: publicProjection }),
    } as Response).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, challenge: { code: "123456789012", destinationPhone: "+12065550100", expiresAt: "2026-10-18T14:00:00Z" } }),
    } as Response);
    render(<VendorQuotePublicPage />);
    await screen.findByRole("heading", { name: "Respond to a service request" });

    const phone = screen.getByLabelText(/mobile number/i);
    const checkbox = screen.getByRole("checkbox");
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("button", { name: "Create SMS challenge" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(phone, { target: { value: "+12065550123" } });
    expect((screen.getByRole("button", { name: "Create SMS challenge" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole("button", { name: "Create SMS challenge" }));

    await screen.findByText("QUOTE 123456789012");
    expect(fetchMock.mock.calls).toHaveLength(2);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/public/vendor-quote/sms-challenge");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ phoneE164: "+12065550123", consented: true });

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    fireEvent.click(screen.getByRole("button", { name: "Copy text" }));
    await screen.findByRole("button", { name: "Copied" });
    expect(writeText).toHaveBeenCalledWith("QUOTE 123456789012");
  });

  it("keeps the latest quote editable through partial turns and a complete response", async () => {
    const version4 = { ...publicProjection, currentVersion: 4, quote: { laborCents: 15_000, materialsCents: null, diagnosticFeeCents: null, scope: "Replace the faucet", exclusions: "", durationMinutes: null, windows: [] } };
    const version5 = { ...version4, currentVersion: 5, quote: { ...version4.quote, durationMinutes: 60 } };
    const version6 = { ...version5, currentVersion: 6, quote: { ...version5.quote, materialsCents: 2_500, diagnosticFeeCents: 0, windows: [{ startIso: "2026-10-20T16:00:00.000Z", endIso: "2026-10-20T18:00:00.000Z", timeZone: "UTC" }] }, windows: [{ startIso: "2026-10-20T16:00:00.000Z", endIso: "2026-10-20T18:00:00.000Z", timeZone: "UTC" }] };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, projection: publicProjection }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, projection: version4, followUpReply: null }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, projection: version5, followUpReply: "Which dates work for access?" }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, projection: version6, followUpReply: null }) } as Response);
    render(<VendorQuotePublicPage />);
    await screen.findByRole("heading", { name: "Respond to a service request" });

    fireEvent.change(screen.getByLabelText(/labor amount/i), { target: { value: "150.00" } });
    fireEvent.change(screen.getByLabelText(/^scope/i), { target: { value: "Replace the faucet" } });
    fireEvent.click(screen.getByRole("button", { name: "Send response" }));
    await screen.findByText("Your message is saved for the sender to follow up. No automated reply was available.");
    expect((screen.getByLabelText(/labor amount/i) as HTMLInputElement).value).toBe("150.00");
    expect((screen.getByLabelText(/^scope/i) as HTMLTextAreaElement).value).toBe("Replace the faucet");
    expect(screen.getByRole("button", { name: "Create SMS challenge" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/estimated duration/i), { target: { value: "60" } });
    fireEvent.change(screen.getByLabelText(/question for the sender/i), { target: { value: "Which dates work for access?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send response" }));
    await screen.findByText("Which dates work for access?");
    expect((screen.getByLabelText(/estimated duration/i) as HTMLInputElement).value).toBe("60");
    expect((screen.getByLabelText(/labor amount/i) as HTMLInputElement).value).toBe("150.00");
    expect((screen.getByLabelText(/question for the sender/i) as HTMLTextAreaElement).value).toBe("");

    fireEvent.change(screen.getByLabelText(/materials amount/i), { target: { value: "25.00" } });
    fireEvent.change(screen.getByLabelText(/diagnostic fee/i), { target: { value: "0.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Add availability window" }));
    fireEvent.change(screen.getByLabelText(/^start$/i), { target: { value: "2026-10-20T12:00" } });
    fireEvent.change(screen.getByLabelText(/^end$/i), { target: { value: "2026-10-20T14:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Send response" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect((screen.getByLabelText(/materials amount/i) as HTMLInputElement).value).toBe("25.00");
    expect((screen.getByLabelText(/diagnostic fee/i) as HTMLInputElement).value).toBe("0.00");
    expect(screen.getByLabelText(/^start$/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create SMS challenge" })).toBeTruthy();
    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body)).expectedVersion).toBe(5);
  });
});
