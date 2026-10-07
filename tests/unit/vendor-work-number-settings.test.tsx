// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { VendorWorkNumberSettings } from "@/components/portal/vendor-work-number-settings";

const base = {
  sponsoredBy: "proplane",
  email: { state: "ready", value: "vendor-abc@vendors.proplane.ai", sendReady: true, receiveReady: true, canSetup: false, blockedReason: "none" },
  inboundAvailable: { email: true, sms: false },
  smsUiEnabled: true,
  usage: { outboundUsed: 0, outboundCap: 1000, capState: "available", smsSegmentsUsed: 0 },
  eligibility: { phoneVerified: true, verifiedPhoneLabel: "(206) 555-0142" },
  forwardToPhone: true,
};
const noNumber = { ...base, sms: { state: "not_started", value: null, sendReady: false, receiveReady: false, canSetup: true, blockedReason: "none" } };
const withNumber = {
  ...base,
  sms: { state: "ready", value: "+14255550177", sendReady: true, receiveReady: true, canSetup: false, blockedReason: "none" },
  usage: { outboundUsed: 42, outboundCap: 1000, capState: "available", smsSegmentsUsed: 42 },
};

type Handler = (url: string, init?: RequestInit) => unknown;
function mockFetch(handler: Handler) {
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const out = handler(url, init) as { ok?: boolean; body: unknown };
    return { ok: out.ok ?? true, json: async () => out.body };
  }));
  return calls;
}

beforeEach(() => window.history.pushState({}, "", "/vendor/settings?tab=work-number-email"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("VendorWorkNumberSettings", () => {
  it("demo mode renders the sample number with no network", async () => {
    window.history.pushState({}, "", "/demo/vendor/settings");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { findByText } = render(<VendorWorkNumberSettings />);
    expect(await findByText("+1 (425) 555-0177")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows the claimed number, email, forwarding toggle, texts this month and the service fee", async () => {
    mockFetch(() => ({ body: { ok: true, identity: withNumber } }));
    const { findByText, getByLabelText } = render(<VendorWorkNumberSettings />);
    expect(await findByText("+1 (425) 555-0177")).toBeTruthy();
    expect(await findByText("vendor-abc@vendors.proplane.ai")).toBeTruthy();
    expect(await findByText("Forward texts to my phone")).toBeTruthy();
    expect(getByLabelText("Forward texts to my phone").getAttribute("aria-checked")).toBe("true");
    expect(await findByText("42 of 1,000")).toBeTruthy();
    expect(await findByText("3% of payouts through PropLane")).toBeTruthy();
  });

  it("the forwarding toggle saves through PATCH and flips", async () => {
    const calls = mockFetch((_url, init) => (init?.method === "PATCH"
      ? { body: { ok: true, identity: { ...withNumber, forwardToPhone: false } } }
      : { body: { ok: true, identity: withNumber } }));
    const { findByLabelText } = render(<VendorWorkNumberSettings />);
    const toggle = await findByLabelText("Forward texts to my phone");
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ forwardToPhone: false });
  });

  it("a failed forwarding save reverts the toggle and says so", async () => {
    mockFetch((_url, init) => (init?.method === "PATCH" ? { ok: false, body: { ok: false, error: "x" } } : { body: { ok: true, identity: withNumber } }));
    const { findByLabelText, findByText } = render(<VendorWorkNumberSettings />);
    const toggle = await findByLabelText("Forward texts to my phone");
    fireEvent.click(toggle);
    expect(await findByText("Forwarding could not be saved. Try again.")).toBeTruthy();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("at the monthly cap shows the pause notice", async () => {
    mockFetch(() => ({ body: { ok: true, identity: { ...withNumber, usage: { outboundUsed: 1000, outboundCap: 1000, capState: "exhausted", smsSegmentsUsed: 1000 } } } }));
    const { findByText } = render(<VendorWorkNumberSettings />);
    expect(await findByText(/fair-use limit/)).toBeTruthy();
    expect(await findByText("1,000 of 1,000")).toBeTruthy();
  });

  it("an unverified phone is sent to verify it, with no claim form", async () => {
    mockFetch(() => ({ body: { ok: true, identity: { ...noNumber, sms: { ...noNumber.sms, canSetup: false, blockedReason: "phone_unverified" }, eligibility: { phoneVerified: false, verifiedPhoneLabel: null } } } }));
    const { findByText, container } = render(<VendorWorkNumberSettings />);
    const link = await findByText("Verify your phone to get one");
    expect(link.getAttribute("href")).toBe("/vendor/settings?tab=messaging");
    expect(container.querySelector('[data-attr="vendor-work-number-claim"]')).toBeNull();
  });

  it("claims in three steps: area code, pick one of three, claim - and reloads", async () => {
    let claimed = false;
    const calls = mockFetch((url, init) => {
      if (url.includes("/candidates")) {
        return { body: { ok: true, dryRun: true, candidates: [
          { phoneNumber: "+14255550177", claimToken: "t1" }, { phoneNumber: "+14255550178", claimToken: "t2" }, { phoneNumber: "+14255550179", claimToken: "t3" },
        ] } };
      }
      if (init?.method === "POST") {
        claimed = true;
        return { body: { ok: true, identity: withNumber } };
      }
      return { body: { ok: true, identity: claimed ? withNumber : noNumber } };
    });
    const { findByLabelText, findByText, getByText, container } = render(<VendorWorkNumberSettings />);
    fireEvent.change(await findByLabelText("Area code"), { target: { value: "425" } });
    fireEvent.click(getByText("Find numbers"));
    expect(await findByText("+1 (425) 555-0177")).toBeTruthy();
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(3);
    expect(await findByText("Dry run · no real number is bought")).toBeTruthy();
    fireEvent.click(container.querySelectorAll('input[type="radio"]')[1]!);
    fireEvent.click(getByText("Claim number"));
    expect(await findByText("+1 (425) 555-0177")).toBeTruthy();
    const post = calls.find((c) => c.method === "POST" && !c.url.includes("candidates"));
    expect(post?.body).toMatchObject({ channel: "sms", phoneNumber: "+14255550178", claimToken: "t2" });
  });

  it("rejects a malformed area code before any search", async () => {
    const calls = mockFetch(() => ({ body: { ok: true, identity: noNumber } }));
    const { findByLabelText, getByText, findByText } = render(<VendorWorkNumberSettings />);
    fireEvent.change(await findByLabelText("Area code"), { target: { value: "12" } });
    fireEvent.click(getByText("Find numbers"));
    expect(await findByText("Enter a valid 3-digit area code.")).toBeTruthy();
    expect(calls.some((c) => c.url.includes("candidates"))).toBe(false);
  });

  it("a mid-flight claim reads Setting up", async () => {
    mockFetch(() => ({ body: { ok: true, identity: { ...noNumber, sms: { ...noNumber.sms, state: "reconciling", value: "+14255550177", canSetup: false } } } }));
    const { findByText } = render(<VendorWorkNumberSettings />);
    expect(await findByText("Setting up…")).toBeTruthy();
  });

  it("carries no subtext under any row", async () => {
    mockFetch(() => ({ body: { ok: true, identity: withNumber } }));
    const { findByText, container } = render(<VendorWorkNumberSettings />);
    await findByText("+1 (425) 555-0177");
    expect(container.querySelectorAll("p.text-muted, p[class*='text-muted']").length).toBe(0);
  });
});
