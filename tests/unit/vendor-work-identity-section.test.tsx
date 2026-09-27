// @vitest-environment jsdom
//
// VD04/VD05: the merged "Work number & email" section — the real, free
// PropLane work-number claim flow (area code -> pick one of 3 -> claim) and
// the real work-email claim, plus the pre-existing free-text business
// contact fields, now autosaving. `ctx` (from `useVendorBusinessProfile`) is
// faked directly so these tests exercise only the claim flow and the
// autosave wiring, not the profile-loading fetch.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { VendorWorkIdentitySection } from "@/components/portal/vendor-business-settings";

function fakeCtx(overrides: Partial<{ save: ReturnType<typeof vi.fn> }> = {}) {
  return {
    profile: {
      businessName: "Apex Plumbing",
      contactName: "Jo Apex",
      workEmail: "office@apex.test",
      workPhone: "+12065550100",
      serviceArea: "Seattle",
      notifyNewOffers: true,
      notifyScheduleChanges: true,
      notifyPayments: true,
    },
    workspaces: [],
    loading: false,
    saving: false,
    error: null,
    save: overrides.save ?? vi.fn().mockResolvedValue({ ok: true }),
    reload: vi.fn(),
  };
}

type Channel = { value: string | null; sendReady: boolean; receiveReady: boolean; state: string; canSetup: boolean; blockedReason: string };
function channel(overrides: Partial<Channel> = {}): Channel {
  return { value: null, sendReady: false, receiveReady: false, state: "not_started", canSetup: true, blockedReason: "none", ...overrides };
}
function identity(overrides: { sms?: Partial<Channel>; email?: Partial<Channel> } = {}) {
  return { sms: channel(overrides.sms), email: channel(overrides.email) };
}

function mockFetchByUrl(routes: Record<string, unknown | ((body: unknown) => unknown)>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const key = Object.keys(routes).find((k) => url.includes(k));
      if (!key) return { ok: true, json: async () => ({}) };
      const entry = routes[key];
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const payload = typeof entry === "function" ? entry(body) : entry;
      return { ok: true, json: async () => payload };
    }),
  );
}

describe("VendorWorkIdentitySection", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the business contact fields and the two claim sub-sections", async () => {
    mockFetchByUrl({ "/api/vendor/work-identity": { ok: true, identity: identity() } });
    const { findByText, findByDisplayValue } = render(<VendorWorkIdentitySection ctx={fakeCtx()} />);
    expect(await findByText("Work number & email")).toBeTruthy();
    expect(await findByDisplayValue("+12065550100")).toBeTruthy();
    expect(await findByDisplayValue("office@apex.test")).toBeTruthy();
    expect(await findByText("PropLane work number")).toBeTruthy();
    expect(await findByText("PropLane work email")).toBeTruthy();
  });

  it("autosaves the business phone on blur", async () => {
    mockFetchByUrl({ "/api/vendor/work-identity": { ok: true, identity: identity() } });
    const save = vi.fn().mockResolvedValue({ ok: true });
    const { findByDisplayValue } = render(<VendorWorkIdentitySection ctx={fakeCtx({ save })} />);
    const input = (await findByDisplayValue("+12065550100")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "+12065559999" } });
    fireEvent.blur(input);
    await waitFor(() => expect(save).toHaveBeenCalledWith({ workPhone: "+12065559999" }));
  });

  it("area code -> pick one of 3 -> claim sends the matching claim token and purchases exactly that number", async () => {
    let claimedNumber: string | null = null;
    let claimBody: { phoneNumber?: string; claimToken?: string } | undefined;
    const tokenFor = (phoneNumber: string) => `tok-${phoneNumber}`;
    mockFetchByUrl({
      "/api/vendor/work-identity/candidates": {
        ok: true,
        candidates: ["+12065550101", "+12065550102", "+12065550103"].map((phoneNumber) => ({
          phoneNumber,
          claimToken: tokenFor(phoneNumber),
        })),
      },
      "/api/vendor/work-identity": (body: unknown) => {
        const b = body as { channel?: string; phoneNumber?: string; claimToken?: string } | undefined;
        if (b?.channel === "sms" && b.phoneNumber) {
          claimBody = { phoneNumber: b.phoneNumber, claimToken: b.claimToken };
          claimedNumber = b.phoneNumber;
        }
        return { ok: true, identity: identity({ sms: { value: claimedNumber, state: claimedNumber ? "reconciling" : "not_started", canSetup: !claimedNumber } }) };
      },
    });
    const { findByPlaceholderText, findByText } = render(<VendorWorkIdentitySection ctx={fakeCtx()} />);
    const areaCodeInput = await findByPlaceholderText("206");
    fireEvent.change(areaCodeInput, { target: { value: "206" } });
    fireEvent.click(await findByText("See numbers"));
    const candidates = await waitFor(() => {
      const nodes = document.querySelectorAll('[data-attr="vendor-work-number-candidate"]');
      expect(nodes.length).toBe(3);
      return Array.from(nodes) as HTMLButtonElement[];
    });
    // pick the second offered number, not just whatever defaulted as selected
    fireEvent.click(candidates[1]!);
    const claimButton = document.querySelector('[data-attr="vendor-work-number-claim"]') as HTMLButtonElement;
    expect(claimButton.textContent).toContain("555-0102");
    fireEvent.click(claimButton);
    await waitFor(() => expect(document.querySelector('[data-attr="vs-claimed-number"]')).toBeTruthy());
    expect(document.querySelector('[data-attr="vs-claimed-number"]')?.textContent).toContain("555-0102");
    expect(claimBody).toEqual({ phoneNumber: "+12065550102", claimToken: tokenFor("+12065550102") });
  });

  it("claims the real work email with one button, never a local-part picker", async () => {
    let claimed = false;
    mockFetchByUrl({
      "/api/vendor/work-identity": (body: unknown) => {
        const b = body as { channel?: string } | undefined;
        if (b?.channel === "email") claimed = true;
        return {
          ok: true,
          identity: claimed
            ? identity({ email: { value: "vendor-abc123@prop-lane.space", sendReady: true, receiveReady: true, state: "ready", canSetup: false } })
            : identity(),
        };
      },
    });
    const { findByText } = render(<VendorWorkIdentitySection ctx={fakeCtx()} />);
    fireEvent.click(await findByText("Claim work email"));
    await waitFor(() => expect(document.querySelector('[data-attr="vs-claimed-email"]')).toBeTruthy());
    expect(document.body.textContent).not.toContain("proplane.work");
  });
});
