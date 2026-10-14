import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabaseClient, type Row } from "./helpers/fake-supabase-tables";

vi.mock("server-only", () => ({}));

const pinned = vi.hoisted(() => ({
  fetch: vi.fn(),
  NonPublicHostError: class NonPublicHostError extends Error {},
}));
vi.mock("@/lib/sheet-sync/public-host.server", () => ({
  fetchPinnedPublicHttps: pinned.fetch,
  NonPublicHostError: pinned.NonPublicHostError,
}));

import { isChannelCalendarInputError } from "@/lib/channel-calendar/airbnb-url";
import { ensureRoomExportCalendarUrl, fetchChannelIcs, upsertChannelCalendarConnection } from "@/lib/channel-calendar/sync.server";

const ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";
const HOUFY = "https://www.houfy.com/calendar/export/abc.ics";
const FF = "https://furnishedfinder.com/ical/9.ics";
const calendar = (body = ICS, type = "text/calendar") => new Response(body, { status: 200, headers: { "content-type": type } });
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

beforeEach(() => pinned.fetch.mockReset());
afterEach(() => vi.unstubAllGlobals());

describe("fetchChannelIcs for Other calendar", () => {
  it("goes through the pinned public-host client, never a plain fetch", async () => {
    const plain = vi.fn();
    vi.stubGlobal("fetch", plain);
    pinned.fetch.mockResolvedValueOnce(calendar());
    await expect(fetchChannelIcs(HOUFY, "ical", { label: "Houfy" })).resolves.toContain("BEGIN:VCALENDAR");
    expect(pinned.fetch).toHaveBeenCalledTimes(1);
    expect(plain).not.toHaveBeenCalled();
  });

  it("says so when the host resolves to a private address (checked after DNS)", async () => {
    pinned.fetch.mockRejectedValueOnce(new pinned.NonPublicHostError("host does not resolve to public addresses only"));
    await expect(fetchChannelIcs("https://rebind.example.com/feed.ics", "ical", { label: "Houfy" })).rejects.toThrow(/Houfy calendar link points at a private or internal address/);
  });

  it("refuses an HTML answer and a calendar-typed answer that is not a calendar", async () => {
    pinned.fetch.mockResolvedValueOnce(calendar("<html><body>Sign in</body></html>", "text/html"));
    await expect(fetchChannelIcs(HOUFY, "ical")).rejects.toThrow(/not a valid calendar file/);
    pinned.fetch.mockResolvedValueOnce(calendar("<html>Sign in</html>", "text/calendar"));
    await expect(fetchChannelIcs(HOUFY, "ical")).rejects.toThrow(/not a valid calendar file/);
  });

  it("follows a redirect to another public https site but never to http or a private host", async () => {
    pinned.fetch.mockResolvedValueOnce(redirect("https://cdn.example.net/houfy/abc.ics")).mockResolvedValueOnce(calendar());
    await expect(fetchChannelIcs(HOUFY, "ical")).resolves.toContain("BEGIN:VCALENDAR");
    expect(pinned.fetch.mock.calls.map((c) => c[0])).toEqual([HOUFY, "https://cdn.example.net/houfy/abc.ics"]);
    for (const location of ["http://cdn.example.net/a.ics", "https://169.254.169.254/latest/meta-data/", "https://localhost/feed.ics"]) {
      pinned.fetch.mockReset().mockResolvedValueOnce(redirect(location)).mockResolvedValueOnce(calendar());
      await expect(fetchChannelIcs(HOUFY, "ical", { label: "Houfy" })).rejects.toThrow(/outside its own calendar links/);
      expect(pinned.fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("hands the caller's timeout to the fetch", async () => {
    pinned.fetch.mockResolvedValueOnce(calendar());
    await fetchChannelIcs(HOUFY, "ical", { timeoutMs: 6000 });
    expect(pinned.fetch.mock.calls[0]![1]).toMatchObject({ timeoutMs: 6000, totalTimeoutMs: 6000 });
  });
});

describe("Other calendar connections: one per site on the same room", () => {
  const property: Row = { id: "p1", manager_user_id: "mgr", property_data: null, row_data: null };
  const fresh = () => fakeSupabaseClient({ manager_property_records: [property], external_calendar_connections: [] });

  it("Houfy and Furnished Finder coexist on one room with separate export links, and a re-save updates in place", async () => {
    const db = fresh();
    const houfy = await upsertChannelCalendarConnection(db as never, { managerUserId: "mgr", propertyId: "p1", roomId: "r8", provider: "ical", label: "Houfy", importUrl: HOUFY });
    const ff = await upsertChannelCalendarConnection(db as never, { managerUserId: "mgr", propertyId: "p1", roomId: "r8", provider: "ical", label: "Furnished Finder", importUrl: FF });
    expect(houfy.id).not.toBe(ff.id);
    expect(houfy.exportUrl).not.toBe(ff.exportUrl);
    const again = await upsertChannelCalendarConnection(db as never, { managerUserId: "mgr", propertyId: "p1", roomId: "r8", provider: "ical", label: "  houfy ", importUrl: HOUFY });
    expect(again.id).toBe(houfy.id);
    expect(again.exportUrl).toBe(houfy.exportUrl);
  });

  it("keeps one connection per room for Airbnb even when the label changes", async () => {
    const db = fresh();
    const first = await upsertChannelCalendarConnection(db as never, { managerUserId: "mgr", propertyId: "p1", roomId: "r8", provider: "airbnb", label: "Room 8" });
    const second = await upsertChannelCalendarConnection(db as never, { managerUserId: "mgr", propertyId: "p1", roomId: "r8", provider: "airbnb", label: "Room Eight" });
    expect(second.id).toBe(first.id);
    expect(second.label).toBe("Room Eight");
  });

  it("refuses an Other calendar link with no site name, or with a private URL, as the manager's input", async () => {
    const db = fresh();
    const noName = await upsertChannelCalendarConnection(db as never, { managerUserId: "mgr", propertyId: "p1", roomId: "r8", provider: "ical", label: "  ", importUrl: HOUFY }).catch((e) => e);
    expect(isChannelCalendarInputError(noName)).toBe(true);
    expect(noName.field).toBe("label");
    const priv = await upsertChannelCalendarConnection(db as never, { managerUserId: "mgr", propertyId: "p1", roomId: "r8", provider: "ical", label: "Houfy", importUrl: "https://10.0.0.5/feed.ics" }).catch((e) => e);
    expect(isChannelCalendarInputError(priv)).toBe(true);
    expect(priv.field).toBe("importUrl");
  });

  it("the export link is made per site name and reused for the same name", async () => {
    const db = fresh();
    const a = await ensureRoomExportCalendarUrl(db as never, { propertyId: "p1", roomId: "r8", label: "Houfy", destination: "ical" });
    const b = await ensureRoomExportCalendarUrl(db as never, { propertyId: "p1", roomId: "r8", label: "houfy", destination: "ical" });
    const c = await ensureRoomExportCalendarUrl(db as never, { propertyId: "p1", roomId: "r8", label: "Furnished Finder", destination: "ical" });
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });
});
