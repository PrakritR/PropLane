// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MockProperty } from "@/data/types";
import { setWorkspaceSelection } from "@/lib/workspaces/selection";
import { setPortalSessionViewer } from "@/lib/auth/portal-session-gate";
import {
  cachePublicExtraListings,
  clearPrivateTestWorkspaceListings,
  loadPublicExtraListingsFromServer,
  loadResidentPropertyFromServer,
  readAllExtraListings,
  PROPERTY_PIPELINE_EVENT,
  readExtraListingsPublic,
  resetPropertyPipelineClientCache,
} from "@/lib/demo-property-pipeline";

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
    rentLabel: "$1,000",
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

beforeEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/resident/services");
  setWorkspaceSelection(null);
  window.localStorage.clear();
  window.sessionStorage.clear();
  setPortalSessionViewer(null);
  resetPropertyPipelineClientCache();
  clearPrivateTestWorkspaceListings();
});

afterEach(() => vi.unstubAllGlobals());

describe("private test workspace listing catalog", () => {
  it("replaces a warmed public catalog instead of merging customer listings", async () => {
    cachePublicExtraListings([listing("public")], { silent: true });
    expect(readExtraListingsPublic().map((row) => row.id)).toEqual(["public"]);

    setPortalSessionViewer("resident-a");
    expect(readExtraListingsPublic()).toEqual([]);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      testWorkspaceId: "workspace-a",
      listings: [listing("private-a")],
    })));

    await loadPublicExtraListingsFromServer();
    expect(readExtraListingsPublic().map((row) => row.id)).toEqual(["private-a"]);
  });

  it("discards a private response that resolves after logout and another login", async () => {
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    })));

    setPortalSessionViewer("resident-a");
    const pending = loadPublicExtraListingsFromServer();
    setPortalSessionViewer(null);
    setPortalSessionViewer("resident-b");
    resolveFetch(jsonResponse({
      testWorkspaceId: "workspace-a",
      listings: [listing("private-a")],
    }));

    await pending;
    expect(readExtraListingsPublic().map((row) => row.id)).not.toContain("private-a");
  });

  it("fails closed on a denied classified catalog instead of using public cache", async () => {
    cachePublicExtraListings([listing("public")], { silent: true });
    setPortalSessionViewer("resident-a");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      error: "Not found.",
      testWorkspaceAccess: "denied",
    }, 404)));

    await expect(loadPublicExtraListingsFromServer()).resolves.toEqual([]);
    expect(readExtraListingsPublic()).toEqual([]);
  });
});

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("catalog scope transitions before classification", () => {
  it.each(["network", "500", "malformed"])("quarantines warmed extras on initial %s failure", async (failure) => {
    cachePublicExtraListings([listing("public")], { silent: true });
    setPortalSessionViewer("resident-a");
    // Even an independently warmed public writer cannot open unresolved scope.
    cachePublicExtraListings([listing("public")], { silent: true });
    expect(readExtraListingsPublic()).toEqual([]);
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (failure === "network") throw new Error("offline");
      return jsonResponse({ error: "unavailable" }, failure === "500" ? 500 : 200);
    }));
    await expect(loadPublicExtraListingsFromServer()).resolves.toEqual([]);
    expect(readExtraListingsPublic()).toEqual([]);
  });

  it("keeps an empty private success separate from normal fallback", async () => {
    setPortalSessionViewer("resident-a");
    cachePublicExtraListings([listing("public")], { silent: true });
    const fetcher = vi.fn().mockResolvedValueOnce(jsonResponse({ testWorkspaceId: "private-a", listings: [] }))
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetcher);
    await expect(loadPublicExtraListingsFromServer()).resolves.toEqual([]);
    await expect(loadPublicExtraListingsFromServer()).resolves.toEqual([]);
    expect(readExtraListingsPublic()).toEqual([]);
  });

  it("restores normal fallback only after a successful normal response and coalesces requests", async () => {
    setPortalSessionViewer("normal");
    const deferred = deferredResponse();
    const fetcher = vi.fn().mockReturnValueOnce(deferred.promise).mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetcher);
    const first = loadPublicExtraListingsFromServer();
    const joined = loadPublicExtraListingsFromServer();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(readExtraListingsPublic()).toEqual([]);
    deferred.resolve(jsonResponse({ listings: [listing("normal-public")] }));
    expect((await first).map((row) => row.id)).toEqual(["normal-public"]);
    expect((await joined).map((row) => row.id)).toEqual(["normal-public"]);
    expect((await loadPublicExtraListingsFromServer()).map((row) => row.id)).toEqual(["normal-public"]);
  });

  it("fences same-actor workspace A-to-B-to-A completions", async () => {
    setPortalSessionViewer("resident-a");
    setWorkspaceSelection({ activeWorkspaceId: "portal-a", workspaces: [] });
    const old = deferredResponse();
    const current = deferredResponse();
    const fetcher = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    vi.stubGlobal("fetch", fetcher);
    const first = loadPublicExtraListingsFromServer();
    setWorkspaceSelection({ activeWorkspaceId: "portal-b", workspaces: [] });
    setWorkspaceSelection({ activeWorkspaceId: "portal-a", workspaces: [] });
    const next = loadPublicExtraListingsFromServer();
    expect(fetcher).toHaveBeenCalledTimes(2);
    old.resolve(jsonResponse({ testWorkspaceId: "private-a", listings: [listing("stale")] }));
    await expect(first).resolves.toEqual([]);
    expect(readExtraListingsPublic()).toEqual([]);
    current.resolve(jsonResponse({ testWorkspaceId: "private-a", listings: [listing("fresh")] }));
    expect((await next).map((row) => row.id)).toEqual(["fresh"]);
  });
});

