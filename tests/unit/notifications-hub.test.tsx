// @vitest-environment jsdom
/**
 * The Notifications hub (`ManagerPortalAutomationSettingsPanel`, mounted at
 * the `automation` tab / `/portal/settings/automation`) — the event matrix
 * grouped by module, paired kinds merged into one row, quiet hours and
 * manager alert routing at the top, and the read-only Sent history mounted
 * at the bottom.
 *
 * `fetch` is mocked and routed by URL: this panel's own
 * `/api/portal/reminder-settings`, `ManagerNotificationRoutingSetting`'s
 * `/api/portal/automation-settings` + `/api/manager/messaging-number`, and
 * `ReminderSentHistory`'s `/api/portal/reminder-history` all mount inside
 * this one hub and each fetch independently.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { DEFAULT_REMINDER_SETTINGS, type ReminderSettings } from "@/lib/reminders/rules";
import { FIXED_RULE_FIELDS } from "@/lib/reminders/fixed-rule-fields";
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

function moduleGroup(container: HTMLElement, moduleId: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-attr="settings-module-${moduleId}"]`);
  if (!el) throw new Error(`module group "${moduleId}" not found`);
  return el;
}

function row(container: HTMLElement, kind: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-attr="settings-row-${kind}"]`);
  if (!el) throw new Error(`row "${kind}" not found`);
  return el;
}

describe("Notifications hub — copy", () => {
  it("quiet hours row is a label and its control, with no zone sentence under it", async () => {
    render(<ManagerPortalAutomationSettingsPanel />);
    await screen.findByText(/quiet hours/i);
    // The Pacific-zone explainer was subtext (AGENTS.md § No subtext); the
    // evaluation zone is documented on the setting itself, not under the row.
    expect(screen.queryByText(/Pacific time \(America\/Los_Angeles\)/)).toBeNull();
  });
});

describe("Notifications hub — index (PLAN-0915)", () => {
  it("is globals plus an index into every area tab; no per-kind rows live here", async () => {
    const { container } = render(<ManagerPortalAutomationSettingsPanel />);
    await screen.findByText(/Everything sent automatically/i);
    for (const tab of ["applications", "tours", "lease", "services", "communication", "inspections"]) {
      expect(container.querySelector(`[data-attr="automation-index-${tab}"]`)).toBeTruthy();
    }
    expect(container.querySelector('[data-attr="settings-row-work_order"]')).toBeNull();
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
