// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TaskAssignDialog } from "@/components/portal/task-assign-dialog";

afterEach(cleanup);

const team = [
  { userId: "u1", name: "Jordan Lee", email: "jordan@example.com" },
  { userId: "u2", name: null, email: "pat@example.com" },
];

function mount(current: { type: "team"; id: string; name: string } | null) {
  render(<TaskAssignDialog open onClose={() => undefined} current={current} teamMembers={team} vendors={[]} onAssign={vi.fn()} />);
}

describe("TaskAssignDialog", () => {
  it("the field is labelled Assign to and a teammate is shown by display name", () => {
    mount({ type: "team", id: "u1", name: "Jordan Lee" });
    expect(screen.getAllByText("Assign to").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Jordan Lee/).length).toBeGreaterThan(0);
  });

  it("a current assignee who left the team starts on Unassigned, and the button never names them", () => {
    mount({ type: "team", id: "gone", name: "gone@example.com" });
    const button = document.querySelector('[data-attr="task-assign-submit"]') as HTMLButtonElement;
    expect(button.textContent).toBe("Assign");
    expect(button.disabled).toBe(true);
    expect(button.textContent).not.toContain("gone@example.com");
  });

  it("an assigned teammate gives a disabled button until someone else is picked", () => {
    mount({ type: "team", id: "u1", name: "Jordan Lee" });
    const button = document.querySelector('[data-attr="task-assign-submit"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Assign Jordan Lee");
  });
});
