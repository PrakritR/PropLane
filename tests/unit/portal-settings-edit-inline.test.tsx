// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { showToast } = vi.hoisted(() => ({
  showToast: vi.fn(),
}));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
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

import { ProPortalSettingsModal } from "@/components/portal/pro-portal-settings-modal";

const ROOT = process.cwd();

afterEach(() => {
  cleanup();
  showToast.mockClear();
});

describe("application and lease form editors live inside settings", () => {
  it("wires Form | Automation into the settings sheet and drops the chevron rows", () => {
    const modal = readFileSync(join(ROOT, "src/components/portal/pro-portal-settings-modal.tsx"), "utf8");
    const chrome = readFileSync(join(ROOT, "src/components/portal/property-form-automation-chrome.tsx"), "utf8");
    const applications = readFileSync(join(ROOT, "src/components/portal/pro-applications.tsx"), "utf8");
    const leases = readFileSync(join(ROOT, "src/components/portal/pro-leases.tsx"), "utf8");

    expect(chrome).toContain('data-attr={`manager-settings-pane-${item.id}`}');
    expect(modal).toContain("FormAutomationPaneSwitch");
    expect(modal).toContain("ManagerPropertyApplicationFormEditor");
    expect(modal).toContain("ManagerPropertyLeaseFormEditor");
    expect(modal).toContain("max-w-4xl");

    expect(applications).not.toMatch(/\beditAction\s*=/);
    expect(applications).not.toContain("Edit application form");
    expect(leases).not.toMatch(/\beditAction\s*=/);
    expect(leases).not.toContain("Edit lease configuration");
  });

  it("opens application settings on Form, without a close-and-reopen chevron", async () => {
    render(
      <ProPortalSettingsModal
        open
        onClose={() => undefined}
        initialTab="applications"
        propertyOptions={[]}
      />,
    );

    expect(screen.getByRole("button", { name: "Form" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Automation" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /edit application form/i })).toBeNull();
    expect(screen.getByText("Add a property listing before configuring these settings.")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Automation" }));
    expect(screen.queryByText("Add a property listing before configuring these settings.")).toBeNull();
  });
});
