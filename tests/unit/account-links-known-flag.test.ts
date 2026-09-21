// @vitest-environment jsdom
/**
 * "Do we know this account's co-manager links?" must never be answered `true`
 * over a cache a failed fetch just emptied.
 *
 * The cache starts `{ invites: [] }`, which reads identically to "fetched, and
 * this account co-manages nothing" — and `pro-properties` acts on that: an empty
 * portfolio it believes is a FACT gets a first-listing draft seeded and the
 * create-listing wizard opened. A co-manager whose links GET fails on this mount
 * (their three houses live on the owner's row) used to get exactly that, because
 * the failure wiped the payload while leaving the known flag set by an earlier
 * success.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const INVITE = {
  id: "inv-1",
  inviterUserId: "owner-1",
  assignedPropertyIds: ["prop-1"],
};

/** Fresh module state per test: the known flag is module-level by design. */
async function loadStore() {
  vi.resetModules();
  return import("@/lib/portal-data-store");
}

function respond(body: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, json: async () => body })),
  );
}

function throwOnFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("offline");
    }),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("accountLinksKnown", () => {
  it("is false before anything has landed, even though the cache looks empty", async () => {
    const store = await loadStore();
    expect(store.accountLinksKnown()).toBe(false);
    expect(store.readCachedAccountLinkInvites()).toEqual([]);
  });

  it("is true after a successful fetch", async () => {
    const store = await loadStore();
    respond({ invites: [INVITE] });
    await store.fetchAccountLinksCached();
    expect(store.accountLinksKnown()).toBe(true);
    expect(store.readCachedAccountLinkInvites()).toHaveLength(1);
  });

  it("drops back to false when a later fetch is refused, keeping the known invites", async () => {
    const store = await loadStore();
    respond({ invites: [INVITE] });
    await store.fetchAccountLinksCached();
    expect(store.accountLinksKnown()).toBe(true);

    store.invalidateAccountLinksCache();
    respond({ error: "nope" }, false);
    const body = await store.fetchAccountLinksCached();

    // The whole point: this must not read as "this account co-manages nothing".
    expect(store.accountLinksKnown()).toBe(false);
    expect(body.migrationRequired).toBe(true);
    // The last real answer still gates co-manager property access.
    expect(store.readCachedAccountLinkInvites()).toHaveLength(1);
  });

  it("drops back to false when the fetch throws", async () => {
    const store = await loadStore();
    respond({ invites: [INVITE] });
    await store.fetchAccountLinksCached();

    store.invalidateAccountLinksCache();
    throwOnFetch();
    await store.fetchAccountLinksCached();
    expect(store.accountLinksKnown()).toBe(false);
  });

  it("treats a malformed payload as ignorance, not an empty list", async () => {
    const store = await loadStore();
    respond({ invites: [INVITE] });
    await store.fetchAccountLinksCached();

    store.invalidateAccountLinksCache();
    respond({ invites: "not-an-array" });
    await store.fetchAccountLinksCached();
    expect(store.accountLinksKnown()).toBe(false);
    expect(store.readCachedAccountLinkInvites()).toHaveLength(1);
  });

  it("retries on the next call instead of serving the failure for the whole TTL", async () => {
    const store = await loadStore();
    respond({ error: "nope" }, false);
    await store.fetchAccountLinksCached();
    expect(store.accountLinksKnown()).toBe(false);

    respond({ invites: [INVITE] });
    await store.fetchAccountLinksCached();
    expect(store.accountLinksKnown()).toBe(true);
    expect(store.readCachedAccountLinkInvites()).toHaveLength(1);
  });
});
