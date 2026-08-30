// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ManagerTaskList } from "@/components/portal/manager-task-list";

const { pathnameRef } = vi.hoisted(() => ({
  pathnameRef: { current: "/portal/task-list/in-progress" },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => pathnameRef.current,
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", email: "mgr@example.com", ready: true }),
}));
vi.mock("@/components/providers/app-ui-provider", () => {
  // Stable identity: the real provider memoizes showToast, and the list's
  // refresh callback (and its load effect) keys off it.
  const appUi = { showToast: () => {} };
  return { useAppUi: () => appUi };
});
vi.mock("@/hooks/use-work-assignment-directory", () => ({
  useWorkAssignmentDirectory: () => ({ teamMembers: [], vendors: [], ready: true }),
}));
vi.mock("@/lib/demo-admin-scheduling", () => ({
  formatRangeLabel: () => "Tomorrow",
  syncScheduleRecordsFromServer: () => Promise.resolve(true),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({
  syncPropertyPipelineFromServer: () => Promise.resolve(true),
}));
vi.mock("@/lib/manager-portfolio-access", () => ({
  buildManagerPropertyFilterOptions: () => [],
}));
const tasks: unknown[] = [];

vi.mock("@/lib/manager-tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/manager-tasks")>();
  return {
    ...actual,
    MANAGER_TASKS_EVENT: "manager-tasks-changed",
    fetchManagerTasks: () => Promise.resolve(tasks),
    createManagerTask: vi.fn(),
    updateManagerTask: vi.fn(),
    deleteManagerTask: vi.fn(),
    reapplyManagerTasksToCalendar: vi.fn(),
  };
});
vi.mock("@/lib/service-requests-storage", () => ({
  SERVICE_REQUESTS_EVENT: "axis:service-requests",
  syncServiceRequestsFromServer: () => Promise.resolve([]),
}));
vi.mock("@/lib/manager-task-display", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/manager-task-display")>();
  return {
    ...actual,
    compactTaskLocationLabel: () => null,
    serviceRequestLocationLabel: () => null,
    serviceRequestsAssignedToViewer: () => [],
    taskNotesPreview: (notes: string) => ({ preview: notes, truncated: false }),
  };
});
vi.mock("@/components/portal/manager-task-form-modal", () => ({
  ManagerTaskFormModal: () => null,
}));

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    title: "Fix the porch light",
    propertyId: "prop-1",
    propertyTitle: "12 Maple St",
    completed: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("ManagerTaskList", () => {
  afterEach(() => {
    tasks.length = 0;
    pathnameRef.current = "/portal/task-list/in-progress";
    cleanup();
  });

  it("renders the task list shell and add row", async () => {
    render(<ManagerTaskList tabId="in-progress" basePath="/portal" />);
    expect(screen.getByRole("heading", { name: "Tasks" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /In progress/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Overdue/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Completed/i })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /^Filter\b/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^All\b/i })).not.toBeInTheDocument();
  });

  it("renders task rows grouped into clusters", async () => {
    tasks.push(makeTask());
    render(<ManagerTaskList tabId="in-progress" basePath="/portal" />);
    await waitFor(() => {
      expect(screen.getByText("Fix the porch light")).toBeInTheDocument();
    });
    expect(screen.getByText("1 item")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Select all/i })).toBeInTheDocument();
  });

  it("renders completed task rows", async () => {
    tasks.push(makeTask({ id: "task-2", title: "Replace filter", completed: true }));
    pathnameRef.current = "/portal/task-list/completed";
    render(<ManagerTaskList tabId="completed" basePath="/portal" />);
    await waitFor(() => {
      expect(screen.getByText("Replace filter")).toBeInTheDocument();
    });
  });
});
