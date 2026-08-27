/**
 * How a shared lease PDF reaches a viewer.
 *
 * It used to travel inside the viewer's JSON as a base64 `data:` URL: ~33% larger than the bytes,
 * uncacheable, and re-sent in full on every page load. A multi-MB lease shared with a handful of
 * people is then a measurable egress cost on the free plan, paid repeatedly for a document that
 * never changes.
 *
 * It now comes from the token's own `/pdf` endpoint. The caching shape is chosen around
 * REVOCATION, not hit rate: a long `max-age` would keep serving a withdrawn lease out of the
 * viewer's own cache with nothing able to reach it, so the browser revalidates every time and an
 * unchanged document returns an empty 304 instead of megabytes.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const resolveToken = vi.fn();
const loadBytes = vi.fn();

vi.mock("@/lib/portal-record-share-links.server", () => ({
  resolvePortalRecordShareToken: (...args: unknown[]) => resolveToken(...args),
}));
vi.mock("@/lib/portal-record-share-payload.server", () => ({
  loadSharedLeasePdfBytes: (...args: unknown[]) => loadBytes(...args),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));

const { GET } = await import("@/app/api/share/leases/[token]/pdf/route");

const PDF = Buffer.from("%PDF-1.7 pretend lease bytes");
const ctx = { params: Promise.resolve({ token: "tok-abc" }) };
const req = (headers: Record<string, string> = {}) =>
  new Request("https://prop-lane.space/api/share/leases/tok-abc/pdf", { headers });

beforeEach(() => {
  resolveToken.mockReset();
  loadBytes.mockReset();
  resolveToken.mockResolvedValue({
    link: { recordKind: "lease", recordId: "lease-1" },
    recordOwnerUserId: "mgr-1",
  });
  loadBytes.mockResolvedValue(PDF);
});

describe("serving the bytes", () => {
  it("returns the PDF binary, not a base64 payload", async () => {
    const res = await GET(req(), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(Buffer.from(await res.arrayBuffer()).equals(PDF)).toBe(true);
  });

  it("refuses to let a browser re-sniff the content type", async () => {
    const res = await GET(req(), ctx);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("scopes the read to the manager the link resolved to", async () => {
    await GET(req(), ctx);
    expect(loadBytes).toHaveBeenCalledWith(expect.anything(), "lease-1", {
      recordOwnerUserId: "mgr-1",
    });
  });
});

describe("caching, and why it is shaped this way", () => {
  it("makes the browser revalidate rather than serving a withdrawn lease from cache", async () => {
    const res = await GET(req(), ctx);
    const cache = res.headers.get("Cache-Control") ?? "";
    expect(cache).toContain("no-cache");
    // `private` keeps a tenancy document out of any shared or CDN cache — the URL is the only
    // credential in front of it.
    expect(cache).toContain("private");
    expect(cache).not.toMatch(/max-age=[1-9]/);
  });

  it("answers an unchanged document with an empty 304", async () => {
    const first = await GET(req(), ctx);
    const etag = first.headers.get("ETag");
    expect(etag).toBeTruthy();

    const second = await GET(req({ "if-none-match": etag! }), ctx);
    expect(second.status).toBe(304);
    expect((await second.arrayBuffer()).byteLength).toBe(0);
  });

  it("changes the ETag when the document changes, so a stale copy is not served", async () => {
    const first = await GET(req(), ctx);
    loadBytes.mockResolvedValue(Buffer.from("%PDF-1.7 a different lease"));
    const second = await GET(req(), ctx);
    expect(second.headers.get("ETag")).not.toBe(first.headers.get("ETag"));
  });
});

describe("what it refuses", () => {
  it("404s an expired or unknown token", async () => {
    resolveToken.mockResolvedValue(null);
    expect((await GET(req(), ctx)).status).toBe(404);
  });

  it("404s a token minted for a different kind of record", async () => {
    // An application token must not reach the lease bytes.
    resolveToken.mockResolvedValue({
      link: { recordKind: "application", recordId: "app-1" },
      recordOwnerUserId: "mgr-1",
    });
    expect((await GET(req(), ctx)).status).toBe(404);
  });

  it("404s rather than serving something that is not a PDF", async () => {
    // `row_data` is writable by the row's own resident, so an unrecognised value is refused
    // rather than decoded and served under a PDF content type.
    loadBytes.mockResolvedValue(null);
    expect((await GET(req(), ctx)).status).toBe(404);
  });

  it("does not leak an internal error message to an unauthenticated caller", async () => {
    loadBytes.mockRejectedValue(new Error("supabase: connection string refused"));
    const res = await GET(req(), ctx);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("connection string");
  });
});
