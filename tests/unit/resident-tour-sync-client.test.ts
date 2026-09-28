import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadResidentToursForViewer,
  notifyResidentToursChanged,
  residentToursViewerKey,
  RESIDENT_TOURS_CHANGED_EVENT,
} from "@/lib/resident-tour-sync-client";

function response(tours: Array<{ inquiryId: string }>) {
  return { ok: true, json: async () => ({ tours }) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("resident tour client sync", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shares one in-flight read for the same viewer and caches the fresh result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([{ inquiryId: "tour-a" }]));
    vi.stubGlobal("fetch", fetchMock);

    const first = loadResidentToursForViewer("viewer-a", "a@example.com");
    const second = loadResidentToursForViewer("viewer-a", "A@example.com");
    await expect(Promise.all([first, second])).resolves.toEqual([
      [{ inquiryId: "tour-a" }],
      [{ inquiryId: "tour-a" }],
    ]);
    await loadResidentToursForViewer("viewer-a", "a@example.com");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps cached rows separate when the viewer or email changes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response([{ inquiryId: "viewer-a-tour" }]))
      .mockResolvedValueOnce(response([{ inquiryId: "viewer-b-tour" }]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadResidentToursForViewer("viewer-a", "shared@example.com")).resolves.toEqual([
      { inquiryId: "viewer-a-tour" },
    ]);
    await expect(loadResidentToursForViewer("viewer-b", "shared@example.com")).resolves.toEqual([
      { inquiryId: "viewer-b-tour" },
    ]);
    expect(residentToursViewerKey("viewer-a", "same@example.com")).not.toBe(
      residentToursViewerKey("viewer-a", "other@example.com"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache a malformed response and retries on the next read", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => { throw new Error("bad JSON"); } })
      .mockResolvedValueOnce(response([]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadResidentToursForViewer("viewer-c", "c@example.com")).resolves.toBeNull();
    await expect(loadResidentToursForViewer("viewer-c", "c@example.com")).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("forces a post-write read and announces the scoped cache invalidation event", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response([{ inquiryId: "before" }]))
      .mockResolvedValueOnce(response([{ inquiryId: "after" }]));
    vi.stubGlobal("fetch", fetchMock);
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });

    await loadResidentToursForViewer("viewer-d", "d@example.com");
    notifyResidentToursChanged();
    await expect(loadResidentToursForViewer("viewer-d", "d@example.com", true)).resolves.toEqual([
      { inquiryId: "after" },
    ]);

    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: RESIDENT_TOURS_CHANGED_EVENT }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("queues a post-invalidation read when the pre-write response is still in flight", async () => {
    const stale = deferred<ReturnType<typeof response>>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(response([{ inquiryId: "fresh" }]));
    vi.stubGlobal("fetch", fetchMock);

    const beforeWrite = loadResidentToursForViewer("viewer-e", "e@example.com");
    notifyResidentToursChanged();
    const afterWrite = loadResidentToursForViewer("viewer-e", "e@example.com");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    stale.resolve(response([{ inquiryId: "stale" }]));
    await expect(beforeWrite).resolves.toBeNull();
    await expect(afterWrite).resolves.toEqual([{ inquiryId: "fresh" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("starts a fresh read when returning after the stale response settled", async () => {
    const stale = deferred<ReturnType<typeof response>>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(response([{ inquiryId: "fresh-after-return" }]));
    vi.stubGlobal("fetch", fetchMock);

    const beforeWrite = loadResidentToursForViewer("viewer-f", "f@example.com");
    notifyResidentToursChanged();
    stale.resolve(response([{ inquiryId: "stale-before-return" }]));
    await expect(beforeWrite).resolves.toBeNull();

    await expect(loadResidentToursForViewer("viewer-f", "f@example.com")).resolves.toEqual([
      { inquiryId: "fresh-after-return" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("coalesces repeated invalidations and readers onto one post-write request", async () => {
    const stale = deferred<ReturnType<typeof response>>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(response([{ inquiryId: "fresh-once" }]));
    vi.stubGlobal("fetch", fetchMock);

    const beforeWrite = loadResidentToursForViewer("viewer-g", "g@example.com");
    notifyResidentToursChanged();
    notifyResidentToursChanged();
    const firstReader = loadResidentToursForViewer("viewer-g", "g@example.com");
    const secondReader = loadResidentToursForViewer("viewer-g", "G@example.com");

    stale.resolve(response([{ inquiryId: "stale" }]));
    await expect(beforeWrite).resolves.toBeNull();
    await expect(Promise.all([firstReader, secondReader])).resolves.toEqual([
      [{ inquiryId: "fresh-once" }],
      [{ inquiryId: "fresh-once" }],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves forced-caller coalescing across an invalidated in-flight read", async () => {
    const stale = deferred<ReturnType<typeof response>>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(response([{ inquiryId: "forced-fresh" }]));
    vi.stubGlobal("fetch", fetchMock);

    const beforeWrite = loadResidentToursForViewer("viewer-h", "h@example.com");
    notifyResidentToursChanged();
    const forcedOne = loadResidentToursForViewer("viewer-h", "h@example.com", true);
    const forcedTwo = loadResidentToursForViewer("viewer-h", "h@example.com", true);

    stale.resolve(response([{ inquiryId: "forced-stale" }]));
    await expect(beforeWrite).resolves.toBeNull();
    await expect(Promise.all([forcedOne, forcedTwo])).resolves.toEqual([
      [{ inquiryId: "forced-fresh" }],
      [{ inquiryId: "forced-fresh" }],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries after a failed post-invalidation follow-up", async () => {
    const stale = deferred<ReturnType<typeof response>>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce(response([{ inquiryId: "retry-fresh" }]));
    vi.stubGlobal("fetch", fetchMock);

    const beforeWrite = loadResidentToursForViewer("viewer-i", "i@example.com");
    notifyResidentToursChanged();
    const failedFollowUp = loadResidentToursForViewer("viewer-i", "i@example.com");
    stale.resolve(response([{ inquiryId: "stale" }]));

    await expect(beforeWrite).resolves.toBeNull();
    await expect(failedFollowUp).resolves.toBeNull();
    await expect(loadResidentToursForViewer("viewer-i", "i@example.com")).resolves.toEqual([
      { inquiryId: "retry-fresh" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
