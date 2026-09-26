// @vitest-environment jsdom
//
// Tasks renders card rows now (like Leases/Residents), not a table: one card
// per task, facts derived from the row data, no pills, no group headers, a
// ⋯ per row in the shared order, and the shared empty state per tab.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ManagerTaskList } from "@/components/portal/pro-task-list";
import { deleteManagerTask, updateManagerTask } from "@/lib/manager-tasks";

const { pathnameRef } = vi.hoisted(() => ({
  pathnameRef: { current: "/portal/tasks" },
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
  const appUi = { showToast: () => {} };
  const confirmViaWindow = (req: { description?: unknown }) =>
    Promise.resolve(window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"));
  return { useAppUi: () => appUi, useConfirm: () => confirmViaWindow };
});
vi.mock("@/hooks/use-work-assignment-directory", () => ({
  useWorkAssignmentDirectory: () => ({ teamMembers: [], vendors: [], ready: true }),
}));
vi.mock("@/lib/demo-admin-scheduling", () => ({
  formatRangeLabel: (start: string, end: string) => `${start}–${end}`,
  syncScheduleRecordsFromServer: () => Promise.resolve(true),
  formatAvailabilitySlotLabel: (slot: number) => `slot ${slot}`,
}));
vi.mock("@/lib/demo-property-pipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/demo-property-pipeline")>();
  return { ...actual, syncPropertyPipelineFromServer: () => Promise.resolve(true) };
});
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
vi.mock("@/components/portal/pro-task-form-modal", () => ({
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

describe("Tasks card rows", () => {
  // The fixtures use fixed due dates; pin "today" before them so a task due
  // on 2026-09-25 stays In progress instead of moving buckets on that date.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-20T12:00:00"));
  });
  afterEach(() => {
    vi.useRealTimers();
    tasks.length = 0;
    pathnameRef.current = "/portal/tasks";
    cleanup();
  });

  it("renders one card per task with the place line and no table markup", async () => {
    tasks.push(makeTask({ id: "task-1", title: "Fix the porch light", propertyTitle: "12 Maple St" }));
    tasks.push(makeTask({ id: "task-2", title: "Replace filter", propertyId: "prop-2", propertyTitle: "9 Cedar Ln" }));
    render(<ManagerTaskList tabId="in-progress" basePath="/portal" />);
    await waitFor(() => {
      expect(screen.getByText("Fix the porch light")).toBeInTheDocument();
    });
    expect(screen.getByText("12 Maple St")).toBeInTheDocument();
    expect(screen.getByText("9 Cedar Ln")).toBeInTheDocument();
    expect(document.querySelectorAll("table").length).toBe(0);
    // No property/assignee group header above the rows.
    const groups = document.querySelector('[data-attr="manager-task-groups"]');
    expect(groups?.children.length).toBe(2);
  });

  it("derives facts from the row data and never shows a status pill", async () => {
    tasks.push(
      makeTask({
        id: "task-1",
        title: "Fix the porch light",
        dueDate: "2026-09-25",
        priority: "high",
        assignee: { type: "team", id: "u2", name: "Dana Ramirez" },
      }),
    );
    render(<ManagerTaskList tabId="in-progress" basePath="/portal" />);
    await waitFor(() => {
      expect(screen.getByText("Fix the porch light")).toBeInTheDocument();
    });
    expect(screen.getByText("Dana Ramirez")).toBeInTheDocument();
    expect(screen.getByText("High")).toBeInTheDocument();
    expect(screen.getByText("Fri, Sep 25")).toBeInTheDocument();
    // No pill/badge classes on the row.
    const row = document.querySelector('[data-attr="manager-task-row"]');
    expect(row?.querySelector(".portal-badge, [class*=\"rounded-full\"][class*=\"bg-\"]")).toBeNull();
  });

  it("names Normal priority nowhere on the row", async () => {
    tasks.push(makeTask({ id: "task-1", title: "Fix the porch light", priority: "medium" }));
    render(<ManagerTaskList tabId="in-progress" basePath="/portal" />);
    await waitFor(() => {
      expect(screen.getByText("Fix the porch light")).toBeInTheDocument();
    });
    expect(screen.queryByText("Normal")).toBeNull();
  });

  it("opens a ⋯ menu per row in the shared order: Edit, Mark done, then Delete", async () => {
    tasks.push(makeTask());
    render(<ManagerTaskList tabId="in-progress" basePath="/portal" />);
    await waitFor(() => {
      expect(screen.getByText("Fix the porch light")).toBeInTheDocument();
    });
    fireEvent.keyDown(screen.getByRole("button", { name: /Actions for Fix the porch light/i }), { key: "ArrowDown" });
    const menu = await screen.findByRole("menu");
    const labels = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((el) => el.textContent);
    expect(labels).toEqual(["Edit", "Mark done", "Delete"]);
  });

  it("marks the task done from its own ⋯ menu", async () => {
    tasks.push(makeTask());
    render(<ManagerTaskList tabId="in-progress" basePath="/portal" />);
    await waitFor(() => {
      expect(screen.getByText("Fix the porch light")).toBeInTheDocument();
    });
    fireEvent.keyDown(screen.getByRole("button", { name: /Actions for Fix the porch light/i }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Mark done" }));
    await waitFor(() => {
      expect(updateManagerTask).toHaveBeenCalledWith("mgr-1", "task-1", { completed: true });
    });
  });

  it("deletes a task from its own ⋯ menu after confirming", async () => {
    tasks.push(makeTask());
    render(<ManagerTaskList tabId="in-progress" basePath="/portal" />);
    await waitFor(() => {
      expect(screen.getByText("Fix the porch light")).toBeInTheDocument();
    });
    fireEvent.keyDown(screen.getByRole("button", { name: /Actions for Fix the porch light/i }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(deleteManagerTask).toHaveBeenCalledWith("mgr-1", "task-1");
    });
  });

  it("shows a completed date fact on the Done tab", async () => {
    tasks.push(makeTask({ id: "task-2", title: "Replace filter", completed: true, updatedAt: "2026-09-09" }));
    pathnameRef.current = "/portal/tasks/completed";
    render(<ManagerTaskList tabId="completed" basePath="/portal" />);
    await waitFor(() => {
      expect(screen.getByText("Replace filter")).toBeInTheDocument();
    });
    expect(screen.getByText("Wed, Sep 9")).toBeInTheDocument();
  });

  it("shows the shared empty card and correct tab counts when a tab has no rows", async () => {
    tasks.push(makeTask({ id: "task-1", title: "Fix the porch light" }));
    render(<ManagerTaskList tabId="overdue" basePath="/portal" />);
    await waitFor(() => {
      expect(screen.getByRole("link", { name: /^Open/i })).toBeInTheDocument();
    });
    // Open carries the one in-progress task; Overdue is empty.
    expect(screen.getByRole("link", { name: /^Open/i }).textContent).toContain("1");
    expect(screen.getByRole("link", { name: /Overdue/i }).textContent).toContain("0");
    expect(screen.queryByText("Fix the porch light")).not.toBeInTheDocument();
  });
});
