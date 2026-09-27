// @vitest-environment jsdom
/**
 * Both listing CTA hooks (SMS phone, work email) read the public catalog. Each
 * used to cache it separately with no in-flight guard, so a page that mounted
 * both hooks twice downloaded the whole catalog four times on first paint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publicListingContact, resetPublicListingContactsCache } from "@/lib/public-listing-contacts";

const catalog = {
  listings: [
    { id: "mgr-a", contactSmsPhone: "+12065550100", contactWorkEmail: "a@prop-lane.space" },
    { id: "mgr-b", contactSmsPhone: "+12065550101" },
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
    expect(results[0]).toEqual({ contactSmsPhone: "+12065550100", contactWorkEmail: "a@prop-lane.space" });
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
    expect((await publicListingContact("mgr-a"))?.contactSmsPhone).toBe("+12065550100");
  });
});
