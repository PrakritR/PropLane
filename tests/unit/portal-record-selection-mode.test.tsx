// @vitest-environment jsdom
import { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { RowSelectCheckbox } from "@/components/ui/row-select-checkbox";
import userEvent from "@testing-library/user-event";
import { PortalSectionActionRow } from "@/components/portal/portal-section-action-row";
import { PortalAdaptiveActionRow } from "@/components/portal/portal-adaptive-action-row";
import { DataList } from "@/components/ui/data-list";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
vi.mock("next/navigation", () => ({ usePathname: () => "/portal/test" }));
afterEach(cleanup);

const save = vi.fn();
function List({ rows = ["a", "b", "locked"], loading = false, loadError }: { rows?: string[]; loading?: boolean; loadError?: string }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  return <PortalRecordListSurface loading={loading} loadError={loadError} isEmpty={!rows.length}
    add={{ ariaLabel: "Add test record", onClick: () => {} }}
    onBulkClear={() => setSelected(new Set())} bulkCount={selected.size}
    bulkActions={selected.size ? <Button onClick={() => save([...selected])}>Edit record</Button> : null}>
    <RowSelectCheckbox aria-label="Select all records" />
    {rows.map((id) => <div key={id}><RowSelectCheckbox aria-label={`Select ${id}`} disabled={id === "locked"} checked={selected.has(id)} onChange={(e) => setSelected((current) => { const next = new Set(current); if (e.target.checked) next.add(id); else next.delete(id); return next; })} />{id}</div>)}
  </PortalRecordListSurface>;
}
function open(label: string) { fireEvent.keyDown(screen.getByRole("button", { name: `Actions for ${label}` }), { key: "ArrowDown" }); }

describe("per-record action menus", () => {
  it("has no Select strip, visible checkboxes, or group actions", () => {
    render(<List />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Select", exact: true })).toBeNull();
    expect(screen.queryByRole("button", { name: "Actions for all records" })).toBeNull();
    expect(screen.getByRole("button", { name: "Actions for locked" })).toHaveProperty("disabled", true);
  });
  it("uses only the record whose menu was opened, including successive actions", async () => {
    save.mockClear(); render(<List />);
    open("a");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit record" }));
    expect(save).toHaveBeenLastCalledWith(["a"]);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    open("b"); fireEvent.click(await screen.findByRole("menuitem", { name: "Edit record" }));
    expect(save).toHaveBeenLastCalledWith(["b"]);
  });
  it("closes a removed record's menu when filtering removes its row", async () => {
    const { rerender } = render(<List rows={["a", "b"]} />);
    open("a"); await screen.findByRole("menuitem", { name: "Edit record" });
    rerender(<List rows={["b"]} />);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
  it("closes and clears actions on a workspace change", async () => {
    render(<List />); open("a"); await screen.findByRole("menuitem", { name: "Edit record" });
    fireEvent(window, new Event("proplane-workspace-selection"));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    open("b"); fireEvent.click(await screen.findByRole("menuitem", { name: "Edit record" }));
    expect(save).toHaveBeenLastCalledWith(["b"]);
  });
  it("keeps form checkboxes outside lists and hides empty states during loading/errors", () => {
    const { rerender } = render(<><RowSelectCheckbox aria-label="Form permission" /><List rows={[]} loading /></>);
    expect(screen.getByRole("checkbox", { name: "Form permission" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "Loading records" })).toBeTruthy();
    expect(screen.queryByText("Nothing here yet")).toBeNull();
    rerender(<List rows={[]} loadError="Could not load records" />);
    expect(screen.getByRole("alert").textContent).toContain("Could not load records");
    expect(screen.queryByText("Nothing here yet")).toBeNull();
  });
});


describe("record-menu interaction boundaries", () => {
  it("does not navigate a custom clickable row and preserves input callback/ref contracts", async () => {
    const navigate = vi.fn();
    const clicked = vi.fn();
    const input = createRef<HTMLInputElement>();
    function CustomRow() {
      const [selected, setSelected] = useState(false);
      return <PortalRecordListSurface onBulkClear={() => setSelected(false)} bulkActions={selected ? <Button>Edit custom record</Button> : null}>
        <div onClick={navigate}><RowSelectCheckbox ref={input} onClick={clicked} aria-label="Select custom" checked={selected} onChange={(event) => setSelected(event.target.checked)} />Custom row</div>
      </PortalRecordListSurface>;
    }
    render(<CustomRow />);
    open("custom");
    await screen.findByRole("menuitem", { name: "Edit custom record" });
    expect(navigate).not.toHaveBeenCalled();
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(input.current?.checked).toBe(true);
    expect(input.current?.hidden).toBe(true);
  });

  it("supports keyboard navigation, skips disabled actions, and restores trigger focus on Escape", async () => {
    const user = userEvent.setup();
    render(<PortalRecordListSurface onBulkClear={() => {}} bulkActions={<PortalSectionActionRow variant="header"><Button>First action</Button><Button disabled>Unavailable action</Button><Button>Last action</Button></PortalSectionActionRow>}>
      <RowSelectCheckbox aria-label="Select keyboard record" checked={false} onChange={() => {}} />
    </PortalRecordListSurface>);
    const trigger = screen.getByRole("button", { name: "Actions for keyboard record" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "First action" })).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Last action" })).toHaveFocus();
    expect(screen.getByRole("menuitem", { name: "Unavailable action" })).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps the activated record available to its editor after its menu closes", async () => {
    const saved = vi.fn();
    function EditorList() {
      const [selected, setSelected] = useState<string | null>(null);
      const [editing, setEditing] = useState(false);
      return <><PortalRecordListSurface onBulkClear={() => setSelected(null)} bulkActions={selected ? <Button onClick={() => setEditing(true)}>Edit</Button> : null}>
        {["a", "b"].map((id) => <RowSelectCheckbox key={id} aria-label={`Select ${id}`} checked={selected === id} onChange={() => setSelected(id)} />)}
      </PortalRecordListSurface><Modal open={editing} title="Record editor" onClose={() => setEditing(false)} assistantStrip={false} presentation="dialog"><Button onClick={() => saved(selected)}>Save editor</Button></Modal></>;
    }
    render(<EditorList />);
    open("b");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Save editor" }));
    expect(saved).toHaveBeenCalledWith("b");
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("makes every adaptive action keyboard-addressable without nesting a second overflow menu", async () => {
    const actions = ["Edit", "Download", "Archive"].map((label) => ({ id: label, node: <Button>{label}</Button>, menuItem: <span>{label}</span> }));
    render(<PortalRecordListSurface onBulkClear={() => {}} bulkActions={<PortalAdaptiveActionRow actions={actions} maxVisible={1} />}>
      <RowSelectCheckbox aria-label="Select adaptive record" checked={false} onChange={() => {}} />
    </PortalRecordListSurface>);
    open("adaptive record");
    expect(await screen.findByRole("menuitem", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Download" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Archive" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });
});


it("places desktop row actions in the trailing cell and keeps mobile row activation separate", async () => {
  const navigate = vi.fn();
  function TableList() {
    const [selected, setSelected] = useState(false);
    return <PortalRecordListSurface onBulkClear={() => setSelected(false)} bulkActions={selected ? <Button>Download record</Button> : null}>
      <DataList selectable rows={[{ id: "a", primary: "Record A", actionLabel: "Record A", data: "Record A", selected, onSelectedChange: setSelected, onClick: navigate }]} columns={[{ id: "name", header: "Name", cell: (name: string) => name }]} />
    </PortalRecordListSurface>;
  }
  const { container } = render(<TableList />);
  const desktop = container.querySelector('[data-slot="data-list-desktop-row"]')!;
  expect(desktop.lastElementChild?.querySelector('[data-attr="record-actions-trigger"]')).toBeTruthy();
  const mobile = container.querySelector('[data-slot="data-list-mobile-row"]')!;
  const trigger = mobile.querySelector<HTMLButtonElement>('[data-attr="record-actions-trigger"]')!;
  expect(trigger.parentElement?.parentElement?.tagName).not.toBe("BUTTON");
  expect(trigger.className).toContain("h-11");
  expect(trigger.className).toContain("w-11");
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  await screen.findByRole("menuitem", { name: "Download record" });
  expect(navigate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("menuitem", { name: "View details" }));
  expect(navigate).toHaveBeenCalledTimes(1);
});
