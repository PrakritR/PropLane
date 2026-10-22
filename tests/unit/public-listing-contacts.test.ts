// @vitest-environment jsdom
/**
 * The listing work-email hook reads the public catalog through one TTL cache with an in-flight guard: the
 * hooks used to cache it separately, so a page that mounted both twice downloaded the whole catalog four
 * times on first paint. The catalog carries no phone number any more, so neither does this projection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publicListingContact, resetPublicListingContactsCache } from "@/lib/public-listing-contacts";

const catalog = {
  listings: [
    { id: "mgr-a", contactWorkEmail: "a@prop-lane.space" },
    { id: "mgr-b" },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetPublicListingContactsCache();
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => catalog }) as unknown as Response);
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("public listing contacts", () => {
  it("serves every concurrent caller from one catalog read", async () => {
    const results = await Promise.all([
      publicListingContact("mgr-a"),
      publicListingContact("mgr-a"),
      publicListingContact("mgr-b"),
      publicListingContact("mgr-missing"),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results[0]).toEqual({ contactWorkEmail: "a@prop-lane.space" });
    expect(results[0]).not.toHaveProperty("contactSmsPhone");
    expect(results[2]?.contactWorkEmail).toBeUndefined();
    expect(results[3]).toBeNull();
  });

  it("re-reads after the cache expires, and retries after a failed read", async () => {
    vi.useFakeTimers();
    await publicListingContact("mgr-a");
    vi.advanceTimersByTime(56_000);
    await publicListingContact("mgr-a");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    resetPublicListingContactsCache();
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response);
    expect(await publicListingContact("mgr-a")).toBeNull();
    expect((await publicListingContact("mgr-a"))?.contactWorkEmail).toBe("a@prop-lane.space");
  });
});
