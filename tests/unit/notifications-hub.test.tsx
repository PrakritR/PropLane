// @vitest-environment jsdom
/**
 * The Notifications hub (`ManagerPortalAutomationSettingsPanel`, mounted at
 * the `automation` tab / `/portal/settings/automation`) — the event matrix
 * grouped by module, paired kinds merged into one row, quiet hours at the
 * top, and the read-only Sent history mounted at the bottom. Manager alert
 * routing lives on Account → Notifications.
 *
 * `fetch` is mocked and routed by URL: this panel's own
 * `/api/portal/reminder-settings` and `ReminderSentHistory`'s
 * `/api/portal/reminder-history` mount inside this hub and each fetch
 * independently.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DEFAULT_REMINDER_SETTINGS, type ReminderSettings } from "@/lib/reminders/rules";
import {
  MANAGER_SETTINGS_ENTRY_POINTS,
  getSettingsEntryPointForTab,
} from "@/components/portal/settings-entry-points";

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast }),
}));

import { ManagerPortalAutomationSettingsPanel } from "@/components/portal/pro-portal-automation-settings-panel";

function reminderSettingsResponse(overrides: Partial<ReminderSettings["rules"]> = {}) {
  return {
    settings: {
      ...DEFAULT_REMINDER_SETTINGS,
      rules: { ...DEFAULT_REMINDER_SETTINGS.rules, ...overrides },
    },
  };
}

function stubFetch(reminderRuleOverrides: Partial<ReminderSettings["rules"]> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/portal/reminder-settings")) {
        return { ok: true, json: async () => reminderSettingsResponse(reminderRuleOverrides) } as Response;
      }
      if (url.startsWith("/api/portal/automation-settings")) {
        return { ok: true, json: async () => ({ settings: {} }) } as Response;
      }
      if (url.startsWith("/api/manager/messaging-number")) {
        return { ok: false, json: async () => ({}) } as Response;
      }
      if (url.startsWith("/api/portal/reminder-history")) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: "hist-1",
                kind: "tour",
                kindLabel: "Tours",
                status: "sent",
                recipientEmail: "guest@example.com",
                recipientPhone: null,
                recipientRole: "counterparty",
                channel: "email",
                sendAtLabel: "Sep 10, 10:00 AM",
                sentAtLabel: "Sep 10, 10:00 AM",
                lastError: null,
              },
            ],
            nextCursor: null,
            smsUiEnabled: false,
          }),
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    }),
  );
}

beforeEach(() => {
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  showToast.mockReset();
});

describe("Notifications hub — copy", () => {
  it("quiet hours row is a label and its control, with no zone sentence under it", async () => {
    render(<ManagerPortalAutomationSettingsPanel />);
    await screen.findByText(/quiet hours/i);
    // The Pacific-zone explainer was subtext (AGENTS.md § No subtext); the
    // evaluation zone is documented on the setting itself, not under the row.
    expect(screen.queryByText(/Pacific time \(America\/Los_Angeles\)/)).toBeNull();
  });
});

describe("Notifications hub — rules & messages (C111)", () => {
  it("is globals plus every area's reminder rules and automated messages, grouped and filterable", async () => {
    const { container } = render(<ManagerPortalAutomationSettingsPanel />);
    // WS4 (PLAN-0925 Part 5, C190): the read-only "What PropLane sends" list
    // sits ahead of the per-area groups, so the manager finds the shipped
    // defaults before the actual editable rules.
    await screen.findByText(/Rules & messages/i);
    // C111: every area tab's own Reminders/Messages section moved HERE,
    // grouped by area — including Bookings and Inspections, whose settings
    // tabs are gone (C116) because that was all they held.
    for (const heading of [
      "Applications",
      "Lease, move-in & move-out",
      "Tasks",
      "Residents",
      "Payments",
      "Services & vendors",
      "Communication",
      "Bookings",
      "Inspections",
    ]) {
      // `WhatProplaneSends` groups its own read-only list by the same area
      // names, so a heading can legitimately appear more than once.
      expect((await screen.findAllByText(heading)).length).toBeGreaterThan(0);
    }
    // The area filter is a dropdown, not a link-out index.
    expect(container.querySelector('[data-attr="automation-index-applications"]')).toBeNull();
    expect(container.querySelector('[data-attr="reminders-area-filter"]')).toBeTruthy();
    expect(container.textContent).not.toContain("Work order");
  });
});

describe("Notifications hub — Sent history", () => {
  it("mounts and renders the read-only sent history", async () => {
    render(<ManagerPortalAutomationSettingsPanel />);
    await screen.findByText("Sent history");
    await screen.findByText("guest@example.com");
  });
});

describe("Notifications hub — registry entries", () => {
  it("notifications and communication entries follow the settings-open-<id> scheme", () => {
    expect(MANAGER_SETTINGS_ENTRY_POINTS.notifications.dataAttr).toBe("settings-open-notifications");
    expect(MANAGER_SETTINGS_ENTRY_POINTS.communication.dataAttr).toBe("settings-open-communication");
    expect(getSettingsEntryPointForTab("automation")).toBe(MANAGER_SETTINGS_ENTRY_POINTS.notifications);
    expect(getSettingsEntryPointForTab("communication")).toBe(MANAGER_SETTINGS_ENTRY_POINTS.communication);
  });
});
