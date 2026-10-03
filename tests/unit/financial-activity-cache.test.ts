import { afterEach, expect, it, vi } from "vitest";
import { invalidateFinancialActivity, loadFinancialActivity } from "@/lib/financial-activity-cache";
vi.mock("@/lib/workspaces/selection", () => ({ selectedWorkspaceId: () => "workspace-a" }));
afterEach(() => vi.unstubAllGlobals());
it("shares in-flight and fresh reads, but separates accounts and property scopes", async () => {
  const fetcher = vi.fn(async () => Response.json({ rows: [] }));
  vi.stubGlobal("fetch", fetcher);
  await Promise.all([loadFinancialActivity("cache-a"), loadFinancialActivity("cache-a")]);
  await loadFinancialActivity("cache-a");
  expect(fetcher).toHaveBeenCalledTimes(1);
  await loadFinancialActivity("cache-b"); await loadFinancialActivity("cache-a", "property-a");
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it("invalidates a completed read for a mutation", async () => {
  const fetcher = vi.fn(async () => Response.json({ rows: [] }));
  vi.stubGlobal("fetch", fetcher);
  await loadFinancialActivity("cache-mutation");
  invalidateFinancialActivity(new Event("changed"));
  await loadFinancialActivity("cache-mutation");
  expect(fetcher).toHaveBeenCalledTimes(2);
});
