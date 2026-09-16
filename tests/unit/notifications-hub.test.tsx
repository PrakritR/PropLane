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

describe("Notifications hub — paired kinds merge into one row", () => {
  it.each([
    ["application", "application_manager"],
    ["lease", "lease_manager"],
    ["inspection", "inspection_manager"],
  ] as const)("%s + %s render as one row, not two", async (primary, managerKind) => {
    const { container } = render(<ManagerPortalAutomationSettingsPanel />);
    await waitFor(() => expect(container.querySelector(`[data-attr="settings-row-${primary}"]`)).toBeTruthy());

    // Exactly one top-level row for the pair.
    expect(container.querySelectorAll(`[data-attr="settings-row-${primary}"]`)).toHaveLength(1);
    // The manager-alert half never gets its own top-level row.
    expect(container.querySelector(`[data-attr="settings-row-${managerKind}"]`)).toBeNull();
    // It is folded into the primary row as a nested escalation control instead.
    const primaryRow = row(container, primary);
    expect(primaryRow.querySelector(`[data-attr="settings-escalation-${managerKind}"]`)).toBeTruthy();
  });

  it("the merged row's second line carries the escalation text", async () => {
    const { container } = render(<ManagerPortalAutomationSettingsPanel />);
    await waitFor(() => expect(row(container, "application")).toBeTruthy());

    expect(row(container, "application").textContent).toContain(
      "Also alerts you when an application sits unfinished",
    );
    expect(row(container, "lease").textContent).toContain("Also alerts you when a lease needs your attention");
    expect(row(container, "inspection").textContent).toContain(
      "Also alerts you when move-in or move-out photos are still missing",
    );
  });
});

describe("Notifications hub — grouped by module", () => {
  it("uses the shared co-manager module mapping, not a second one", async () => {
    const { container } = render(<ManagerPortalAutomationSettingsPanel />);
    await waitFor(() => expect(moduleGroup(container, "services")).toBeTruthy());

    // service_order and work_order both map to "services" in
    // co-manager-notification-recipients.server.ts's REMINDER_SUBJECT_CO_MANAGER_MODULE.
    const services = moduleGroup(container, "services");
    expect(services.querySelector('[data-attr="settings-row-service_order"]')).toBeTruthy();
    expect(services.querySelector('[data-attr="settings-row-work_order"]')).toBeTruthy();

    // payment_manager maps to "payments", outgoing_payment maps to "financials" — different groups.
    const payments = moduleGroup(container, "payments");
    expect(payments.querySelector('[data-attr="settings-row-payment_manager"]')).toBeTruthy();
    expect(payments.querySelector('[data-attr="settings-row-outgoing_payment"]')).toBeNull();

    const financials = moduleGroup(container, "financials");
    expect(financials.querySelector('[data-attr="settings-row-outgoing_payment"]')).toBeTruthy();
  });
});

describe("Notifications hub — copy", () => {
  it('work_order renders as "Service visit" and "Work order" appears nowhere', async () => {
    const { container } = render(<ManagerPortalAutomationSettingsPanel />);
    await waitFor(() => expect(row(container, "work_order")).toBeTruthy());

    expect(row(container, "work_order").textContent).toContain("Service visit");
    expect(container.textContent).not.toContain("Work order");
    expect(container.textContent).not.toContain("work order");
  });

  it("quiet hours row is a label and its control, with no zone sentence under it", async () => {
    render(<ManagerPortalAutomationSettingsPanel />);
    await screen.findByText(/quiet hours/i);
    // The Pacific-zone explainer was subtext (AGENTS.md § No subtext); the
    // evaluation zone is documented on the setting itself, not under the row.
    expect(screen.queryByText(/Pacific time \(America\/Los_Angeles\)/)).toBeNull();
  });
});

describe("Notifications hub — fixed rule fields", () => {
  it("a tour_interest fixed field renders locked with the declared reason", async () => {
    stubFetch({
      tour_interest: {
        ...DEFAULT_REMINDER_SETTINGS.rules.tour_interest,
        enabled: true,
      },
    });
    const { container } = render(<ManagerPortalAutomationSettingsPanel />);
    await waitFor(() =>
      expect(container.querySelector('[data-attr="settings-fixed-reason-tour_interest"]')).toBeTruthy(),
    );

    const reason = container.querySelector('[data-attr="settings-fixed-reason-tour_interest"]');
    expect(reason?.textContent?.trim()).toBe(FIXED_RULE_FIELDS.tour_interest?.reason);

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-attr="settings-timings-tour_interest-trigger"]',
    );
    expect(trigger).not.toBeNull();
    expect(trigger?.disabled).toBe(true);
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
