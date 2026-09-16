// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { useListingContactWorkEmail } from "@/hooks/use-listing-contact-work-email";

const OWN_EMAIL = "leasing@mail.proplane.space";
const OTHER_EMAIL = "other@mail.proplane.space";

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

/** The shape `isManagerAssistantEmailStatus` accepts, with only what the hook reads varying. */
function status(overrides: { address?: string | null; canUse?: boolean; receiving?: boolean; workspace?: string | null }) {
  return {
    provisioningAvailable: true,
    sendingAvailable: true,
    receivingAvailable: overrides.receiving ?? true,
    storageReady: true,
    planTier: "paid",
    entitlement: { eligible: true },
    workspaceRole: "primary",
    workspaceEmail: overrides.workspace ? { address: overrides.workspace, ownerUserId: "owner-1", ownerName: null } : null,
    address: overrides.address ?? null,
    state: "ready",
    canRequest: false,
    canUse: overrides.canUse ?? true,
    requestedAtSignup: false,
  };
}

const emptyCatalog = { ok: true, json: async () => ({ listings: [] }) };

describe("useListingContactWorkEmail", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("reads a live listing's email from the public catalog, exactly what the public page prints", async () => {
    const spy = stubFetch((url) =>
      url.startsWith("/api/property-records/public")
        ? { ok: true, json: async () => ({ listings: [{ id: "listing-abc", contactWorkEmail: OTHER_EMAIL }] }) }
        : { ok: true, json: async () => status({ address: OWN_EMAIL }) },
    );
    const { result } = renderHook(() =>
      useListingContactWorkEmail({ listingId: "listing-abc", ownerManagerUserId: "owner-2", viewerManagerUserId: "owner-1" }),
    );
    await waitFor(() => expect(result.current).toBe(OTHER_EMAIL));
    expect(spy.mock.calls.some(([input]) => String(input).startsWith("/api/manager/assistant-email"))).toBe(false);
  });

  it("uses the signed-in manager's own work email for their draft", async () => {
    stubFetch((url) =>
      url.startsWith("/api/manager/assistant-email")
        ? { ok: true, json: async () => status({ address: OWN_EMAIL }) }
        : emptyCatalog,
    );
    const { result } = renderHook(() => useListingContactWorkEmail({ listingId: "preview-1" }));
    await waitFor(() => expect(result.current).toBe(OWN_EMAIL));
  });

  it("shows no email when this deployment cannot carry mail", async () => {
    // An address on a deployment with no inbound webhook is not a door; the
    // public catalog drops it (`resolveActiveManagerWorkEmail`) and so does this.
    stubFetch((url) =>
      url.startsWith("/api/manager/assistant-email")
        ? { ok: true, json: async () => status({ address: OWN_EMAIL, receiving: false }) }
        : emptyCatalog,
    );
    const { result } = renderHook(() => useListingContactWorkEmail({ listingId: "preview-1" }));
    // Let the fetch settle, then assert it stayed null.
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBeNull();
  });

  it("matches the public page rather than Settings: a plan hold does not hide the door", async () => {
    stubFetch((url) =>
      url.startsWith("/api/manager/assistant-email")
        ? { ok: true, json: async () => status({ address: OWN_EMAIL, canUse: false }) }
        : emptyCatalog,
    );
    const { result } = renderHook(() => useListingContactWorkEmail({ listingId: "preview-1" }));
    await waitFor(() => expect(result.current).toBe(OWN_EMAIL));
  });

  it("never stamps the viewer's own email onto another manager's listing", async () => {
    const spy = stubFetch((url) =>
      url.startsWith("/api/manager/assistant-email")
        ? { ok: true, json: async () => status({ address: OWN_EMAIL }) }
        : emptyCatalog,
    );
    const { result } = renderHook(() =>
      useListingContactWorkEmail({ listingId: "preview-abc", ownerManagerUserId: "owner-1" }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toBeNull();
    expect(spy.mock.calls.some(([input]) => String(input).startsWith("/api/manager/assistant-email"))).toBe(false);
  });
});
