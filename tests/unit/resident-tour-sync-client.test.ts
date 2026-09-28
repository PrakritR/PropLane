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
});
