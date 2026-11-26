import { describe, expect, it } from "vitest";

import { googleCalendarStatusLine } from "@/lib/google-calendar/status-line";

const now = new Date("2026-11-23T20:00:00Z");

describe("googleCalendarStatusLine", () => {
  it("says Connected with the account and the last sync", () => {
    const line = googleCalendarStatusLine({ state: "ready", connected: true, email: "m@example.com", lastSyncedAt: "2026-11-23T19:30:00Z" }, now);
    expect(line).toMatch(/^Connected · m@example\.com · last sync /);
  });
  it("omits a last sync it does not have rather than inventing one", () => {
    expect(googleCalendarStatusLine({ state: "ready", connected: true, email: "m@example.com" }, now)).toBe("Connected · m@example.com");
  });
  it("says Not connected, Reconnect needed, or the real error, never a blank", () => {
    expect(googleCalendarStatusLine({ state: "ready", connected: false, email: null }, now)).toBe("Not connected");
    expect(googleCalendarStatusLine({ state: "ready", connected: false, email: null, revoked: true }, now)).toMatch(/^Reconnect needed/);
    expect(googleCalendarStatusLine({ state: "error", message: "Google Calendar did not answer. Try again." }, now)).toBe("Google Calendar did not answer. Try again.");
  });
});
