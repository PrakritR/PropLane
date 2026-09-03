/**
 * @vitest-environment jsdom
 *
 * AXI-157 — "clicking the checkbox next to an application sometimes opens the
 * application instead of only selecting it. After clicking the checkbox multiple
 * times, it navigates directly into the application."
 *
 * The checkbox is 16px, well under the 44px touch minimum, and sits directly
 * beside the button that opens the record. A tap a couple of pixels off missed
 * it and hit the record button — which is exactly why it was intermittent.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataList } from "@/components/ui/data-list";

afterEach(cleanup);

function renderList(onClick: () => void, onSelectedChange: () => void) {
  return render(
    <DataList
      variant="resident"
      hideColumnHeaders
      selectable
      rows={[
        {
          id: "AXIS-1",
          data: { id: "AXIS-1" },
          primary: "Jordan Lee",
          meta: "Brooklyn House",
          selected: false,
          onSelectedChange,
          onClick,
        },
      ]}
      columns={[{ id: "name", header: "Application", cell: () => <span>Jordan Lee</span> }]}
    />,
  );
}

describe("list checkbox never opens the record", () => {
  it("selects without navigating when the checkbox itself is clicked", () => {
    const onClick = vi.fn();
    const onSelectedChange = vi.fn();
    renderList(onClick, onSelectedChange);

    fireEvent.click(screen.getAllByLabelText("Select Jordan Lee")[0]!);

    expect(onSelectedChange).toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("treats a near-miss on the padding ring as the checkbox, not the row", () => {
    // The whole point of the fix: the enlarged hit area must also be ignored by
    // the row click, or a slightly-off tap still navigates.
    const onClick = vi.fn();
    const onSelectedChange = vi.fn();
    renderList(onClick, onSelectedChange);

    const box = screen.getAllByLabelText("Select Jordan Lee")[0]!;
    const hitArea = box.closest("label");
    expect(hitArea, "checkbox should sit inside an enlarged hit area").toBeTruthy();
    expect(hitArea?.getAttribute("data-portal-row-ignore")).not.toBeNull();

    fireEvent.click(hitArea!);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("still opens the record when the row itself is clicked", () => {
    const onClick = vi.fn();
    renderList(onClick, vi.fn());
    fireEvent.click(screen.getAllByText("Jordan Lee")[0]!);
    expect(onClick).toHaveBeenCalled();
  });
});
