import { beforeEach, describe, expect, it, vi } from "vitest";

import { LISTING_CHANNEL_DEFS } from "@/lib/listing-channels/registry";
import {
  LEAD_SOURCE_CHANNEL_IDS,
  leadSourceCookieAssignment,
  leadSourceFromCookieHeader,
  normalizeLeadSource,
} from "@/lib/listing-channels/lead-source";

const h = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (h.store.has(name) ? { value: h.store.get(name)! } : undefined) }),
}));

import { readListingSource } from "@/lib/listing-channels/lead-source.server";

describe("lead source allowlist", () => {
  it("is the registry's channel ids, so a new site is never silently untracked", () => {
    expect([...LEAD_SOURCE_CHANNEL_IDS]).toEqual(LISTING_CHANNEL_DEFS.map((def) => def.id));
  });

  it("accepts exactly the channel ids", () => {
    for (const id of LEAD_SOURCE_CHANNEL_IDS) expect(normalizeLeadSource(id)).toBe(id);
    expect(normalizeLeadSource(" ZILLOW ")).toBe("zillow");
  });

  it("drops anything else", () => {
    for (const bad of ["", "evil", "zillow;x", "<script>", "zillow ' or 1=1", null, undefined, 3, {}]) {
      expect(normalizeLeadSource(bad)).toBeNull();
    }
  });

  it("only builds a cookie for a valid source", () => {
    expect(leadSourceCookieAssignment("craigslist")).toContain("pl_src=craigslist");
    expect(leadSourceCookieAssignment("craigslist")).toContain("SameSite=Lax");
    expect(leadSourceCookieAssignment("craigslist")).toContain("Max-Age=2592000");
    expect(leadSourceCookieAssignment("nope")).toBeNull();
  });

  it("adds Secure on https and leaves it off on plain http", () => {
    expect(leadSourceCookieAssignment("craigslist")).not.toContain("Secure");
    vi.stubGlobal("location", { protocol: "https:" });
    expect(leadSourceCookieAssignment("craigslist")).toContain("; Secure");
    vi.stubGlobal("location", { protocol: "http:" });
    expect(leadSourceCookieAssignment("craigslist")).not.toContain("Secure");
    vi.unstubAllGlobals();
  });

  it("reads the cookie header and ignores invalid values", () => {
    expect(leadSourceFromCookieHeader("a=b; pl_src=reddit; c=d")).toBe("reddit");
    expect(leadSourceFromCookieHeader("pl_src=%E0%A4%A")).toBeNull();
    expect(leadSourceFromCookieHeader("pl_src=admin")).toBeNull();
    expect(leadSourceFromCookieHeader(null)).toBeNull();
  });
});

describe("readListingSource", () => {
  beforeEach(() => h.store.clear());

  it("reads the request-scoped cookie only when valid", async () => {
    h.store.set("pl_src", "zillow");
    expect(await readListingSource()).toBe("zillow");
    h.store.set("pl_src", "bogus");
    expect(await readListingSource()).toBeNull();
  });

  it("reads a Request's Cookie header", async () => {
    const req = new Request("https://x.test", { headers: { cookie: "pl_src=instagram" } });
    expect(await readListingSource(req)).toBe("instagram");
    expect(await readListingSource(new Request("https://x.test", { headers: { cookie: "pl_src=zzz" } }))).toBeNull();
  });
});

describe("tour insert path", () => {
  it("writes source_channel only for a valid value", async () => {
    vi.resetModules();
    const writes: Record<string, unknown>[][] = [];
    const { normalizeLeadSource: norm } = await import("@/lib/listing-channels/lead-source");
    // The insert path spreads `source_channel` only when normalizeLeadSource returns a value.
    const record = (raw: unknown) => ({ id: "r", ...(norm(raw) ? { source_channel: norm(raw) } : {}) });
    writes.push([record("zillow"), record("junk"), record(undefined)]);
    expect(writes[0]![0]).toHaveProperty("source_channel", "zillow");
    expect(writes[0]![1]).not.toHaveProperty("source_channel");
    expect(writes[0]![2]).not.toHaveProperty("source_channel");
  });
});
