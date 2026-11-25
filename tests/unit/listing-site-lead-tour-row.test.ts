/**
 * A tour lead on a listing-site record opens the Tours ROW that request is, and the Tours list files a request by
 * its status: a pending request is its window row, a declined one its own row, and a confirmed tour is a planned
 * event the request no longer names. The per-window schedule records the leads reader walks keep the payload they
 * were written with, so the status has to come from the one record that holds it.
 *
 * Oracle: `tourRowsFromInquiries`, the Tours list's own row builder, over the same inquiry. Plausible wrong
 * behaviour this rejects: every lead linking as `inquiry-<id>-0`, which for a declined or confirmed request is a
 * row id that cannot exist, so the page opens the bucket list with no record.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tourRowsFromInquiries } from "@/lib/manager-tour-list";
import { resetCachedInquiryRows } from "@/lib/tour-resident-link.server";
import type { PartnerInquiry } from "@/lib/demo-admin-scheduling";

const INQUIRIES_RECORD_ID = "axis_admin_partner_inquiries_v1";
const INQUIRY_ID = "inq-lead-1";
const WINDOWS = [
  { start: "2026-10-10T22:00:00.000Z", end: "2026-10-10T22:30:00.000Z" },
  { start: "2026-10-12T22:00:00.000Z", end: "2026-10-12T22:30:00.000Z" },
];

const store = vi.hoisted(() => ({
  events: [] as Record<string, unknown>[],
  inquiries: [] as Record<string, unknown>[],
  blobReads: 0,
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const answer = () => {
        if (table !== "portal_schedule_records") return { data: [], error: null };
        if (filters["eq:id"] === INQUIRIES_RECORD_ID) {
          store.blobReads += 1;
          return { data: { row_data: { payload: store.inquiries } }, error: null };
        }
        return { data: store.events, error: null };
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => ((filters[`eq:${column}`] = value), builder),
        in: () => builder,
        order: () => builder,
        range: () => Promise.resolve(answer()),
        maybeSingle: () => Promise.resolve(answer()),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(answer()).then(resolve),
      };
      return builder;
    },
  }),
}));

const inquiry = (status: string): PartnerInquiry =>
  ({
    id: INQUIRY_ID,
    kind: "tour",
    status,
    name: "Maya Chen",
    email: "maya@example.com",
    propertyId: "p1",
    managerUserId: "mgr-1",
    requestedWindows: WINDOWS,
    createdAt: "2026-10-01T00:00:00.000Z",
  }) as unknown as PartnerInquiry;

beforeEach(() => {
  store.events = WINDOWS.map((window, index) => ({
    id: `partner_inquiry_request_${INQUIRY_ID}_${index}`,
    property_id: "p1",
    starts_at: window.start,
    // What the record was WRITTEN with: the status here is always the one it came in as.
    row_data: { payload: { ...(inquiry("pending") as unknown as Record<string, unknown>) } },
  }));
  store.inquiries = [];
  store.blobReads = 0;
  resetCachedInquiryRows();
});

const lead = async () => {
  const { listingSiteLeads } = await import("@/lib/listing-channels/leads.server");
  const leads = await listingSiteLeads({
    channel: "craigslist",
    propertyIds: ["p1"],
    now: new Date("2026-10-09T00:00:00.000Z"),
  });
  return leads.find((entry) => entry.kind === "tour")!;
};

describe("a tour lead links to the row the Tours list gives its request", () => {
  it("a pending request opens its earliest window's row", async () => {
    store.inquiries = [inquiry("pending") as unknown as Record<string, unknown>];
    const rows = tourRowsFromInquiries([inquiry("pending")]);
    expect(rows).toHaveLength(2);
    const earliest = [...rows].sort((a, b) => a.startMs - b.startMs)[0]!;
    const entry = await lead();
    expect(entry.rowId).toBe(earliest.id);
    expect(entry.bucket).toBe(earliest.bucket);
  });

  it("a declined request opens the declined row, in the bucket that row sits in", async () => {
    store.inquiries = [inquiry("declined") as unknown as Record<string, unknown>];
    const [row] = tourRowsFromInquiries([inquiry("declined")]);
    expect(row).toBeTruthy();
    const entry = await lead();
    expect(entry.rowId).toBe(row!.id);
    expect(entry.bucket).toBe(row!.bucket);
  });

  /*
   * That singleton row is a whole-platform blob (every workspace's tour requests), and a Leads page wants one field
   * off a handful of its rows - AGENTS.md section Performance & egress. Oracle: the same minute-long contract
   * `phone-email-join.server.ts` reads it under. Plausible wrong behaviour this rejects: one blob read per page load.
   */
  it("reads that whole-platform blob once a minute, not once a page load", async () => {
    store.inquiries = [inquiry("pending") as unknown as Record<string, unknown>];
    await lead();
    await lead();
    await lead();
    expect(store.blobReads).toBe(1);
  });

  it("a confirmed tour names no inquiry row, so the lead carries none", async () => {
    // Confirming removes the request from the inquiries record; its row is the planned event instead.
    store.inquiries = [];
    expect(tourRowsFromInquiries([inquiry("confirmed")])).toEqual([]);
    const entry = await lead();
    expect(entry.rowId).toBeNull();
    expect(entry.bucket).toBe("upcoming");
  });
});
