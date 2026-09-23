// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceTasksField } from "@/components/portal/service-tasks-field";

afterEach(cleanup);

describe("ServiceTasksField", () => {
  it("is a checkbox; Assignee appears only when checked", () => {
    const onEnabledChange = vi.fn();
    const onAssigneeChange = vi.fn();
    const { rerender } = render(
      <ServiceTasksField
        enabled={false}
        onEnabledChange={onEnabledChange}
        assignee={null}
        onAssigneeChange={onAssigneeChange}
        teamMembers={[{ userId: "mgr-1", name: "Alex", email: "alex@example.com" }]}
        vendors={[{ id: "v-1", name: "Pipe Pro", trade: "Plumbing", active: true }]}
      />,
    );
    expect(screen.getByRole("checkbox", { name: "Add task" })).not.toBeChecked();
    expect(screen.queryByText("Assignee")).toBeNull();
    expect(screen.queryByText("+ Add task")).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "Add task" }));
    expect(onEnabledChange).toHaveBeenCalledWith(true);

    rerender(
      <ServiceTasksField
        enabled
        onEnabledChange={onEnabledChange}
        assignee={null}
        onAssigneeChange={onAssigneeChange}
        teamMembers={[{ userId: "mgr-1", name: "Alex", email: "alex@example.com" }]}
        vendors={[{ id: "v-1", name: "Pipe Pro", trade: "Plumbing", active: true }]}
      />,
    );
    expect(screen.getByText("Assignee")).toBeTruthy();
  });

  it("clears the assignee when Add task is unchecked", () => {
    const onAssigneeChange = vi.fn();
    render(
      <ServiceTasksField
        enabled
        onEnabledChange={() => {}}
        assignee={{ type: "team", id: "mgr-1", name: "Alex" }}
        onAssigneeChange={onAssigneeChange}
        teamMembers={[{ userId: "mgr-1", name: "Alex" }]}
        vendors={[]}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Add task" }));
    expect(onAssigneeChange).toHaveBeenCalledWith(null);
  });
});
