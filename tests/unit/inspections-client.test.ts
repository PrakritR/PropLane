// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));
vi.mock("@/lib/portal-document-download", () => ({ downloadBlobFile: vi.fn() }));
const fetcher = vi.fn();
beforeEach(() => { vi.resetModules(); vi.stubGlobal("fetch", fetcher); fetcher.mockReset(); });
afterEach(() => vi.unstubAllGlobals());
const response = (id: string) => ({ ok: true, json: async () => ({ reports: [{ id }], residencies: [] }) });
describe("inspection scoped caching", () => {
  it("deduplicates repeated reads, but isolates viewers, roles and residencies", async () => {
    const { loadInspectionList } = await import("@/lib/inspections/client");
    fetcher.mockImplementation(async () => response(String(fetcher.mock.calls.length)));
    const [a, b] = await Promise.all([loadInspectionList("a", "manager", "one"), loadInspectionList("a", "manager", "one")]);
    expect(a).toEqual(b); expect(fetcher).toHaveBeenCalledTimes(1);
    await loadInspectionList("a", "manager", "one"); expect(fetcher).toHaveBeenCalledTimes(1);
    await loadInspectionList("b", "manager", "one"); await loadInspectionList("a", "resident", "one"); await loadInspectionList("a", "manager", "two");
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("queues one fresh request for concurrent forced post-write refreshes", async () => {
    const { loadInspectionList } = await import("@/lib/inspections/client");
    let release!: (result: ReturnType<typeof response>) => void;
    fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue(response("fresh"));
    const original = loadInspectionList("a", "manager");
    const forced = [loadInspectionList("a", "manager", undefined, true), loadInspectionList("a", "manager", undefined, true)];
    expect(fetcher).toHaveBeenCalledTimes(1); release(response("old"));
    expect((await original).reports[0]?.id).toBe("old");
    for (const result of await Promise.all(forced)) expect(result.reports[0]?.id).toBe("fresh");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not cache failures and invalidates a saved list after a successful write", async () => {
    const { loadInspectionList, inspectionRequest } = await import("@/lib/inspections/client");
    fetcher.mockResolvedValueOnce({ ok: false, json: async () => ({ error: "Failed read" }) }).mockResolvedValue(response("saved"));
    await expect(loadInspectionList("a", "manager")).rejects.toThrow("Failed read");
    await loadInspectionList("a", "manager"); expect(fetcher).toHaveBeenCalledTimes(2);
    await inspectionRequest("manager", "", { method: "POST", body: "{}" });
    await loadInspectionList("a", "manager"); expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
