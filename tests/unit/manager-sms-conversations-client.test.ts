import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPortalSessionViewer } from "@/lib/auth/portal-session-gate";
import { loadManagerSmsConversationsClient } from "@/lib/manager-sms-conversations-client";

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
});
