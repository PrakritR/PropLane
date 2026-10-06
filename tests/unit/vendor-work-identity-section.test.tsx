// @vitest-environment jsdom
//
// VD04/VD05: the merged "Work contact & email" section — the real work-email
// claim plus the free-text business contact fields, autosaving. (The PropLane
// work NUMBER claim was retired Oct 6: vendors never own a number.) `ctx` (from `useVendorBusinessProfile`) is
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

  it("renders the business contact fields and the work-email claim, and no number claim", async () => {
    mockFetchByUrl({ "/api/vendor/work-identity": { ok: true, identity: identity() } });
    const { findByText, findByDisplayValue } = render(<VendorWorkIdentitySection ctx={fakeCtx()} />);
    expect(await findByText("Work contact & email")).toBeTruthy();
    expect(await findByDisplayValue("+12065550100")).toBeTruthy();
    expect(await findByDisplayValue("office@apex.test")).toBeTruthy();
    expect(await findByText("PropLane work email")).toBeTruthy();
    expect(document.body.textContent).not.toContain("PropLane work number");
    expect(document.querySelector('[data-attr="vendor-work-number-claim"]')).toBeNull();
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
