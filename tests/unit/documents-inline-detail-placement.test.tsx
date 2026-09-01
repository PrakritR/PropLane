// @vitest-environment jsdom
//
// Regression for the resident Documents "row opens way below the table" bug.
// The captain reported it on Rent receipts ("does not open in line") and again
// on Application ("rental application still opens way below"): clicking a row
// rotated its chevron, but the expanded detail rendered as a card BELOW the
// whole table instead of directly beneath its own row. Root cause: every tab
// rendered `{selected ? <Detail/> : null}` as a sibling AFTER the table, so with
// more than one row the detail landed far from the row that opened it.
//
// These tests lock the fix: the detail is rendered directly under its own row.
// On desktop that is the `<tr>` immediately following the clicked row inside the
// same `<tbody>` (never appended after the table); on mobile it is the node
// immediately after the tapped card. `DocumentsTableShell` backs Application,
// Rent receipts and Lease; `ResidentOtherDocumentsTable` is the merged tab.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { render, cleanup, fireEvent, within } from "@testing-library/react";
import { useState } from "react";

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: vi.fn() }),
}));

import { DocumentsTableShell, type DocumentsTableRow } from "@/components/portal/documents-table-shell";
import { ResidentOtherDocumentsTable } from "@/components/portal/resident-other-documents";
import type { UploadedOwnLease } from "@/lib/resident-lease-upload";

beforeAll(() => {
  // jsdom has no scrollIntoView; DocumentInlineViewer calls it when a row opens.
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
});

afterEach(cleanup);

function tbodyRows(container: HTMLElement): HTMLTableRowElement[] {
  const table = container.querySelector("table");
  if (!table) throw new Error("expected a desktop table");
  return [...table.querySelectorAll<HTMLTableRowElement>("tbody > tr")];
}

/** Minimal harness that drives DocumentsTableShell the way the real tabs do. */
function Harness({ items }: { items: { key: string; label: string }[] }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const rows: DocumentsTableRow[] = items.map((it) => ({
    key: it.key,
    expanded: openKey === it.key,
    onToggle: () => setOpenKey((cur) => (cur === it.key ? null : it.key)),
    cells: <td>{it.label}</td>,
    card: <div>{it.label} card</div>,
    detail: <div data-testid={`detail-${it.key}`}>Detail for {it.label}</div>,
  }));
  return <DocumentsTableShell head={<th>Name</th>} colSpan={1} rows={rows} />;
}

describe("DocumentsTableShell — detail is nested under its own row", () => {
  it("renders the opened row's detail immediately after that row, not below the table", () => {
    const { container } = render(
      <Harness
        items={[
          { key: "a", label: "Row A" },
          { key: "b", label: "Row B" },
          { key: "c", label: "Row C" },
        ]}
      />,
    );

    const rowB = tbodyRows(container).find(
      (tr) => tr.getAttribute("aria-expanded") !== null && tr.textContent?.includes("Row B"),
    )!;
    fireEvent.click(rowB);

    // The detail is the IMMEDIATE next sibling <tr> of Row B, in the same <tbody>.
    const detailRow = rowB.nextElementSibling as HTMLElement;
    expect(detailRow.tagName).toBe("TR");
    expect(detailRow.parentElement).toBe(rowB.parentElement);
    expect(within(detailRow).getByTestId("detail-b")).toBeTruthy();

    // Rows A and C carry no detail; the body stays intact with Row C after the detail.
    const table = container.querySelector("table")!;
    expect(table.querySelectorAll('[data-testid="detail-a"]').length).toBe(0);
    expect(table.querySelectorAll('[data-testid="detail-c"]').length).toBe(0);
    expect((detailRow.nextElementSibling as HTMLElement).textContent).toContain("Row C");
  });
});

describe("ResidentOtherDocumentsTable — list surface with selection", () => {
  const PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const uploads: UploadedOwnLease[] = [
    { id: "u1", dataUrl: PNG, fileName: "Move-in photo.png", uploadedAt: "2026-07-02T10:00:00.000Z" },
    { id: "u2", dataUrl: PNG, fileName: "Renters insurance.png", uploadedAt: "2026-07-01T10:00:00.000Z" },
  ];

  it("renders selectable list rows without inline table detail rows", () => {
    const { container, getByLabelText } = render(
      <ResidentOtherDocumentsTable uploads={uploads} loading={false} onRemove={() => {}} demo />,
    );

    expect(container.querySelector('[data-attr="resident-documents-other-list"]')).toBeTruthy();
    expect(container.querySelector("table")).toBeNull();
    expect(getByLabelText("Select Move-in photo.png")).toBeTruthy();
    expect(getByLabelText("Select Renters insurance.png")).toBeTruthy();
  });
});
