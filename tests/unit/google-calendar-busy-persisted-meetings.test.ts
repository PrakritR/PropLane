import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `googleBusyBlocks` (tour-availability.server.ts) after WS3: persisted
 * `google_meeting` rows are ADDED to the live Google pull, deduped by event
 * id so a meeting present in both never becomes two blocks.
 */

let managerCounter = 0;
function freshManagerId(): string {
  managerCounter += 1;
  return `mgr-busy-${managerCounter}`;
}

type LiveEvent = {
  id: string;
  summary: string;
  start: string;
  end: string;
  transparency?: "opaque" | "transparent";
  declinedBySelf?: boolean;
  allDay?: boolean;
  eventType?: string;
};

let LIVE_EVENTS: LiveEvent[];
let PERSISTED_EVENTS: LiveEvent[];
let GOOGLE_THROWS: boolean;

class FakeNotLinkedError extends Error {}

vi.mock("@/lib/google-calendar/api.server", () => ({
  GOOGLE_CALENDAR_OPERATION_TIMEOUT_MS: 9_000,
  isGoogleCalendarNotLinkedError: (e: unknown) => e instanceof FakeNotLinkedError,
  listGoogleCalendarEvents: vi.fn(async () => {
    if (GOOGLE_THROWS) throw new Error("Google Calendar did not respond in time.");
    return LIVE_EVENTS;
  }),
}));

vi.mock("@/lib/google-calendar/persisted-meetings.server", () => ({
  loadPersistedGoogleMeetings: vi.fn(async () => PERSISTED_EVENTS),
}));

import { googleBusyBlocks } from "@/lib/tour-availability.server";

const TIME_MIN = "2030-01-01T00:00:00.000Z";
const TIME_MAX = "2030-02-01T00:00:00.000Z";

function event(overrides: Partial<LiveEvent> & { id: string }): LiveEvent {
  return {
    summary: "Busy",
    start: "2030-01-07T17:00:00.000Z",
    end: "2030-01-07T18:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("googleBusyBlocks — persisted google_meeting merge", () => {
  it("adds a persisted meeting the live pull did not return", async () => {
    LIVE_EVENTS = [];
    PERSISTED_EVENTS = [event({ id: "g-persisted" })];
    GOOGLE_THROWS = false;

    const blocks = await googleBusyBlocks({} as never, freshManagerId(), TIME_MIN, TIME_MAX);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ start: "2030-01-07T17:00:00.000Z", end: "2030-01-07T18:00:00.000Z" });
  });

  it("does not double-count a meeting present in both the live pull and the persisted store", async () => {
    LIVE_EVENTS = [event({ id: "g-both" })];
    PERSISTED_EVENTS = [event({ id: "g-both" })];
    GOOGLE_THROWS = false;

    const blocks = await googleBusyBlocks({} as never, freshManagerId(), TIME_MIN, TIME_MAX);

    expect(blocks).toHaveLength(1);
  });

  it("a persisted meeting marked transparent (free) does not block", async () => {
    LIVE_EVENTS = [];
    PERSISTED_EVENTS = [event({ id: "g-free", transparency: "transparent" })];
    GOOGLE_THROWS = false;

    const blocks = await googleBusyBlocks({} as never, freshManagerId(), TIME_MIN, TIME_MAX);

    expect(blocks).toHaveLength(0);
  });

  it("a declined persisted meeting does not block", async () => {
    LIVE_EVENTS = [];
    PERSISTED_EVENTS = [event({ id: "g-declined", declinedBySelf: true })];
    GOOGLE_THROWS = false;

    const blocks = await googleBusyBlocks({} as never, freshManagerId(), TIME_MIN, TIME_MAX);

    expect(blocks).toHaveLength(0);
  });

  it("still combines both live and distinct persisted busy events", async () => {
    LIVE_EVENTS = [event({ id: "g-live", start: "2030-01-07T10:00:00.000Z", end: "2030-01-07T11:00:00.000Z" })];
    PERSISTED_EVENTS = [event({ id: "g-persisted-2", start: "2030-01-08T10:00:00.000Z", end: "2030-01-08T11:00:00.000Z" })];
    GOOGLE_THROWS = false;

    const blocks = await googleBusyBlocks({} as never, freshManagerId(), TIME_MIN, TIME_MAX);

    expect(blocks).toHaveLength(2);
  });
});
