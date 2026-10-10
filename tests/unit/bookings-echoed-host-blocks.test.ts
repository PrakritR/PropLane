import { describe, expect, it } from "vitest";
import { withoutEchoedHostBlocks } from "@/lib/channel-calendar/host-block";

const base = { propertyId: "p1", roomId: "r2", bookingStatus: "confirmed" };
const resident = { ...base, source: "hold", start: "2026-09-24", end: "2026-12-31", summary: "Fekadu Daniel" };
const echo = { ...base, source: "airbnb", start: "2026-10-08", end: "2027-01-01", summary: "Airbnb (Not available)" };

describe("withoutEchoedHostBlocks", () => {
  it("drops the channel's 'Not available' range that mirrors a resident on the same room", () => {
    expect(withoutEchoedHostBlocks([resident, echo]).map((e) => e.source)).toEqual(["hold"]);
  });
  it("keeps a real Airbnb reservation on top of a resident (a genuine overbooking)", () => {
    const guest = { ...echo, summary: "Reserved" };
    expect(withoutEchoedHostBlocks([resident, guest])).toHaveLength(2);
  });
  it("keeps a host block on a room with no PropLane stay, or on another room", () => {
    expect(withoutEchoedHostBlocks([echo])).toHaveLength(1);
    expect(withoutEchoedHostBlocks([resident, { ...echo, roomId: "r3" }])).toHaveLength(2);
  });
  it("keeps a host block that runs past the resident's move-out", () => {
    expect(withoutEchoedHostBlocks([resident, { ...echo, end: "2027-03-01" }])).toHaveLength(2);
  });
});
