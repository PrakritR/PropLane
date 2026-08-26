// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ManagerTaskList } from "@/components/portal/manager-task-list";

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/task-list",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", email: "mgr@example.com", ready: true }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: () => {} }),
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
vi.mock("@/lib/manager-tasks", () => ({
  MANAGER_TASKS_EVENT: "manager-tasks-changed",
  fetchManagerTasks: () => Promise.resolve([]),
  createManagerTask: vi.fn(),
  updateManagerTask: vi.fn(),
  deleteManagerTask: vi.fn(),
  reapplyManagerTasksToCalendar: vi.fn(),
}));

describe("ManagerTaskList", () => {
  afterEach(() => cleanup());

  it("renders the task list shell and add row", async () => {
    render(<ManagerTaskList />);
    expect(screen.getByRole("heading", { name: "Task list" })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Add task" })).toBeInTheDocument();
    });
  });
});
