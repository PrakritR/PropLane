// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { VendorTaskList } from "@/components/portal/vendor-task-list";

vi.mock("next/navigation", () => ({
  usePathname: () => "/vendor/tasks",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ userId: "vendor-user-1", ready: true }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: () => {} }),
}));
vi.mock("@/lib/demo/demo-session", () => ({
  isDemoModeActive: () => false,
}));
vi.mock("@/lib/demo-admin-scheduling", () => ({
  formatRangeLabel: () => "Tomorrow",
}));
vi.mock("@/lib/manager-task-display", () => ({
  compactTaskLocationLabel: () => "Oak House",
  taskNotesPreview: (notes: string) => ({ preview: notes, truncated: false }),
}));
vi.mock("@/lib/vendor-tasks.client", () => ({
  VENDOR_TASKS_EVENT: "vendor-tasks-changed",
  fetchVendorAssignedTasks: () =>
    Promise.resolve([
      {
        id: "task-1",
        title: "HVAC filter",
        completed: false,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        managerUserId: "mgr-1",
        managerName: "Alex Manager",
        vendorDirectoryId: "vendor-dir-1",
        start: "2026-08-10T15:00:00.000Z",
        end: "2026-08-10T16:00:00.000Z",
      },
    ]),
  updateVendorAssignedTask: vi.fn(),
}));

describe("VendorTaskList", () => {
  afterEach(() => cleanup());

  it("renders assigned tasks with status tabs", async () => {
    render(<VendorTaskList tabId="in-progress" basePath="/vendor" />);
    expect(screen.getByRole("heading", { name: "Tasks" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /In progress/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Completed/i })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("HVAC filter")).toBeInTheDocument();
    });
  });
});