describe("resident own-property hydration isolation", () => {
  it("does not coalesce across logout/login or publish late rows/events", async () => {
    setPortalSessionViewer("resident-a");
    const old = deferredResponse();
    const current = deferredResponse();
    const fetcher = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    vi.stubGlobal("fetch", fetcher);
    const onChange = vi.fn();
    window.addEventListener(PROPERTY_PIPELINE_EVENT, onChange);
    try {
      const first = loadResidentPropertyFromServer();
      const joined = loadResidentPropertyFromServer();
      expect(fetcher).toHaveBeenCalledTimes(1);
      setPortalSessionViewer(null);
      setPortalSessionViewer("resident-b");
      const next = loadResidentPropertyFromServer();
      expect(fetcher).toHaveBeenCalledTimes(2);
      old.resolve(jsonResponse({ property: listing("private-a"), serviceRequestOptions: [] }));
      await expect(first).resolves.toBeNull();
      await expect(joined).resolves.toBeNull();
      expect(onChange).not.toHaveBeenCalled();
      current.resolve(jsonResponse({ property: listing("private-b"), serviceRequestOptions: [], managerUserId: "manager-b" }));
      expect((await next)?.property.id).toBe("private-b");
      expect(readAllExtraListings()).toEqual([]);
      setPortalSessionViewer(null);
      expect(readExtraListingsPublic()).toEqual([]);
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(PROPERTY_PIPELINE_EVENT, onChange);
    }
  });

  it("drops an own-property result after a same-actor workspace round trip", async () => {
    setPortalSessionViewer("resident-a");
    setWorkspaceSelection({ activeWorkspaceId: "portal-a", workspaces: [] });
    const pending = deferredResponse();
    vi.stubGlobal("fetch", vi.fn(() => pending.promise));
    const result = loadResidentPropertyFromServer();
    setWorkspaceSelection({ activeWorkspaceId: "portal-b", workspaces: [] });
    setWorkspaceSelection({ activeWorkspaceId: "portal-a", workspaces: [] });
    pending.resolve(jsonResponse({ property: listing("stale-private"), serviceRequestOptions: [] }));
    await expect(result).resolves.toBeNull();
    expect(readAllExtraListings()).toEqual([]);
  });
});
