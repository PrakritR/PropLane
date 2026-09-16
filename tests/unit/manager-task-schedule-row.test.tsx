// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ManagerTaskFormModal } from "@/components/portal/pro-task-form-modal";

const { suggestion } = vi.hoisted(() => ({
  suggestion: { current: null as null | { iso: string; source: "availability" | "proplane-pick" } },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/tasks",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/providers/app-ui-provider", () => {
  const appUi = { showToast: () => {} };
  return { useAppUi: () => appUi, useConfirm: () => () => Promise.resolve(true) };
});
vi.mock("@/hooks/use-work-assignment-directory", () => ({
  useWorkAssignmentDirectory: () => ({ teamMembers: [], vendors: [], ready: true }),
}));
vi.mock("@/lib/manager-portfolio-access", () => ({
  buildManagerPropertyFilterOptions: () => [],
}));
vi.mock("@/lib/manager-schedule-suggest.client", () => ({
  fetchManagerTimeSuggestion: vi.fn(() => Promise.resolve(suggestion.current)),
}));
vi.mock("@/lib/manager-tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/manager-tasks")>();
  return {
    ...actual,
    fetchManagerTask: () => Promise.resolve(null),
    createManagerTask: vi.fn(),
    updateManagerTask: vi.fn(),
  };
});

function source() {
  return document.querySelector('[data-attr="manager-task-start-suggest-source"]');
}

describe("Add task — Schedule row", () => {
  afterEach(() => {
    suggestion.current = null;
    cleanup();
  });

  it("shows the PropLane pick as label text, fills the slot, and has no Next open", async () => {
    suggestion.current = { iso: "2026-09-21T21:00:00.000Z", source: "proplane-pick" };
    render(<ManagerTaskFormModal open onClose={() => {}} managerUserId="mgr-1" />);
    await waitFor(() => expect(source()?.textContent).toBe("✦ PropLane pick"));
    expect(screen.getByLabelText("Schedule date")).toHaveValue("2026-09-21");
    expect(screen.getByLabelText("Start time")).not.toHaveValue("");
    expect(screen.getByLabelText("End time")).not.toHaveValue("");
    // The Badge-in-label and the side button are gone for good.
    expect(screen.queryByRole("button", { name: /next open/i })).toBeNull();
    expect(document.querySelector('[data-attr="manager-task-start-next-open"]')).toBeNull();
    expect(screen.queryByText("Books a slot on the calendar.")).toBeNull();
  });

  it("names the manager's own availability as the source", async () => {
    suggestion.current = { iso: "2026-09-21T21:00:00.000Z", source: "availability" };
    render(<ManagerTaskFormModal open onClose={() => {}} managerUserId="mgr-1" />);
    await waitFor(() => expect(source()?.textContent).toBe("From your availability"));
  });

  it("says nothing is free and leaves the fields empty when there is no suggestion", async () => {
    render(<ManagerTaskFormModal open onClose={() => {}} managerUserId="mgr-1" />);
    await waitFor(() => expect(source()?.textContent).toBe("Nothing free in 14 days"));
    expect(screen.getByLabelText("Schedule date")).toHaveValue("");
    expect(screen.queryByRole("button", { name: /next open/i })).toBeNull();
  });

  it("clears the source once the manager types their own time", async () => {
    suggestion.current = { iso: "2026-09-21T21:00:00.000Z", source: "proplane-pick" };
    render(<ManagerTaskFormModal open onClose={() => {}} managerUserId="mgr-1" />);
    await waitFor(() => expect(source()).not.toBeNull());
    fireEvent.change(screen.getByLabelText("Start time"), { target: { value: "16:30" } });
    expect(source()).toBeNull();
    expect(screen.getByLabelText("Start time")).toHaveValue("16:30");
  });

  it("shows a plain Schedule label when editing an existing task", async () => {
    suggestion.current = { iso: "2026-09-21T21:00:00.000Z", source: "proplane-pick" };
    render(<ManagerTaskFormModal open onClose={() => {}} managerUserId="mgr-1" editingId="task-1" />);
    await screen.findByText("Schedule");
    expect(source()).toBeNull();
  });
});
