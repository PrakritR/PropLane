// @vitest-environment jsdom
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import * as Dialog from "@radix-ui/react-dialog";
import { ExpenseRowMenu } from "@/components/portal/expense-row-menu";

function Harness() {
  const [editing, setEditing] = useState(false);
  return <>
    <ExpenseRowMenu onEdit={() => setEditing(true)} onDelete={() => setEditing(true)} />
    <Dialog.Root open={editing} onOpenChange={setEditing}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content aria-describedby={undefined}>
          <Dialog.Title>Edit expense</Dialog.Title>
          <button onClick={() => setEditing(false)}>Save changes</button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </>;
}

function openMenu() {
  fireEvent.keyDown(screen.getByRole("button", { name: "Expense actions" }), { key: "ArrowDown" });
}

describe("expense action menu dialog handoff", () => {
  it("leaves the page and menu usable after saving an edit", async () => {
    render(<Harness />);
    openMenu();
    const edit = await screen.findByRole("menuitem", { name: "Edit" });
    // A menu that opens a modal must not establish a second body lock.
    expect(document.body.style.pointerEvents).not.toBe("none");
    fireEvent.click(edit);
    expect(await screen.findByRole("dialog", { name: "Edit expense" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.body.style.pointerEvents).not.toBe("none");
    const trigger = screen.getByRole("button", { name: "Expense actions" });
    expect(trigger.closest('[aria-hidden="true"]')).toBeNull();
    openMenu();
    expect(await screen.findByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
  });
});
