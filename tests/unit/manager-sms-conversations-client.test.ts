import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPortalSessionViewer } from "@/lib/auth/portal-session-gate";
import {
  invalidateManagerSmsConversationsClient,
  loadManagerSmsConversationsClient,
} from "@/lib/manager-sms-conversations-client";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function payload(label: string): Response {
  return Response.json({ residents: [{ conversationKey: label, messages: [] }] });
}

describe("loadManagerSmsConversationsClient", () => {
  beforeEach(() => {
    setPortalSessionViewer(null);
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    setPortalSessionViewer(null);
    vi.unstubAllGlobals();
  });

  it("coalesces simultaneous consumers while giving each an independent body", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(payload("shared"));
    setPortalSessionViewer("viewer-shared");

    const [first, second] = await Promise.all([
      loadManagerSmsConversationsClient("viewer-shared"),
      loadManagerSmsConversationsClient("viewer-shared"),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).not.toBe(second);
    await expect(first.json()).resolves.toEqual({ residents: [{ conversationKey: "shared", messages: [] }] });
    await expect(second.json()).resolves.toEqual({ residents: [{ conversationKey: "shared", messages: [] }] });
  });

  it("queues a forced caller behind an in-flight request", async () => {
    const fetchMock = vi.mocked(fetch);
    const firstResponse = deferred<Response>();
    const secondResponse = deferred<Response>();
    fetchMock.mockReturnValueOnce(firstResponse.promise).mockReturnValueOnce(secondResponse.promise);
    setPortalSessionViewer("viewer-force");

    const first = loadManagerSmsConversationsClient("viewer-force");
    const forced = loadManagerSmsConversationsClient("viewer-force", true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    firstResponse.resolve(payload("first"));
    await expect(first).resolves.toBeInstanceOf(Response);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    secondResponse.resolve(payload("second"));
    await expect(forced).resolves.toBeInstanceOf(Response);
  });

  it("keeps separate readers per workspace for the same viewer", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(payload("ws-a"))
      .mockResolvedValueOnce(payload("ws-b"));
    setPortalSessionViewer("viewer-ws");

    const first = await loadManagerSmsConversationsClient("viewer-ws", false, "ws-a");
    const second = await loadManagerSmsConversationsClient("viewer-ws", false, "ws-b");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(first.json()).resolves.toEqual({ residents: [{ conversationKey: "ws-a", messages: [] }] });
    await expect(second.json()).resolves.toEqual({ residents: [{ conversationKey: "ws-b", messages: [] }] });
  });

  it("clears readers when the portal viewer changes", async () => {
    const fetchMock = vi.mocked(fetch);
    const firstResponse = deferred<Response>();
    fetchMock.mockReturnValueOnce(firstResponse.promise).mockResolvedValueOnce(payload("new-reader"));
    setPortalSessionViewer("viewer-before");

    const oldReader = loadManagerSmsConversationsClient("viewer-before");
    setPortalSessionViewer("viewer-after");
    const newReader = loadManagerSmsConversationsClient("viewer-before");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    firstResponse.resolve(payload("old-reader"));
    await expect(oldReader).resolves.toBeInstanceOf(Response);
    await expect(newReader).resolves.toBeInstanceOf(Response);
  });

  // Night QA finding #7: /api/manager/sms-conversations landed in the
  // top-5-slowest calls on 7 of 10 manager routes because the mount-time
  // read plus the 60s nav-count poll (and any other reader) each started a
  // brand-new fetch the instant the previous one settled — the coalesced
  // refresher only dedupes CONCURRENT callers, with no TTL of its own.
  it("serves an unforced caller inside the TTL window from the last response without a new fetch", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(payload("ttl-a"));
    setPortalSessionViewer("viewer-ttl");

    const first = await loadManagerSmsConversationsClient("viewer-ttl");
    const second = await loadManagerSmsConversationsClient("viewer-ttl");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(second.json()).resolves.toEqual({ residents: [{ conversationKey: "ttl-a", messages: [] }] });
    expect(first === second).toBe(false);
  });

  it("force always starts a fresh fetch even inside the TTL window", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(payload("ttl-a")).mockResolvedValueOnce(payload("ttl-b"));
    setPortalSessionViewer("viewer-ttl-force");

    await loadManagerSmsConversationsClient("viewer-ttl-force");
    const forced = await loadManagerSmsConversationsClient("viewer-ttl-force", true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(forced.json()).resolves.toEqual({ residents: [{ conversationKey: "ttl-b", messages: [] }] });
  });

  it("an explicit invalidate forces the next call to fetch fresh, TTL notwithstanding", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(payload("ttl-a")).mockResolvedValueOnce(payload("ttl-b"));
    setPortalSessionViewer("viewer-ttl-invalidate");

    await loadManagerSmsConversationsClient("viewer-ttl-invalidate");
    invalidateManagerSmsConversationsClient("viewer-ttl-invalidate");
    await loadManagerSmsConversationsClient("viewer-ttl-invalidate");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caches each cursor separately and invalidates every page for one workspace", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(payload("head"))
      .mockResolvedValueOnce(payload("older-a"))
      .mockResolvedValueOnce(payload("older-b"))
      .mockResolvedValueOnce(payload("fresh-a"));
    setPortalSessionViewer("viewer-pages");

    await loadManagerSmsConversationsClient("viewer-pages", false, "workspace-a");
    await loadManagerSmsConversationsClient("viewer-pages", false, "workspace-a", "cursor-a");
    await loadManagerSmsConversationsClient("viewer-pages", false, "workspace-a", "cursor-b");
    const cached = await loadManagerSmsConversationsClient("viewer-pages", false, "workspace-a", "cursor-a");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/manager/sms-conversations?before=cursor-a", expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/manager/sms-conversations?before=cursor-b", expect.anything());
    await expect(cached.json()).resolves.toEqual({ residents: [{ conversationKey: "older-a", messages: [] }] });

    invalidateManagerSmsConversationsClient("viewer-pages", "workspace-a");
    const fresh = await loadManagerSmsConversationsClient("viewer-pages", false, "workspace-a", "cursor-a");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await expect(fresh.json()).resolves.toEqual({ residents: [{ conversationKey: "fresh-a", messages: [] }] });
  });
});
