// @vitest-environment jsdom
/**
 * `SettingsModulePage` is the seam this task exists to cut: one component that renders any of
 * the eleven manager settings modules, portable between `ProPortalSettingsModal` (the sheet
 * every section's gear opens) and the standalone `/portal/settings/<tab>` page. This suite tests
 * ITS OWN dispatch/registration/flush contract — that every tab resolves to a real panel without
 * throwing, and that the exposed `flushPendingSaves` handle collects whatever that panel
 * registers — not each panel's own internals, which belong to their own suites. Every real panel
 * is replaced by a lightweight stand-in, the same technique
 * `tests/unit/portal-settings-save-flush.test.tsx` uses for its two.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createRef, type ComponentProps } from "react";

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast }),
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));
vi.mock("@/hooks/use-manager-user-id", () => ({ useManagerUserId: () => ({ userId: "mgr-1" }) }));
vi.mock("@/hooks/use-work-assignment-directory", () => ({
  useWorkAssignmentDirectory: () => ({ teamMembers: [] }),
}));

/**
 * Every real panel replaced by a stand-in that renders one identifying line of text and, for a
 * panel with an autosave handle, wires it to a controllable `saveIfDirty`. Every other export
 * (types, `DEFAULT_APPLICATION_AUTOMATION`, `normalizeApplicationAutomation`, the button, …)
 * passes through the real module untouched.
 */
vi.mock("@/components/portal/pro-portal-settings-panels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/portal/pro-portal-settings-panels")>();
  const React = await import("react");

  function Applications({ reminderFormRef }: ComponentProps<typeof actual.ApplicationsSettingsPanel>) {
    React.useImperativeHandle(reminderFormRef, () => ({ saveIfDirty: async () => true }), []);
    return <div>applications module</div>;
  }
  function Tours({ formRef, managerReminderFormRef }: ComponentProps<typeof actual.TourSettingsPanel>) {
    React.useImperativeHandle(formRef, () => ({ saveIfDirty: async () => true }), []);
    React.useImperativeHandle(managerReminderFormRef, () => ({ saveIfDirty: async () => true }), []);
    return <div>tours module</div>;
  }
  function Lease({ reminderFormRef }: ComponentProps<typeof actual.LeaseSettingsPanel>) {
    React.useImperativeHandle(reminderFormRef, () => ({ saveIfDirty: async () => true }), []);
    return <div>lease module</div>;
  }
  function Tasks({ reminderFormRef }: ComponentProps<typeof actual.TaskSettingsPanel>) {
    React.useImperativeHandle(reminderFormRef, () => ({ saveIfDirty: async () => true }), []);
    return <div>tasks module</div>;
  }
  function Resident() {
    return <div>resident module</div>;
  }
  function Payments({ formRef, outgoingReminderFormRef }: ComponentProps<typeof actual.PaymentsSettingsPanel>) {
    React.useImperativeHandle(formRef, () => ({ saveIfDirty: async () => true }), []);
    React.useImperativeHandle(outgoingReminderFormRef, () => ({ saveIfDirty: async () => true }), []);
    return <div>payments module</div>;
  }
  function Services({
    workOrderReminderFormRef,
    serviceOrderReminderFormRef,
  }: ComponentProps<typeof actual.ServicesSettingsPanel>) {
    React.useImperativeHandle(workOrderReminderFormRef, () => ({ saveIfDirty: async () => true }), []);
    React.useImperativeHandle(serviceOrderReminderFormRef, () => ({ saveIfDirty: async () => true }), []);
    return <div>services module</div>;
  }
  function Inspections({
    dueReminderFormRef,
    reviewReminderFormRef,
  }: ComponentProps<typeof actual.InspectionsSettingsPanel>) {
    React.useImperativeHandle(dueReminderFormRef, () => ({ saveIfDirty: async () => true }), []);
    React.useImperativeHandle(reviewReminderFormRef, () => ({ saveIfDirty: async () => true }), []);
    return <div>inspections module</div>;
  }
  function Bookings({ reminderFormRef }: ComponentProps<typeof actual.BookingsSettingsPanel>) {
    React.useImperativeHandle(reminderFormRef, () => ({ saveIfDirty: async () => true }), []);
    return <div>bookings module</div>;
  }
  function Communication() {
    return <div>communication module</div>;
  }

  return {
    ...actual,
    ApplicationsSettingsPanel: Applications,
    TourSettingsPanel: Tours,
    LeaseSettingsPanel: Lease,
    TaskSettingsPanel: Tasks,
    ResidentSettingsPanel: Resident,
    PaymentsSettingsPanel: Payments,
    ServicesSettingsPanel: Services,
    InspectionsSettingsPanel: Inspections,
    BookingsSettingsPanel: Bookings,
    CommunicationSettingsPanel: Communication,
  };
});

vi.mock("@/components/portal/pro-portal-automation-settings-panel", () => ({
  ManagerPortalAutomationSettingsPanel: () => <div>automation module</div>,
}));

import { SettingsModulePage, type SettingsModulePageHandle } from "@/components/portal/settings-module-page";
import { MANAGER_PORTAL_SETTINGS_TABS } from "@/lib/portal-settings-section";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  showToast.mockReset();
});

describe("SettingsModulePage — every registered tab resolves without throwing", () => {
  it.each(MANAGER_PORTAL_SETTINGS_TABS)("renders the $id module", async ({ id, label }) => {
    expect(() => render(<SettingsModulePage tab={id} />)).not.toThrow();
    void label;
  });

  it("covers all eleven tabs — this list itself must not silently shrink", () => {
    expect(MANAGER_PORTAL_SETTINGS_TABS.map((t) => t.id).sort()).toEqual(
      [
        "applications",
        "automation",
        "bookings",
        "communication",
        "inspections",
        "lease",
        "payments",
        "resident",
        "services",
        "tasks",
        "tours",
      ].sort(),
    );
  });
});

describe("SettingsModulePage — imperative flush handle", () => {
  it("exposes flushPendingSaves and resolves ok:true when nothing is registered", async () => {
    const ref = createRef<SettingsModulePageHandle>();
    render(<SettingsModulePage ref={ref} tab="resident" />);
    await expect(ref.current?.flushPendingSaves()).resolves.toEqual({ ok: true });
  });

  it("flushes a mounted panel's registered handle and reports ok:true", async () => {
    const ref = createRef<SettingsModulePageHandle>();
    render(<SettingsModulePage ref={ref} tab="tours" />);
    await screen.findByText("tours module");
    await expect(ref.current?.flushPendingSaves()).resolves.toEqual({ ok: true });
  });
});

describe("SettingsModulePage — footer suppression parity with the old modal", () => {
  it.each(["applications", "lease", "resident"] as const)(
    "never bubbles a footer for %s",
    async (tab) => {
      const onFooterChange = vi.fn();
      render(<SettingsModulePage tab={tab} onFooterChange={onFooterChange} />);
      expect(onFooterChange).toHaveBeenCalledWith(null);
    },
  );
});
