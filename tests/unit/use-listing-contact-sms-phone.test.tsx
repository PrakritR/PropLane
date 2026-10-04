// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSharedGets } from "@/lib/shared-get-cache";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { CLAW_DEFAULT_AGENT_PHONE } from "@/lib/claw-leasing-links";
import { useListingContactSmsPhone } from "@/hooks/use-listing-contact-sms-phone";

const MANAGER_PHONE = "+12063214477";
const OTHER_MANAGER_PHONE = "+14257771188";

type FetchStub = (url: string) => { ok: boolean; json: () => Promise<unknown> };

function stubFetch(handler: FetchStub) {
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const res = handler(url);
    return { ok: res.ok, json: res.json } as unknown as Response;
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

const emptyCatalog = { ok: true, json: async () => ({ listings: [] }) };

describe("useListingContactSmsPhone", () => {
  // The hook's GETs are shared per URL for the page load; every case starts from a cold cache.
  beforeEach(() => resetSharedGets());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("does not fall back to the shared work number when the server explicitly resolved no CTA phone", async () => {
    // Production manager with no verified phone: `/api/manager/messaging-number` returns
    // `listingCtaPhone: null`. Falling through to `workNumber` (always the
    // shared Claw agent line under the bridge) would text the platform line
    // instead of rendering the "Schedule a tour / apply online" web links.
    stubFetch((url) =>
      url.startsWith("/api/manager/messaging-number")
        ? {
            ok: true,
            json: async () => ({ canSend: false, number: { phoneNumber: CLAW_DEFAULT_AGENT_PHONE } }),
          }
        : emptyCatalog,
    );

    const { result } = renderHook(() => useListingContactSmsPhone({ listingId: "preview-1" }));
    await waitFor(() => expect(result.current).toBeNull());
  });

  it("uses the active workspace number when the channel can send", async () => {
    stubFetch((url) =>
      url.startsWith("/api/manager/messaging-number")
        ? { ok: true, json: async () => ({ canSend: true, workspaceNumber: { phoneNumber: MANAGER_PHONE } }) }
        : emptyCatalog,
    );

    const { result } = renderHook(() => useListingContactSmsPhone({ listingId: "preview-1" }));
    await waitFor(() => expect(result.current).toBe(MANAGER_PHONE));
  });

  it("never stamps the viewer's own phone onto another manager's listing when the viewer is unknown", async () => {
    // Admin/cross-manager previews pass ownerManagerUserId with no viewer id.
    // A public-catalog miss (draft listing, or an owner with no verified phone)
    // must resolve to null, not to whoever happens to be signed in.
    const spy = stubFetch((url) =>
      url.startsWith("/api/manager/messaging-number")
        ? { ok: true, json: async () => ({ canSend: true, number: { phoneNumber: OTHER_MANAGER_PHONE } }) }
        : emptyCatalog,
    );

    const { result } = renderHook(() =>
      useListingContactSmsPhone({ listingId: "preview-abc", ownerManagerUserId: "owner-1" }),
    );

    await waitFor(() => expect(result.current).toBeNull());
    expect(spy.mock.calls.some(([input]) => String(input).startsWith("/api/manager/messaging-number"))).toBe(false);
  });

  it("uses the signed-in manager's own number when they own the listing", async () => {
    stubFetch((url) =>
      url.startsWith("/api/manager/messaging-number")
        ? { ok: true, json: async () => ({ canSend: true, number: { phoneNumber: MANAGER_PHONE } }) }
        : emptyCatalog,
    );

    const { result } = renderHook(() =>
      useListingContactSmsPhone({
        listingId: "listing-abc",
        ownerManagerUserId: "owner-1",
        viewerManagerUserId: "owner-1",
      }),
    );
    await waitFor(() => expect(result.current).toBe(MANAGER_PHONE));
  });
});
