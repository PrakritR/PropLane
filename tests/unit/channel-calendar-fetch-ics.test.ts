import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { fetchChannelIcs, IMPORT_MAX_BYTES } from "@/lib/channel-calendar/sync.server";

const AIRBNB = "https://www.airbnb.com/calendar/ical/1.ics?s=abc";
const ICS = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";

const redirect = (location: string | null, status = 302) =>
  new Response(null, { status, headers: location ? { location } : {} });
const ok = (body: string | ReadableStream<Uint8Array>) => new Response(body, { status: 200 });

afterEach(() => vi.unstubAllGlobals());

function stubFetch(...responses: Response[]) {
  const fetchMock = vi.fn(async () => responses.shift() ?? new Response("", { status: 500 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("fetchChannelIcs", () => {
  it("never lets fetch follow a redirect on its own", async () => {
    const fetchMock = stubFetch(ok(ICS));
    await expect(fetchChannelIcs(AIRBNB, "airbnb")).resolves.toContain("BEGIN:VCALENDAR");
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: "manual" });
  });

  it("follows a redirect that stays on the provider's calendar link", async () => {
    const fetchMock = stubFetch(redirect("https://airbnb.com/calendar/ical/1.ics?s=abc"), ok(ICS));
    await expect(fetchChannelIcs(AIRBNB, "airbnb")).resolves.toContain("BEGIN:VCALENDAR");
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([AIRBNB, "https://airbnb.com/calendar/ical/1.ics?s=abc"]);
  });

  it("refuses a redirect to another host, plain http, or an internal address", async () => {
    for (const location of [
      "https://evil.example.com/calendar/ical/1.ics",
      "http://www.airbnb.com/calendar/ical/1.ics",
      "https://169.254.169.254/latest/meta-data/",
      "https://www.airbnb.com.evil.example/calendar/ical/1.ics",
    ]) {
      const fetchMock = stubFetch(redirect(location), ok(ICS));
      await expect(fetchChannelIcs(AIRBNB, "airbnb")).rejects.toThrow(/outside its own calendar links/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("gives up after three redirect hops", async () => {
    const hop = redirect("https://www.airbnb.com/calendar/ical/2.ics");
    const fetchMock = stubFetch(hop, redirect("https://www.airbnb.com/calendar/ical/3.ics"), redirect("https://www.airbnb.com/calendar/ical/4.ics"),
      redirect("https://www.airbnb.com/calendar/ical/5.ics"), ok(ICS));
    await expect(fetchChannelIcs(AIRBNB, "airbnb")).rejects.toThrow(/redirected too many times/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("re-validates against the right provider (a Vrbo link cannot redirect to Airbnb)", async () => {
    stubFetch(redirect("https://www.airbnb.com/calendar/ical/1.ics"));
    await expect(fetchChannelIcs("https://www.vrbo.com/icalendar/abc.ics", "vrbo")).rejects.toThrow(/outside its own calendar links/);
  });

  it("stops reading at 2 MB even when no content-length is declared", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(256 * 1024).fill(65);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    stubFetch(ok(body));
    await expect(fetchChannelIcs(AIRBNB, "airbnb")).rejects.toThrow(/too large/);
    expect(pulled).toBeLessThan(IMPORT_MAX_BYTES + 4 * chunk.byteLength);
  });

  it("rejects a declared oversize body without reading it", async () => {
    stubFetch(new Response(ICS, { status: 200, headers: { "content-length": String(IMPORT_MAX_BYTES + 1) } }));
    await expect(fetchChannelIcs(AIRBNB, "airbnb")).rejects.toThrow(/too large/);
  });

  it("still rejects a non-calendar body and an error status", async () => {
    stubFetch(ok("<html></html>"));
    await expect(fetchChannelIcs(AIRBNB, "airbnb")).rejects.toThrow(/not a valid calendar/);
    stubFetch(new Response("", { status: 503 }));
    await expect(fetchChannelIcs(AIRBNB, "airbnb")).rejects.toThrow(/returned 503/);
  });
});
