// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

vi.mock("@/components/portal/google-calendar-connect-panel", () => ({
  GoogleCalendarConnectPanel: (props: { apiBase?: string; showVendorPushToggle?: boolean }) => (
    <div data-testid="gcal-panel" data-api={props.apiBase} data-push={String(props.showVendorPushToggle)} />
  ),
}));

import { VendorIntegrationsSettings } from "@/components/portal/vendor-integrations-settings";

const FEED_URL = "https://proplane.ai/api/calendar/vendor/v/tok.ics";

function mockFetch(opts: { requested?: string[]; requestFails?: boolean; feedFails?: boolean } = {}) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes("/api/vendor/calendar-feed")) {
        if (opts.feedFails) return { ok: false, json: async () => ({ ok: false, error: "Calendar link is temporarily unavailable." }) };
        return { ok: true, json: async () => ({ ok: true, url: method === "POST" ? `${FEED_URL}?new` : FEED_URL, revoked: false }) };
      }
      if (url.includes("/api/vendor/work-identity")) {
        return {
          ok: true,
          json: async () => ({ identity: { sms: { value: "+14255550177" }, email: { value: "dima@vendors.proplane.ai" } } }),
        };
      }
      if (url.includes("/api/vendor/integration-requests")) {
        if (method === "POST") {
          return opts.requestFails
            ? { ok: false, json: async () => ({ ok: false }) }
            : { ok: true, json: async () => ({ ok: true }) };
        }
        return { ok: true, json: async () => ({ ok: true, requested: opts.requested ?? [] }) };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
  return calls;
}

describe("VendorIntegrationsSettings", () => {
  beforeEach(() => window.history.pushState({}, "", "/vendor/settings?tab=integrations"));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders Google Calendar (existing vendor connect), the Calendar link and the three Coming soon rows", async () => {
    mockFetch();
    const { findByText, getByTestId, getAllByText } = render(<VendorIntegrationsSettings />);
    expect(getByTestId("gcal-panel").getAttribute("data-api")).toBe("/api/vendor/google-calendar");
    expect(getByTestId("gcal-panel").getAttribute("data-push")).toBe("true");
    expect(await findByText("Calendar link")).toBeTruthy();
    expect(await findByText(FEED_URL)).toBeTruthy();
    for (const name of ["Jobber", "Housecall Pro", "Thumbtack"]) expect(await findByText(name)).toBeTruthy();
    expect(getAllByText("Request access")).toHaveLength(3);
    const rows = document.body.textContent ?? "";
    expect(rows.match(/Coming soon\s*Request access/g)).toHaveLength(3);
    expect(document.querySelector('[aria-label="Copy link"]')).toBeTruthy();
    expect(document.querySelector('[aria-label="Reset link"]')).toBeTruthy();
  });

  it("is grouped Messages · Calendar · Job software, each a manager-style row with its action", async () => {
    mockFetch();
    const onManage = vi.fn();
    const { findByText } = render(<VendorIntegrationsSettings onManage={onManage} />);
    for (const title of ["Messages", "Calendar", "Job software"]) expect(await findByText(title)).toBeTruthy();
    for (const name of ["Work number", "Work email", "Calendar link"]) expect(await findByText(name)).toBeTruthy();
    expect(await findByText("(425) 555-0177")).toBeTruthy();
    expect(await findByText("dima@vendors.proplane.ai")).toBeTruthy();
    fireEvent.click(document.querySelector('[data-attr="vendor-integrations-number-manage"]')!);
    expect(onManage).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("[data-attr$='-row']").length).toBeGreaterThanOrEqual(5);
  });

  it("says Not set up when the vendor has no work number or email yet", async () => {
    mockFetch();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/vendor/work-identity")) return { ok: true, json: async () => ({ identity: { sms: {}, email: {} } }) };
        if (url.includes("/api/vendor/calendar-feed")) return { ok: true, json: async () => ({ ok: true, url: FEED_URL }) };
        return { ok: true, json: async () => ({ ok: true, requested: [] }) };
      }),
    );
    const { findAllByText } = render(<VendorIntegrationsSettings />);
    expect(await findAllByText("Not set up")).toHaveLength(2);
  });

  it("Request access records the provider and the row then says Requested", async () => {
    const calls = mockFetch();
    const { findAllByText, findByText } = render(<VendorIntegrationsSettings />);
    fireEvent.click((await findAllByText("Request access"))[0]!);
    expect(await findByText("Requested")).toBeTruthy();
    const post = calls.find((c) => c.url.includes("integration-requests") && c.method === "POST");
    expect(post?.body).toEqual({ provider: "jobber" });
    await waitFor(() => expect(document.querySelectorAll('[data-attr$="-request-access"]')).toHaveLength(2));
  });

  it("starts a provider as Requested when the server already has the request", async () => {
    mockFetch({ requested: ["thumbtack"] });
    const { findByText } = render(<VendorIntegrationsSettings />);
    expect(await findByText("Requested")).toBeTruthy();
    expect(document.querySelectorAll('[data-attr$="-request-access"]')).toHaveLength(2);
  });

  it("shows 'Could not send your request' and keeps the action when the request fails", async () => {
    mockFetch({ requestFails: true });
    const { findAllByText, findByText } = render(<VendorIntegrationsSettings />);
    fireEvent.click((await findAllByText("Request access"))[0]!);
    expect(await findByText("Could not send your request")).toBeTruthy();
    expect(document.querySelectorAll('[data-attr$="-request-access"]')).toHaveLength(3);
  });

  it("shows an error instead of a link when the feed cannot load", async () => {
    mockFetch({ feedFails: true });
    const { findByText } = render(<VendorIntegrationsSettings />);
    expect(await findByText("Calendar link is temporarily unavailable.")).toBeTruthy();
  });

  it("Reset link posts a reset and shows the rotated URL after confirming", async () => {
    const calls = mockFetch();
    vi.stubGlobal("confirm", vi.fn(() => true));
    const { findByText } = render(<VendorIntegrationsSettings />);
    await findByText(FEED_URL);
    fireEvent.click(document.querySelector('[aria-label="Reset link"]')!);
    expect(await findByText(`${FEED_URL}?new`)).toBeTruthy();
    expect(calls.find((c) => c.method === "POST" && c.url.includes("calendar-feed"))?.body).toEqual({ action: "reset" });
  });

  it("Reset link does nothing when the confirmation is declined", async () => {
    const calls = mockFetch();
    vi.stubGlobal("confirm", vi.fn(() => false));
    const { findByText } = render(<VendorIntegrationsSettings />);
    await findByText(FEED_URL);
    fireEvent.click(document.querySelector('[aria-label="Reset link"]')!);
    await waitFor(() => expect(globalThis.confirm).toHaveBeenCalled());
    expect(calls.some((c) => c.method === "POST" && c.url.includes("calendar-feed"))).toBe(false);
  });
});

describe("VendorIntegrationsSettings in demo mode", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.history.pushState({}, "", "/");
  });

  it("renders the rows without any network and Request access flips to Requested", async () => {
    window.history.pushState({}, "", "/demo/vendor/settings");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { findAllByText, findByText, getByText } = render(<VendorIntegrationsSettings />);
    expect(getByText("Calendar link")).toBeTruthy();
    fireEvent.click((await findAllByText("Request access"))[0]!);
    expect(await findByText("Requested")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
