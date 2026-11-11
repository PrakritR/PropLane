// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { readWorkspacePayloadCache, writeWorkspacePayloadCache, WORKSPACE_PAYLOAD_CACHE_KEY } from "@/lib/workspaces/payload-cache";
import type { WorkspacePayload } from "@/lib/workspaces/types";

const payload = { workspaces: [{ id: "w1", name: "Homes" }], activeWorkspaceId: "w1" } as unknown as WorkspacePayload;

beforeEach(() => window.sessionStorage.clear());

describe("workspace warm-start cache", () => {
  it("returns what the same account saved, and nothing to another account", () => {
    writeWorkspacePayloadCache("user-a", payload);
    expect(readWorkspacePayloadCache("user-a")).toEqual(payload);
    expect(readWorkspacePayloadCache("user-b")).toBeNull();
    expect(readWorkspacePayloadCache(null)).toBeNull();
  });

  it("never stores an empty list, and ignores a corrupt entry", () => {
    writeWorkspacePayloadCache("user-a", { workspaces: [], activeWorkspaceId: null } as WorkspacePayload);
    expect(window.sessionStorage.getItem(WORKSPACE_PAYLOAD_CACHE_KEY)).toBeNull();
    window.sessionStorage.setItem(WORKSPACE_PAYLOAD_CACHE_KEY, "{not json");
    expect(readWorkspacePayloadCache("user-a")).toBeNull();
  });

  it("uses a key the portal cache clear removes on sign-out", async () => {
    const { clearPortalBrowserCache } = await import("@/lib/auth/clear-portal-browser-cache");
    writeWorkspacePayloadCache("user-a", payload);
    clearPortalBrowserCache();
    expect(readWorkspacePayloadCache("user-a")).toBeNull();
  });
});
