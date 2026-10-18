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
