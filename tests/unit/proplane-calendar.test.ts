import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `ensureProplaneCalendarId` — idempotent creation of the dedicated
 * secondary "PropLane" calendar every write now targets. Best-effort by
 * design: every failure mode returns `null` rather than throwing, so a
 * connect never fails because the dedicated calendar could not be created.
 */

const mocks = vi.hoisted(() => ({
  getGoogleCalendarAccessToken: vi.fn(),
  saveGoogleCalendarConnection: vi.fn(),
  isGoogleCalendarNotLinkedError: vi.fn(() => false),
}));

vi.mock("@/lib/google-calendar/api.server", () => ({
  getGoogleCalendarAccessToken: mocks.getGoogleCalendarAccessToken,
  googleCalendarFetchSignal: () => undefined,
  isGoogleCalendarNotLinkedError: mocks.isGoogleCalendarNotLinkedError,
}));

vi.mock("@/lib/google-calendar/settings", () => ({
  saveGoogleCalendarConnection: mocks.saveGoogleCalendarConnection,
}));

import { ensureProplaneCalendarId, PROPLANE_DEDICATED_CALENDAR_SUMMARY } from "@/lib/google-calendar/proplane-calendar.server";

describe("ensureProplaneCalendarId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mocks.saveGoogleCalendarConnection.mockResolvedValue(undefined);
  });

  it("returns the already-stored write calendar id without calling Google again", async () => {
    mocks.getGoogleCalendarAccessToken.mockResolvedValue({
      connection: { writeCalendarId: "existing-cal" },
      accessToken: "token",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(ensureProplaneCalendarId({} as never, "manager-1")).resolves.toBe("existing-cal");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.saveGoogleCalendarConnection).not.toHaveBeenCalled();
  });

  it("finds an already-created PropLane calendar in the calendar list before creating a new one", async () => {
    mocks.getGoogleCalendarAccessToken.mockResolvedValue({ connection: { writeCalendarId: null }, accessToken: "token" });
    const fetchMock = vi.fn(async (url: unknown) => {
      expect(String(url)).toContain("calendarList");
      return new Response(
        JSON.stringify({ items: [{ id: "found-cal", summary: PROPLANE_DEDICATED_CALENDAR_SUMMARY }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(ensureProplaneCalendarId({} as never, "manager-1")).resolves.toBe("found-cal");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.saveGoogleCalendarConnection).toHaveBeenCalledWith({}, "manager-1", { writeCalendarId: "found-cal" });
  });

  it("creates a new calendar when none exists and persists its id", async () => {
    mocks.getGoogleCalendarAccessToken.mockResolvedValue({ connection: { writeCalendarId: null }, accessToken: "token" });
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("calendarList")) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body.summary).toBe(PROPLANE_DEDICATED_CALENDAR_SUMMARY);
      return new Response(JSON.stringify({ id: "created-cal" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(ensureProplaneCalendarId({} as never, "manager-1")).resolves.toBe("created-cal");
    expect(mocks.saveGoogleCalendarConnection).toHaveBeenCalledWith({}, "manager-1", { writeCalendarId: "created-cal" });
  });

  it("returns null (never throws) when Google Calendar is not linked", async () => {
    mocks.isGoogleCalendarNotLinkedError.mockReturnValue(true);
    mocks.getGoogleCalendarAccessToken.mockRejectedValue(new Error("not linked"));

    await expect(ensureProplaneCalendarId({} as never, "manager-1")).resolves.toBeNull();
    expect(mocks.saveGoogleCalendarConnection).not.toHaveBeenCalled();
  });

  it("returns null when calendar creation fails, without throwing", async () => {
    mocks.getGoogleCalendarAccessToken.mockResolvedValue({ connection: { writeCalendarId: null }, accessToken: "token" });
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes("calendarList")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      return new Response(JSON.stringify({ error: { message: "insufficient scope" } }), { status: 403 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(ensureProplaneCalendarId({} as never, "manager-1")).resolves.toBeNull();
    expect(mocks.saveGoogleCalendarConnection).not.toHaveBeenCalled();
  });
});
