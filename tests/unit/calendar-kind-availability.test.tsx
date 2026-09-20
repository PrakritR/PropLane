// @vitest-environment jsdom
/**
 * PLAN-0914-1710 §2 — `availabilityKeysByKind` reads/writes availability per
 * kind: a tours-only run reads "Tours", a services run names itself, and the
 * small × on a run writes only that kind's storage key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { PortalCalendarPanels } from "@/components/portal/portal-calendar-panels";
import { toLocalDateStr, startOfWeekMonday } from "@/lib/demo-admin-scheduling";
import { resolveDefaultTourAvailabilityConfig } from "@/lib/tour-slot-math";

const TOURS_KEY = "axis_mgr_avail_slots_v2_test_tours";
const SERVICES_KEY = "axis_mgr_avail_slots_v2_test_kind_services";

let SLOTS_BY_KEY: Record<string, Set<string>> = {};
const writeAvailability = vi.fn(async () => true);

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => (req: { description?: unknown }) =>
    Promise.resolve(
      typeof window === "undefined"
        ? true
        : window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
    ),
  useAppUi: () => ({ showToast: vi.fn() }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/calendar",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/lib/rental-application/data", () => ({ getPropertyById: () => undefined }));
vi.mock("@/lib/manager-calendar-tour-meetings", () => ({
  buildScheduledTourMeetings: () => [],
}));
vi.mock("@/lib/demo-admin-scheduling", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    syncScheduleRecordsFromServer: vi.fn(async () => undefined),
    // Unlike the single-kind test scaffold, this reader answers PER KEY —
    // the whole point of Stage B is that different kinds read different keys.
    readAvailabilityDateSetForStorageKey: (key: string) => SLOTS_BY_KEY[key] ?? new Set<string>(),
    readPlannedEvents: () => [],
    writeAvailabilityDateSetForStorageKeyToServer: (...args: unknown[]) =>
      writeAvailability(...(args as [])),
  };
});

Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {});
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});

function mondaySlotKey(hourSlot: number): string {
  const monday = startOfWeekMonday(new Date());
  return `${toLocalDateStr(monday)}:${hourSlot}`;
}

beforeEach(() => {
  SLOTS_BY_KEY = {
    [TOURS_KEY]: new Set([mondaySlotKey(20)]), // 10:00-10:30, tours only
    [SERVICES_KEY]: new Set([mondaySlotKey(24), mondaySlotKey(25)]), // 12:00-1:00, services only
  };
  writeAvailability.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ records: [] }) }) as unknown as Response),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderKindAvailability() {
  return render(
    <PortalCalendarPanels
      storageKey={null}
      availabilityKeysByKind={{ tours: [TOURS_KEY], services: [SERVICES_KEY] }}
      editKind="tours"
      compactAvailability
      bareSurface
      availabilityHeading="Calendar"
      defaultTourAvailability={resolveDefaultTourAvailabilityConfig({ enabled: false })}
      anchorDate={startOfWeekMonday(new Date())}
    />,
  );
}

describe("kind-scoped availability (PLAN-0914-1710 §2)", () => {
  it("labels a services run distinctly from a tours-only run", () => {
    const { container } = renderKindAvailability();
    // The run label is the first line inside the two-line span. Tours-only now
    // reads "Tours" (not the bare word "Open") and a services run names itself
    // (PLAN-0916-0041).
    const labels = Array.from(container.querySelectorAll("span.flex.flex-col > span:first-child")).map(
      (el) => el.textContent,
    );
    expect(labels).toContain("Tours");
    expect(labels.some((label) => label?.includes("Services"))).toBe(true);
  });

  it("deleting the services run via its × writes only the services key", async () => {
    const { container } = renderKindAvailability();
    const monday = toLocalDateStr(startOfWeekMonday(new Date()));
    const servicesCells = container.querySelectorAll(`[aria-label="Open details for 12 pm on ${monday}"]`);
    expect(servicesCells.length).toBeGreaterThanOrEqual(1);
    const wrap = servicesCells[0]?.closest(".group\\/slot") ?? servicesCells[0]?.parentElement;
    const remove = wrap?.querySelector('[data-attr="calendar-remove-availability-slot"]') as HTMLButtonElement | null;
    expect(remove).toBeTruthy();
    fireEvent.click(remove!);
    await waitFor(() => {
      expect(writeAvailability).toHaveBeenCalled();
    });
    const writtenKeys = writeAvailability.mock.calls.map((call) => call[1]);
    expect(writtenKeys).toContain(SERVICES_KEY);
    expect(writtenKeys).not.toContain(TOURS_KEY);
  });
});
