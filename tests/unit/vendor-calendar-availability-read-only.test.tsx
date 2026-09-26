// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const demoMode = vi.fn(() => false);

vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: vi.fn() }) }));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => demoMode(),
}));
vi.mock("@/hooks/use-portal-session", () => ({ usePortalSession: () => ({ userId: "vendor-1", ready: true }) }));
vi.mock("@/hooks/use-work-assignment-directory", () => ({ useWorkAssignmentDirectory: () => ({ teamMembers: [], vendors: [] }) }));
vi.mock("@/lib/manager-work-orders-storage", () => ({
  MANAGER_WORK_ORDERS_EVENT: "axis:manager-work-orders",
  readVendorWorkOrderRows: () => [],
  syncManagerWorkOrdersFromServer: vi.fn(async () => undefined),
}));

import { installVendorAvailabilityPaintCache, VendorCalendarPanel } from "@/components/portal/vendor-calendar-panel";
import {
  VENDOR_AVAILABILITY_EDIT_REQUEST_EVENT,
  VendorAvailabilityEditor,
} from "@/components/portal/vendor-settings-panel";
import { readAvailabilityDateSetForStorageKey } from "@/lib/demo-admin-scheduling";
import { resetVendorAvailabilityCacheForTests, type VendorAvailabilityRule } from "@/lib/vendor-availability";

const response = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dateOffset(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

beforeEach(() => {
  demoMode.mockReturnValue(false);
  // Each case below renders its own editor/panel and expects its own fresh
  // fetch. The module-level read-coalescing cache in vendor-availability.ts
  // otherwise serves an earlier case's cached rules (or "no calls yet")
  // across renders within this file.
  resetVendorAvailabilityCacheForTests();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("vendor calendar canonical availability", () => {
  it("projects Flexible weekly rules for prior and distant calendar windows without a schedule write", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const storageKey = "vendor-calendar-flexible-read-only";
    const rules = [
      { id: "flex", kind: "weekly" as const, weekday: 1, startMinute: 0, endMinute: 1440, note: "Flexible" },
    ];

    installVendorAvailabilityPaintCache(storageKey, rules, { from: new Date(2099, 6, 27, 12, 0, 0, 0), dayCount: 7 });

    const priorSlots = readAvailabilityDateSetForStorageKey(storageKey);
    expect(priorSlots.has("2099-07-27:16")).toBe(true);
    expect(priorSlots.has("2099-07-27:35")).toBe(true);
    expect(priorSlots.has("2099-07-27:36")).toBe(false);

    installVendorAvailabilityPaintCache(storageKey, rules, { from: new Date(2099, 10, 2, 12, 0, 0, 0), dayCount: 7 });
    expect(readAvailabilityDateSetForStorageKey(storageKey).has("2099-11-02:16")).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("opens the shared dialog with the selected slot and saves exactly one canonical availability rule", async () => {
    const fetchSpy = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return response({
          ok: true,
          rule: { id: "open-1", kind: "open", specificDate: "2099-08-05", startMinute: 540, endMinute: 570 },
        });
      }
      return response({ rules: [] });
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(<VendorAvailabilityEditor dialog />);

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith("/api/vendor/availability", { credentials: "include" }));
    act(() => {
      window.dispatchEvent(
        new CustomEvent(VENDOR_AVAILABILITY_EDIT_REQUEST_EVENT, { detail: { date: "2099-08-05", slotIdx: 18 } }),
      );
    });

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Set availability")).toBeTruthy();
    expect(screen.getByDisplayValue("2099-08-05")).toBeTruthy();
    expect(screen.getByDisplayValue("09:00")).toBeTruthy();
    expect(screen.getByDisplayValue("09:30")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const posts = fetchSpy.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
      expect(posts).toHaveLength(1);
      expect(posts[0]?.[0]).toBe("/api/vendor/availability");
      expect(JSON.parse(String((posts[0]?.[1] as RequestInit).body))).toEqual({
        action: "upsert-open",
        specificDate: "2099-08-05",
        startMinute: 540,
        endMinute: 570,
        note: "",
      });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps Add availability available from the command bar and opens the dialog", async () => {
    demoMode.mockReturnValue(true);
    render(<VendorCalendarPanel tab="all" />);

    fireEvent.click(screen.getByRole("button", { name: "Add availability" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Set availability")).toBeTruthy();
  });

  it("keeps the availability dialog open when the canonical server rejects a booked-service conflict", async () => {
    const fetchSpy = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return { ok: false, json: async () => ({ error: "That time overlaps a scheduled service." }) } as Response;
      return response({ rules: [] });
    });
    vi.stubGlobal("fetch", fetchSpy);
    render(<VendorAvailabilityEditor dialog />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    act(() => window.dispatchEvent(new CustomEvent(VENDOR_AVAILABILITY_EDIT_REQUEST_EVENT, { detail: { date: "2099-08-05", slotIdx: 18 } })));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  });

  // `installVendorAvailabilityPaintCache` is exercised directly as the pure
  // utility it's exported to be — the underlying availability-window math is
  // the same whether the caller is painting the real week grid or a test.
  it("derives painted slots from weekly and one-off availability rules with adjacent empty states, no legacy requests", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const today = new Date();
    const date = localDate(today);
    const storageKey = "vendor-calendar-weekly-and-open";
    const rules: VendorAvailabilityRule[] = [
      { id: "weekly-8", kind: "weekly", weekday: today.getDay(), startMinute: 480, endMinute: 510 },
      { id: "open-9", kind: "open", specificDate: date, startMinute: 540, endMinute: 570 },
    ];

    installVendorAvailabilityPaintCache(storageKey, rules, { from: today, dayCount: 7 });

    const painted = readAvailabilityDateSetForStorageKey(storageKey);
    expect(painted.has(`${date}:16`)).toBe(true);
    expect(painted.has(`${date}:17`)).toBe(false);
    expect(painted.has(`${date}:18`)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps weekly availability visible before today and beyond twelve weeks", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const today = new Date();
    const storageKey = "vendor-calendar-weekly-multi-window";
    const rules: VendorAvailabilityRule[] = [
      { id: "weekly", kind: "weekly", weekday: today.getDay(), startMinute: 480, endMinute: 510 },
    ];

    installVendorAvailabilityPaintCache(storageKey, rules, { from: today, dayCount: 7 });
    expect(readAvailabilityDateSetForStorageKey(storageKey).has(`${localDate(today)}:16`)).toBe(true);

    const prior = dateOffset(today, -7);
    installVendorAvailabilityPaintCache(storageKey, rules, { from: prior, dayCount: 7 });
    expect(readAvailabilityDateSetForStorageKey(storageKey).has(`${localDate(prior)}:16`)).toBe(true);

    const distant = dateOffset(today, 13 * 7);
    installVendorAvailabilityPaintCache(storageKey, rules, { from: distant, dayCount: 7 });
    expect(readAvailabilityDateSetForStorageKey(storageKey).has(`${localDate(distant)}:16`)).toBe(true);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
