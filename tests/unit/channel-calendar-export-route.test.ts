import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ applications: [] as Record<string, unknown>[], blocks: [] as Record<string, unknown>[], error: null as null | { message: string } }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: (table: string) => { const chain = { select: () => chain, eq: () => chain, in: () => chain, or: () => chain, like: () => chain, order: () => chain, range: () => chain, limit: () => chain, then: (resolve: (value: unknown) => void) => resolve({ data: table === "manager_application_records" ? state.applications : state.blocks, error: state.error }) }; return chain; } }) }));
vi.mock("@/lib/channel-calendar/sync.server", () => ({ loadConnectionByExportToken: async () => ({ id: "c", property_id: "p", room_id: "r", manager_user_id: "m" }), loadPropertyRecord: async () => ({ property: null }) }));
import { GET } from "@/app/api/calendar/export/[token]/route";
const request = () => GET(new Request("https://example.com/api/calendar/export/token.ics"), { params: Promise.resolve({ token: "token.ics" }) });
beforeEach(() => { state.applications = []; state.blocks = []; state.error = null; });
describe("channel export actual holds", () => {
  it("exports saved booking blocks checkout-exclusive and omits cancelled or other-room blocks", async () => {
    state.blocks = [{ row_data: { roomId: "r", checkIn: "2026-10-01", checkOut: "2026-10-04" } }, { row_data: { roomId: "r", bookingStatus: "cancelled", checkIn: "2026-11-01", checkOut: "2026-11-04" } }, { row_data: { roomId: "other", checkIn: "2026-12-01", checkOut: "2026-12-04" } }];
    const response = await request();
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("DTSTART;VALUE=DATE:20261001");
    expect(body).toContain("DTEND;VALUE=DATE:20261004");
    expect(body).not.toContain("20261101");
    expect(body).not.toContain("20261201");
  });
  it("does not echo channel resident records or unscoped residents", async () => {
    state.applications = [{ id: "a1", ical_connection: "c", assigned_property_id: "p", choice: "p::r", lease_start: "2026-10-01", lease_end: "2026-10-03" }, { id: "a2", lease_start: "2026-10-01", lease_end: "2026-10-03" }];
    expect(await (await request()).text()).not.toContain("BEGIN:VEVENT");
  });
  const approvedRows = (count: number) =>
    Array.from({ length: count }, (_unused, index) => ({
      id: `a${index}`,
      assigned_property_id: "p",
      choice: "p::r",
      lease_start: "2026-10-01",
      lease_end: "2026-10-03",
      bucket: "approved",
    }));

  it("refuses the feed rather than serving a read it could not finish paging", async () => {
    // Every page comes back with a row past its end, so the read never proves it reached the end.
    // A truncated feed would advertise occupied dates as free — the double booking this guards.
    state.applications = approvedRows(501);
    expect((await request()).status).toBe(500);
  });

  it("serves the feed when the rows land exactly on a page boundary", async () => {
    // A page's worth with nothing past it is a COMPLETE read, not a truncated one.
    state.applications = approvedRows(500);
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("DTSTART;VALUE=DATE:20261001");
  });
  it("fails instead of publishing false availability after a read failure", async () => {
    state.error = { message: "database unavailable" };
    expect((await request()).status).toBe(500);
  });
});

import { HEAD as exportHead } from "@/app/api/calendar/export/[token]/route";
import { GET as aliasGet, HEAD as aliasHead } from "@/app/ical/[token]/route";

describe("feed response shape for strict importers", () => {
  const params = { params: Promise.resolve({ token: "token.ics" }) };
  it("is calendar content with no download disposition, and HEAD matches GET without a body", async () => {
    const get = await request();
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(get.headers.get("content-disposition")).toBeNull();
    const body = await get.text();
    expect(get.headers.get("content-length")).toBe(String(new TextEncoder().encode(body).length));
    const head = await exportHead(new Request("https://example.com/api/calendar/export/token.ics", { method: "HEAD" }), params);
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"));
    expect(head.headers.get("content-length")).toBe(get.headers.get("content-length"));
    expect(head.headers.get("content-disposition")).toBeNull();
    expect(await head.text()).toBe("");
  });
  it("serves the same feed from the short /ical alias", async () => {
    const res = await aliasGet(new Request("https://example.com/ical/token.ics"), params);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("BEGIN:VCALENDAR");
    expect((await aliasHead(new Request("https://example.com/ical/token.ics", { method: "HEAD" }), params)).status).toBe(200);
  });
});
