// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { fetchVendorAssignedTasks, updateVendorAssignedTask } from "@/lib/vendor-tasks.client";
import { VendorTaskList } from "@/components/portal/vendor-task-list";

vi.mock("next/navigation", () => ({
  usePathname: () => "/vendor/tasks",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ userId: "vendor-user-1", ready: true }),
}));
const { appUi } = vi.hoisted(() => ({ appUi: { showToast: vi.fn() } }));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => (req: { description?: unknown }) =>
    Promise.resolve(
      typeof window === "undefined"
        ? true
        : window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
    ),

  // Match the provider: showToast is memoized independently of toast state.
  useAppUi: () => appUi,
}));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  // Spread the real module: this file only needs to override demo mode,
  // and a hand-listed mock silently breaks every time the module gains an
  // export a component calls at import time.
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
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
  fetchVendorAssignedTasks: vi.fn(() =>
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
    ])),
  updateVendorAssignedTask: vi.fn(),
}));

describe("VendorTaskList", () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it("renders assigned tasks with status tabs", async () => {
    const { rerender } = render(<VendorTaskList tabId="in-progress" basePath="/vendor" />);
    // Tasks is its own vendor section again: the page is titled Tasks and links back to Jobs.
    expect(screen.getByRole("heading", { name: "Tasks" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Jobs/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /In progress/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Completed/i })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("HVAC filter")).toBeInTheDocument();
    });
    expect(fetchVendorAssignedTasks).toHaveBeenCalledExactlyOnceWith("vendor-user-1");
    rerender(<VendorTaskList tabId="in-progress" basePath="/vendor" />);
    expect(screen.getByText("HVAC filter")).toBeInTheDocument();
    expect(fetchVendorAssignedTasks).toHaveBeenCalledTimes(1);
  });

  it("each row carries a ⋯ menu (L4), so a task can be completed without the bulk dock", async () => {
    render(<VendorTaskList tabId="in-progress" basePath="/vendor" />);
    await waitFor(() => expect(screen.getByText("HVAC filter")).toBeInTheDocument());
    const complete = screen.getByRole("button", { name: "Mark completed · HVAC filter" });
    fireEvent.click(complete);
    await waitFor(() =>
      expect(updateVendorAssignedTask).toHaveBeenCalledWith("vendor-user-1", { managerUserId: "mgr-1", taskId: "task-1", completed: true }),
    );
  });
});
