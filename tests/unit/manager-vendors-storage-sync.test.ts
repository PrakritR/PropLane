// @vitest-environment jsdom
// @vitest-environment-options {"url": "http://localhost/portal/vendors"}
/**
 * Night QA finding #6: /portal/vendors showed "Loading records…" for 5-9s.
 * The mount effect fired a throwaway probe fetch to /api/portal-vendors just
 * to check res.ok, then a second, independent fetch (syncManagerVendorsFromServer)
 * to actually load the data — the same GET, back to back. This covers the fix:
 * syncManagerVendorsFromServerDetailed does the ONE fetch the panel needs and
 * still reports success/failure, so the panel no longer needs its own probe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("syncManagerVendorsFromServerDetailed", () => {
  beforeEach(() => {
    vi.resetModules();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("makes exactly one network request and reports ok: true on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ rows: [{ id: "v1", name: "Roto-Rooter", active: true }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { syncManagerVendorsFromServerDetailed } = await import("@/lib/manager-vendors-storage");

    const result = await syncManagerVendorsFromServerDetailed({ force: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.rows.map((r) => r.id)).toEqual(["v1"]);
  });

  it("reports ok: false (without throwing) when the request fails, so the caller can show an error state", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    const { syncManagerVendorsFromServerDetailed } = await import("@/lib/manager-vendors-storage");

    const result = await syncManagerVendorsFromServerDetailed({ force: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.rows).toEqual([]);
  });

  it("syncManagerVendorsFromServer (the plain rows-only variant) still makes just one request", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ rows: [{ id: "v1", name: "Roto-Rooter", active: true }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { syncManagerVendorsFromServer } = await import("@/lib/manager-vendors-storage");

    const rows = await syncManagerVendorsFromServer({ force: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rows.map((r) => r.id)).toEqual(["v1"]);
  });
});
