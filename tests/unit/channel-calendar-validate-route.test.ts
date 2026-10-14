import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  manager: vi.fn(),
  rate: vi.fn(),
  fetchIcs: vi.fn(),
}));
vi.mock("@/lib/channel-calendar/require-manager.server", () => ({ requireBookingsManager: mocks.manager }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rate }));
vi.mock("@/lib/channel-calendar/sync.server", () => ({ fetchChannelIcs: mocks.fetchIcs }));

import { POST } from "@/app/api/portal/channel-calendar/validate/route";
import { ICAL_VALIDATE_TIMEOUT_MS } from "@/lib/channel-calendar/airbnb-url";

const post = (body: unknown) => POST(new Request("http://localhost/api/portal/channel-calendar/validate", { method: "POST", body: JSON.stringify(body) }));
const ICS = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT", "UID:a", "DTSTART;VALUE=DATE:20261020", "DTEND;VALUE=DATE:20261024", "SUMMARY:Reserved", "END:VEVENT",
  "BEGIN:VEVENT", "UID:b", "DTSTART;VALUE=DATE:20261101", "DTEND;VALUE=DATE:20261103", "SUMMARY:Reserved", "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

beforeEach(() => {
  mocks.manager.mockReset().mockResolvedValue({ db: {}, userId: "mgr" });
  mocks.rate.mockReset().mockResolvedValue({ ok: true });
  mocks.fetchIcs.mockReset().mockResolvedValue(ICS);
});

describe("POST /api/portal/channel-calendar/validate", () => {
  it("answers 401 without a manager session and never fetches", async () => {
    mocks.manager.mockResolvedValueOnce(null);
    expect((await post({ url: "https://www.houfy.com/feed.ics" })).status).toBe(401);
    expect(mocks.fetchIcs).not.toHaveBeenCalled();
  });

  it("is rate limited per manager and never fetches once the limit is hit", async () => {
    mocks.rate.mockResolvedValueOnce({ ok: false });
    expect((await post({ url: "https://www.houfy.com/feed.ics" })).status).toBe(429);
    expect(mocks.rate.mock.calls[0]![0]).toBe("channel-calendar-validate:mgr");
    expect(mocks.fetchIcs).not.toHaveBeenCalled();
  });

  it("refuses http, a non-calendar path and a private host before any request is made", async () => {
    for (const url of ["http://www.houfy.com/feed.ics", "https://www.houfy.com/rooms/1", "https://localhost/feed.ics", "https://10.1.2.3/feed.ics", "", 5]) {
      const res = await post({ url });
      expect(res.status, String(url)).toBe(400);
      expect((await res.json()).ok).toBe(false);
    }
    expect(mocks.fetchIcs).not.toHaveBeenCalled();
  });

  it("fetches with the 6 second cap and returns the block count, not the body", async () => {
    const res = await post({ url: "https://www.houfy.com/feed.ics" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, eventCount: 2 });
    expect(mocks.fetchIcs).toHaveBeenCalledWith("https://www.houfy.com/feed.ics", "ical", { timeoutMs: 6000 });
    expect(ICAL_VALIDATE_TIMEOUT_MS).toBe(6000);
  });

  it("returns the fetcher's reason when the link is not a calendar or is unreachable", async () => {
    mocks.fetchIcs.mockRejectedValueOnce(new Error("Response was not a valid calendar file."));
    const res = await post({ url: "https://www.houfy.com/feed.ics" });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: "Response was not a valid calendar file." });
  });
});
