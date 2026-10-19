import type { Row } from "./fake-table-db";

/** A published, unassigned service on the work board. */
export function boardService(id: string, over: Row = {}, rowData: Row = {}): Row {
  return {
    id,
    manager_user_id: "mgr-1",
    vendor_user_id: null,
    test_workspace_id: null,
    updated_at: "2026-10-18T10:00:00Z",
    row_data: {
      id,
      title: "Kitchen sink leak",
      description: "Slow leak.",
      category: "plumbing",
      propertyName: "Alder House",
      propertyAddress: "1420 Alder St, Seattle, WA 98115",
      unit: "4B",
      residentName: "SECRET RESIDENT",
      status: "Open",
      bucket: "pending",
      published: true,
      publishRef: `ref-${id}`,
      publishBudgetCents: 25000,
      ...rowData,
    },
    ...over,
  };
}

export const BOARD_FIXTURE: Row[] = [
  boardService("wo-ravenna"),
  boardService("wo-ballard-clean", {}, { title: "Turnover clean at 88 Pike Ave", category: "cleaning", propertyAddress: "88 Pike Ave, Seattle, WA 98107", publishBudgetCents: null, preferredArrival: "Weekdays" }),
  boardService("wo-downtown", {}, { title: "Toilet running", propertyAddress: "500 Pine St, Seattle, WA 98101" }),
  boardService("wo-unpublished", {}, { published: false }),
  boardService("wo-assigned", { vendor_user_id: "vendor-x" }),
  boardService("wo-scheduled", {}, { bucket: "scheduled" }),
];
