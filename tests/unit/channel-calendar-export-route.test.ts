import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ applications: [] as Record<string, unknown>[], blocks: [] as Record<string, unknown>[], error: null as null | { message: string } }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: (table: string) => { const chain = { select: () => chain, eq: () => chain, or: () => chain, order: () => chain, range: () => chain, limit: () => chain, then: (resolve: (value: unknown) => void) => resolve({ data: table === "manager_application_records" ? state.applications : state.blocks, error: state.error }) }; return chain; } }) }));
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
    state.applications = [{ ical_connection: "c", assigned_property_id: "p", choice: "p::r", lease_start: "2026-10-01", lease_end: "2026-10-03" }, { lease_start: "2026-10-01", lease_end: "2026-10-03" }];
    expect(await (await request()).text()).not.toContain("BEGIN:VEVENT");
  });
  it("fails instead of publishing false availability after a read failure", async () => {
    state.error = { message: "database unavailable" };
    expect((await request()).status).toBe(500);
  });
});
