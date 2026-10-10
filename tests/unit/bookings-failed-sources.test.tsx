// @vitest-environment jsdom
/**
 * Bookings must never spin forever: every fetch that gates readiness has a
 * clock, a source that errors or times out is "settled" and listed in
 * `failedSources`, and `retry()` re-runs it. The page draws what loaded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { FetchTimeoutError, PORTAL_READ_TIMEOUT_MS, withTimeout } from "@/lib/auth/fetch-with-timeout";

const channel = vi.fn<(ids: string[]) => Promise<unknown[]>>();
const occupancy = vi.fn<() => Promise<{ days: unknown[] }>>();
const blocks = vi.fn<() => Promise<unknown[]>>();

vi.mock("@/lib/channel-calendar/client", () => ({
  fetchManagerChannelBookings: (ids: string[]) => channel(ids),
  fetchOccupancySnapshot: () => occupancy(),
}));
vi.mock("@/lib/channel-calendar/room-date-blocks", () => ({
  ROOM_DATE_BLOCKS_CHANGED: "axis:room-date-blocks-changed",
  fetchRoomDateBlocks: () => blocks(),
}));
vi.mock("@/lib/channel-calendar/stay-meta-client", () => ({ fetchStayMetas: () => Promise.resolve([]) }));
vi.mock("@/lib/lease-pipeline-storage", () => ({
  LEASE_PIPELINE_EVENT: "lease-pipeline-changed",
  leasePipelineReadSucceeded: () => true,
  leaseIsFullyExecuted: () => false,
  readLeasePipeline: () => [],
  syncLeasePipelineFromServer: () => Promise.resolve([]),
}));
vi.mock("@/lib/manager-applications-storage", () => ({
  MANAGER_APPLICATIONS_EVENT: "manager-applications-changed",
  normalizeApplicationAxisId: (id: unknown) => String(id ?? ""),
  readManagerApplicationRows: () => [],
  syncManagerApplicationsFromServerWithStatus: () => Promise.resolve({ rows: [], ok: true }),
}));
vi.mock("@/lib/rental-application/data", () => ({
  getPropertyById: () => null,
  isEntireHomeProperty: () => false,
  parseRoomChoiceValue: () => ({ listingRoomId: null }),
}));

import { useManagerBookingEntries } from "@/hooks/use-manager-booking-entries";
import { BookingsLoadFailedBand } from "@/components/portal/bookings-load-failed-band";

const PROPS = {
  userId: "mgr-1",
  propertyIds: ["house-1"],
  propertyOptions: [{ id: "house-1", label: "5259 Brooklyn Ave" }],
  propertyTick: 0,
};

const never = () => new Promise<never>(() => {});

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  channel.mockReset();
  occupancy.mockReset();
  blocks.mockReset();
  occupancy.mockResolvedValue({ days: [] });
  blocks.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("withTimeout", () => {
  it("rejects with FetchTimeoutError once the clock runs out", async () => {
    const pending = withTimeout(never(), 50);
    const settled = expect(pending).rejects.toBeInstanceOf(FetchTimeoutError);
    await vi.advanceTimersByTimeAsync(50);
    await settled;
  });
});

describe("useManagerBookingEntries failed sources", () => {
  it("a hung source times out, is listed as failed, and the spinner is already gone", async () => {
    channel.mockImplementation(never);
    const { result } = renderHook(() => useManagerBookingEntries(PROPS));
    await flush();
    // Other sources settled: no spinner while the channel fetch is still out.
    expect(result.current.loading).toBe(false);
    expect(result.current.failedSources).toEqual([]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PORTAL_READ_TIMEOUT_MS + 10);
    });
    expect(result.current.failedSources).toEqual(["channel"]);
    expect(result.current.loading).toBe(false);
  });

  it("an erroring source is failed, and retry() re-runs it until it loads", async () => {
    channel.mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() => useManagerBookingEntries(PROPS));
    await flush();
    expect(result.current.failedSources).toEqual(["channel"]);

    channel.mockResolvedValue([]);
    act(() => result.current.retry());
    await flush();
    expect(channel).toHaveBeenCalledTimes(2);
    expect(result.current.failedSources).toEqual([]);
  });

  it("when every source fails the page settles (no endless spinner) with all of them listed", async () => {
    channel.mockRejectedValue(new Error("down"));
    occupancy.mockRejectedValue(new Error("down"));
    blocks.mockRejectedValue(new Error("down"));
    const { result } = renderHook(() => useManagerBookingEntries(PROPS));
    await flush();
    expect(result.current.loading).toBe(false);
    expect(result.current.failedSources).toEqual(expect.arrayContaining(["channel", "occupancy", "blocks"]));
    expect(result.current.entries).toEqual([]);
  });

  it("keeps spinning only while no source has settled yet", async () => {
    channel.mockImplementation(never);
    occupancy.mockImplementation(never);
    blocks.mockImplementation(never);
    const { result } = renderHook(() => useManagerBookingEntries({ ...PROPS, userId: "mgr-1" }));
    // Applications and leases resolve on the microtask queue, so the very first render is the only "nothing settled" moment.
    expect(result.current.loading).toBe(true);
    await flush();
    expect(result.current.loading).toBe(false);
  });
});

describe("BookingsLoadFailedBand", () => {
  it("renders nothing when every source loaded", () => {
    const { container } = render(<BookingsLoadFailedBand failedSources={[]} onRetry={() => {}} />);
    expect(container.textContent).toBe("");
  });

  it("shows one compact message with a Retry button", () => {
    const onRetry = vi.fn();
    render(<BookingsLoadFailedBand failedSources={["channel", "blocks"]} onRetry={onRetry} />);
    expect(screen.getByText("Some bookings didn't load.")).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry.getAttribute("data-attr")).toBe("bookings-retry");
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
