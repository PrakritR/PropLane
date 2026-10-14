import { describe, expect, it } from "vitest";
import { withoutEchoedHostBlocks } from "@/lib/channel-calendar/host-block";
import { occupiedBedSpans, occupiedBedsOn } from "@/lib/room-occupancy-rule";

const base = { propertyId: "p1", roomId: "r1", bookingStatus: "confirmed" };
const res = (start: string, end: string, extra = {}) => ({ ...base, source: "proplane", start, end, summary: "Heesu", ...extra });
const echo = (start: string, end: string, extra = {}) => ({ ...base, source: "airbnb", start, end, summary: "Airbnb (Not available)", hostBlock: true, ...extra });
const range = (e: { start: string; end: string }) => `${e.start}..${e.end}`;
const rawRange = (e: { channelRangeStart?: string; channelRangeEnd?: string }) => `${e.channelRangeStart}..${e.channelRangeEnd}`;

describe("withoutEchoedHostBlocks", () => {
  it("hides a fully covered echo", () => {
    expect(withoutEchoedHostBlocks([res("2026-10-01", "2026-12-31"), echo("2026-10-05", "2026-11-30")]).map((e) => e.source)).toEqual(["proplane"]);
  });
  it("keeps only the uncovered remainder on partial overlap", () => {
    const out = withoutEchoedHostBlocks([res("2026-10-10", "2026-10-20"), echo("2026-10-01", "2026-10-31")]);
    expect(out.filter((e) => e.source === "airbnb").map(range)).toEqual(["2026-10-01..2026-10-09", "2026-10-21..2026-10-31"]);
    // Remove stay / Undo key a host block on its UID plus the RAW range's dates; a remainder keeps them.
    expect(out.filter((e) => e.source === "airbnb").map(rawRange)).toEqual(["2026-10-01..2026-10-31", "2026-10-01..2026-10-31"]);
  });
  it("never distorts coverage when a local stay's end is typed before its start", () => {
    const out = withoutEchoedHostBlocks([res("2026-10-10", "2026-10-05"), res("2026-10-20", "2026-10-25"), echo("2026-10-01", "2026-10-31")]);
    expect(out.filter((e) => e.source === "airbnb").map(range)).toEqual(["2026-10-01..2026-10-19", "2026-10-26..2026-10-31"]);
  });
  it("never hides a reservation", () => {
    const reserved = echo("2026-10-05", "2026-10-08", { summary: "Reserved", hostBlock: false, reservationCode: "HMABC" });
    expect(withoutEchoedHostBlocks([res("2026-10-01", "2026-12-31"), reserved])).toHaveLength(2);
  });
  it("covers one long echo with two back-to-back residents", () => {
    const out = withoutEchoedHostBlocks([res("2026-10-01", "2026-10-15"), res("2026-10-16", "2026-10-31", { summary: "Akshaya" }), echo("2026-10-01", "2026-10-31")]);
    expect(out.map((e) => e.source)).toEqual(["proplane", "proplane"]);
  });
  it("ignores another room and keeps an uncovered echo whole", () => {
    expect(withoutEchoedHostBlocks([res("2026-10-01", "2026-10-31", { roomId: "r2" }), echo("2026-10-05", "2026-10-08")])).toHaveLength(2);
  });
  it("leaves occupancy nights unchanged by an echo", () => {
    const nights = (spans: Parameters<typeof occupiedBedSpans>[0]) =>
      ["2026-10-04", "2026-10-12", "2026-10-25"].map((d) => occupiedBedsOn(occupiedBedSpans(spans), d));
    const real = [{ start: "2026-10-10", end: "2026-10-20" }];
    expect(nights([...real, { start: "2026-10-12", end: "2026-10-18", echoable: true }])).toEqual(nights(real));
    expect(nights([...real, { start: "2026-10-01", end: "2026-10-31", echoable: true }])).toEqual([1, 1, 1]);
  });
});
