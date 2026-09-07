// @vitest-environment jsdom
/**
 * PRP-369 / PRP-378 — the leading selection checkbox on a list row must have a
 * thumb-sized hit area, and a near-miss must SELECT, never open the row.
 *
 * Every list surface drew a bare 16 × 16 `<input>`; on the Communication list
 * a tap 10 px off the box landed on the row itself and opened the conversation.
 * `RowSelectCheckbox` wraps the input in a padded `<label>` (`p-3 -m-3`, the
 * same pad `DataList` adopted for AXI-157) so the pad IS the checkbox: clicking
 * it toggles selection and never reaches the row's open handler.
 *
 * jsdom does not lay out, so the pad is asserted structurally — the input is
 * inside a label carrying the padding classes and the row-ignore marker — and
 * the click routing is asserted behaviourally on each row variant.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RowSelectCheckbox } from "@/components/ui/row-select-checkbox";
import { CommunicationInboxRowCheckbox } from "@/components/portal/communication-list-bulk-bar";
import {
  PortalPersonRecordRow,
  PortalPropertyRecordRow,
  PortalServiceRecordRow,
} from "@/components/portal/portal-record-row";

afterEach(() => cleanup());

function hitPadOf(input: HTMLElement): HTMLLabelElement {
  const label = input.closest("label");
  if (!label) throw new Error("selection checkbox is not inside its hit-pad label");
  return label as HTMLLabelElement;
}

function hasClass(el: Element, cls: string) {
  return el.className.split(/\s+/).includes(cls);
}

function expectHitPad(input: HTMLElement) {
  const pad = hitPadOf(input);
  // 12 px of padding pulled back with a matching negative margin: the tap
  // target is 40 × 40 while the layout footprint stays the bare box's 16 × 16.
  expect(hasClass(pad, "p-3")).toBe(true);
  expect(hasClass(pad, "-m-3")).toBe(true);
  expect(pad.hasAttribute("data-portal-row-ignore")).toBe(true);
  expect(hasClass(input, "h-4")).toBe(true);
  expect(hasClass(input, "w-4")).toBe(true);
}

describe("RowSelectCheckbox", () => {
  it("renders the 16 px box inside a padded label that is the real hit area", () => {
    const onChange = vi.fn();
    render(<RowSelectCheckbox checked={false} onChange={onChange} aria-label="Select thing" />);
    const input = screen.getByRole("checkbox", { name: "Select thing" });
    expectHitPad(input);
  });

  it("a click on the pad toggles the box and never reaches the row behind it", () => {
    const onChange = vi.fn();
    const rowOpen = vi.fn();
    render(
      <div onClick={rowOpen}>
        <RowSelectCheckbox checked={false} onChange={onChange} aria-label="Select thing" />
      </div>,
    );
    const input = screen.getByRole("checkbox", { name: "Select thing" });
    fireEvent.click(hitPadOf(input));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(rowOpen).not.toHaveBeenCalled();

    fireEvent.click(input);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(rowOpen).not.toHaveBeenCalled();
  });

  it("lets a caller add the row's own margins without losing the pad", () => {
    render(
      <RowSelectCheckbox wrapperClassName="mr-0 -mt-2 self-start" checked={false} onChange={() => {}} aria-label="Select" />,
    );
    const pad = hitPadOf(screen.getByRole("checkbox", { name: "Select" }));
    expect(hasClass(pad, "self-start")).toBe(true);
    expect(hasClass(pad, "-mt-2")).toBe(true);
    expect(hasClass(pad, "p-3")).toBe(true);
  });
});

describe("every list row variant uses the padded selection checkbox", () => {
  it("Communication conversation row (manager, resident, vendor inboxes)", () => {
    const onToggle = vi.fn();
    const openRow = vi.fn();
    render(
      <div className="portal-inbox-row" onClick={openRow}>
        <CommunicationInboxRowCheckbox checked={false} onToggle={onToggle} label="Select conversation with Maya" />
      </div>,
    );
    const input = screen.getByRole("checkbox", { name: "Select conversation with Maya" });
    expectHitPad(input);
    fireEvent.click(hitPadOf(input));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(openRow).not.toHaveBeenCalled();
  });

  it("PortalPropertyRecordRow (manager Properties, admin Properties)", () => {
    const onSelectedChange = vi.fn();
    const onOpen = vi.fn();
    render(
      <PortalPropertyRecordRow
        title="Maple Court"
        address="1 Maple St"
        onSelectedChange={onSelectedChange}
        onOpen={onOpen}
      />,
    );
    const input = screen.getByRole("checkbox", { name: "Select Maple Court" });
    expectHitPad(input);
    fireEvent.click(hitPadOf(input));
    expect(onSelectedChange).toHaveBeenCalledWith(true);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("PortalPersonRecordRow (admin Events, admin Axis users, residents)", () => {
    const onSelectedChange = vi.fn();
    const onOpen = vi.fn();
    render(
      <PortalPersonRecordRow name="Maya Chen" subtitle="Approved" onSelectedChange={onSelectedChange} onOpen={onOpen} />,
    );
    const input = screen.getByRole("checkbox", { name: "Select Maya Chen" });
    expectHitPad(input);
    fireEvent.click(hitPadOf(input));
    expect(onSelectedChange).toHaveBeenCalledWith(true);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("PortalServiceRecordRow (services, tickets)", () => {
    const onSelectedChange = vi.fn();
    const onOpen = vi.fn();
    render(
      <PortalServiceRecordRow title="Leaking tap" subtitle="Open" onSelectedChange={onSelectedChange} onOpen={onOpen} />,
    );
    const input = screen.getByRole("checkbox", { name: "Select Leaking tap" });
    expectHitPad(input);
    fireEvent.click(hitPadOf(input));
    expect(onSelectedChange).toHaveBeenCalledWith(true);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
