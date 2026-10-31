import { expect, it, vi } from "vitest";
vi.mock("@/lib/google-calendar/sync.server", () => ({ syncWorkOrderToGoogleCalendar: vi.fn() }));
import { updateResidentWorkOrder } from "@/lib/resident-work-order-lifecycle.server";

it.each(["scheduled", "photo"])("refuses a resident edit after a concurrent %s change", async (change) => {
  const old = { id: "row", manager_user_id: "manager", resident_user_id: "resident", resident_email: "r@example.test", property_id: "house", assigned_property_id: "house", row_revision: 4, row_data: { id: "row", bucket: "open", title: "before" } };
  const filters: Array<[string, unknown]> = [];
  let wrote = false;
  const read = { select: () => read, eq: () => read, maybeSingle: async () => ({ data: structuredClone(old), error: null }) };
  const write = { eq: (column: string, value: unknown) => { filters.push([column, value]); return write; }, select: async () => {
    // A manager changes the row after the read, including without changing its bucket.
    const current = { ...old, row_revision: 5, row_data: { ...old.row_data, ...(change === "scheduled" ? { bucket: "scheduled" } : { photo: "new" }) } };
    const matches = filters.every(([key, value]) => key === "row_data->>bucket" ? current.row_data.bucket === value : current[key as keyof typeof current] === value);
    wrote = matches;
    return { data: matches ? [{ id: current.id }] : [], error: null };
  } };
  const db = { from: () => ({ ...read, update: () => write }) };
  const result = await updateResidentWorkOrder(db as never, { workOrderId: "row", residentUserId: "resident", residentEmail: "r@example.test" }, { title: "new" });
  expect(result.ok).toBe(false);
  expect(wrote).toBe(false);
  expect(filters).toContainEqual(["row_revision", 4]);
});
