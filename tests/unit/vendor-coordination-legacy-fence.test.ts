import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { workOrderCoordinationEnrolled } from "@/lib/vendor-coordination.server";

function database(statuses: string[], fail = false) {
  let rows = statuses.map((status) => ({ id: status, status }));
  const query = {
    select: () => query, eq: () => query,
    in: (_column: string, allowed: string[]) => { rows = rows.filter((row) => allowed.includes(row.status)); return query; },
    limit: async () => ({ data: rows.slice(0, 1), error: fail ? { message: "unavailable" } : null }),
  };
  return { from: () => query };
}
describe("legacy booking fence matches current proposal ownership", () => {
  it.each(["collecting", "ready", "approved"])("retains the fence for %s terms", async (status) => {
    await expect(workOrderCoordinationEnrolled(database([status]) as never, "service")).resolves.toBe(true);
  });
  it("releases rejected or cancelled proposals without silently blocking manual work", async () => {
    await expect(workOrderCoordinationEnrolled(database(["declined", "cancelled"]) as never, "service")).resolves.toBe(false);
  });
  it("fails closed if current proposal ownership cannot be read", async () => {
    await expect(workOrderCoordinationEnrolled(database([], true) as never, "service")).rejects.toThrow("Coordination state unavailable");
  });
});
