// @vitest-environment jsdom
/**
 * Regression for the Night flow tour-scheduling bug: a resident who has just
 * signed in lands on /resident/tour/schedule (or the signed-out guest
 * /rent/tours-contact, which shares the same loader) and sees "This listing
 * is not available to tour right now." even though the underlying
 * /api/public/property-lead call returns 200 with the live property.
 *
 * Root cause: sign-in hydration fires onPortalSessionViewerChange ->
 * resetPropertyPipelineClientCache() -> resetPublicListingCatalog(), which
 * bumps the module's catalog "generation" counter. If that happens WHILE a
 * loadPublicPropertyLeadFromServer() request for the listing is still in
 * flight, fetchPublicPropertyLead() used to discard the successful response
 * outright (gated on isCurrentPublicCatalogRequest(identity)) instead of
 * still caching it, so getPropertyForPublicLink() — the synchronous reader
 * every tour/apply page actually renders from — never found the listing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPortalSessionViewer } from "@/lib/auth/portal-session-gate";
import {
  loadPublicPropertyLeadFromServer,
  resetPropertyPipelineClientCache,
} from "@/lib/demo-property-pipeline";
import { getPropertyForPublicLink } from "@/lib/rental-application/data";
import type { MockProperty } from "@/data/types";

function listing(id: string): MockProperty {
  return {
    id,
    title: id,
    tagline: "",
    address: `${id} Main St`,
    zip: "98101",
    neighborhood: "Test",
    beds: 1,
    baths: 1,
    rentLabel: "$1,200",
    available: "Now",
    petFriendly: false,
    buildingId: id,
    buildingName: id,
    unitLabel: "1",
    adminPublishLive: true,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  window.history.replaceState({}, "", "/resident/tour/schedule");
  window.localStorage.clear();
  window.sessionStorage.clear();
  setPortalSessionViewer(null);
  resetPropertyPipelineClientCache();
});

afterEach(() => vi.unstubAllGlobals());

describe("public property lead vs. mid-flight sign-in", () => {
  it("still resolves the listing when sign-in hydration lands while the lead fetch is in flight", async () => {
    const deferred = deferredResponse();
    vi.stubGlobal("fetch", vi.fn(() => deferred.promise));

    const pending = loadPublicPropertyLeadFromServer("night-flow-proof-house");

    // Sign-in completes WHILE the request above is still in flight — this is
    // exactly what bumps the catalog generation mid-request.
    setPortalSessionViewer("night-flow-1");

    deferred.resolve(jsonResponse({ property: listing("night-flow-proof-house") }));
    await pending;

    // The synchronous reader every tour/apply page actually renders from.
    expect(getPropertyForPublicLink("night-flow-proof-house")?.id).toBe("night-flow-proof-house");
  });

  it("still caches a public lead across a workspace switch mid-flight", async () => {
    const deferred = deferredResponse();
    vi.stubGlobal("fetch", vi.fn(() => deferred.promise));
    setPortalSessionViewer("night-flow-1");

    const pending = loadPublicPropertyLeadFromServer("other-listing");
    resetPropertyPipelineClientCache(); // simulates a workspace-selection reset mid-flight

    deferred.resolve(jsonResponse({ property: listing("other-listing") }));
    await pending;

    expect(getPropertyForPublicLink("other-listing")?.id).toBe("other-listing");
  });
});
