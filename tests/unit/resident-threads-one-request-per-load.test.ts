// @vitest-environment jsdom
/**
 * Browser-proof item (7): the resident Communication load asked
 * `/api/portal-inbox-threads?scope=resident` three times. The readers on one load arrive
 * before any of them has settled — the Communication shell, each panel mount, and
 * `retryWhileStale` after a read was discarded as belonging to the previous viewer — so the
 * module's own 15s TTL could not collapse them and `ttlMs: 0` left `sharedGet` able to join
 * only requests already in flight.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));

const URL_THREADS = "/api/portal-inbox-threads?scope=axis_portal_inbox_resident_v1";

function stubFetch(calls: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return {
        ok: true,
        status: 200,
        json: async () => ({ rows: [] }),
      } as unknown as Response;
    }),
  );
}

describe("the resident thread list on one page load", () => {
  beforeEach(() => {
    vi.resetModules();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("answers sequential readers from one request", async () => {
    const calls: string[] = [];
    stubFetch(calls);
    const { RESIDENT_INBOX_STORAGE_KEY, syncPersistedInboxFromServerWithStatus } = await import(
      "@/lib/portal-inbox-storage"
    );
    const { setPortalSessionViewer } = await import("@/lib/auth/portal-session-gate");
    setPortalSessionViewer("resident-1");

    // The shell, then a panel mount, then a second panel mount — one after another, which
    // is what the three observed requests were.
    const first = await syncPersistedInboxFromServerWithStatus(RESIDENT_INBOX_STORAGE_KEY);
    const second = await syncPersistedInboxFromServerWithStatus(RESIDENT_INBOX_STORAGE_KEY);
    const third = await syncPersistedInboxFromServerWithStatus(RESIDENT_INBOX_STORAGE_KEY);

    expect([first.ok, second.ok, third.ok]).toEqual([true, true, true]);
    expect(calls.filter((url) => url.startsWith(URL_THREADS))).toHaveLength(1);
  });

  it("collapses a stale retry instead of asking again per attempt", async () => {
    const calls: string[] = [];
    stubFetch(calls);
    const { RESIDENT_INBOX_STORAGE_KEY, retryWhileStale, syncPersistedInboxFromServerWithStatus } =
      await import("@/lib/portal-inbox-storage");
    const { setPortalSessionViewer } = await import("@/lib/auth/portal-session-gate");
    setPortalSessionViewer("resident-1");

    await retryWhileStale(() => syncPersistedInboxFromServerWithStatus(RESIDENT_INBOX_STORAGE_KEY));
    await retryWhileStale(() => syncPersistedInboxFromServerWithStatus(RESIDENT_INBOX_STORAGE_KEY));

    expect(calls.filter((url) => url.startsWith(URL_THREADS))).toHaveLength(1);
  });

  it("a forced read after a write still asks the server", async () => {
    const calls: string[] = [];
    stubFetch(calls);
    const { RESIDENT_INBOX_STORAGE_KEY, syncPersistedInboxFromServerWithStatus } = await import(
      "@/lib/portal-inbox-storage"
    );
    const { setPortalSessionViewer } = await import("@/lib/auth/portal-session-gate");
    setPortalSessionViewer("resident-1");

    await syncPersistedInboxFromServerWithStatus(RESIDENT_INBOX_STORAGE_KEY);
    await syncPersistedInboxFromServerWithStatus(RESIDENT_INBOX_STORAGE_KEY, { force: true });

    expect(calls.filter((url) => url.startsWith(URL_THREADS))).toHaveLength(2);
  });

  it("never answers one workspace's reader from another workspace's read", async () => {
    // The route lists a different set of conversations per active workspace (it resolves the
    // workspace server-side), and `sharedGet` is only reset when the ACCOUNT changes — so the
    // workspace has to be part of the URL or a switch inside the TTL serves the old rows.
    const calls: string[] = [];
    stubFetch(calls);
    const { MANAGER_INBOX_STORAGE_KEY, syncPersistedInboxFromServerWithStatus } = await import(
      "@/lib/portal-inbox-storage"
    );
    const { setPortalSessionViewer } = await import("@/lib/auth/portal-session-gate");
    const { setWorkspaceSelection } = await import("@/lib/workspaces/selection");
    setPortalSessionViewer("manager-1");

    const workspace = (id: string) => ({
      activeWorkspaceId: id,
      workspaces: [
        { id: "ws-a", name: "A", ownerUserId: "manager-1", isDefault: true },
        { id: "ws-b", name: "B", ownerUserId: "manager-1", isDefault: false },
      ],
    });

    setWorkspaceSelection(workspace("ws-a") as never);
    await syncPersistedInboxFromServerWithStatus(MANAGER_INBOX_STORAGE_KEY);
    setWorkspaceSelection(workspace("ws-b") as never);
    await syncPersistedInboxFromServerWithStatus(MANAGER_INBOX_STORAGE_KEY);

    const threadReads = calls.filter((url) => url.startsWith("/api/portal-inbox-threads"));
    expect(threadReads).toHaveLength(2);
    expect(threadReads[0]).toContain("workspaceId=ws-a");
    expect(threadReads[1]).toContain("workspaceId=ws-b");
    // ...and the second workspace still shares one request among its own readers.
    await syncPersistedInboxFromServerWithStatus(MANAGER_INBOX_STORAGE_KEY);
    expect(calls.filter((url) => url.startsWith("/api/portal-inbox-threads"))).toHaveLength(2);
    setWorkspaceSelection(null);
  });

  it("never answers one account's reader from another account's read", async () => {
    const calls: string[] = [];
    stubFetch(calls);
    const { RESIDENT_INBOX_STORAGE_KEY, syncPersistedInboxFromServerWithStatus } = await import(
      "@/lib/portal-inbox-storage"
    );
    const { setPortalSessionViewer } = await import("@/lib/auth/portal-session-gate");

    setPortalSessionViewer("resident-1");
    await syncPersistedInboxFromServerWithStatus(RESIDENT_INBOX_STORAGE_KEY);
    setPortalSessionViewer("resident-2");
    await syncPersistedInboxFromServerWithStatus(RESIDENT_INBOX_STORAGE_KEY);

    expect(calls.filter((url) => url.startsWith(URL_THREADS))).toHaveLength(2);
  });
});

describe("the resident inbox panel's own mount read", () => {
  it("waits for the session, so it does not spend a request that will be discarded", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/components/portal/resident-inbox-panel.tsx", "utf8");
    const mount = source.slice(source.indexOf("persistInboxRef.current = false;") - 400);
    const effect = mount.slice(0, mount.indexOf("syncPersistedInboxFromServer(RESIDENT_INBOX_STORAGE_KEY)"));
    expect(effect).toContain("if (!session.ready) return;");
  });
});
