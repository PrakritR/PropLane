// @vitest-environment jsdom
// CX-RC1 / C2-L11-5: a lease record shows the document and ONE compact "Who signed" strip. The manager's
// lease record and the resident record's Lease section draw the same strip; the resident record is read-only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { LeaseSignersCard } from "@/components/portal/lease-signers-card";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";

afterEach(cleanup);

function lease(over: Partial<LeasePipelineRow> = {}): LeasePipelineRow {
  return {
    id: "lease_a",
    residentName: "Casey Morgan",
    residentEmail: "casey@example.com",
    unit: "Alder House · Room 8",
    stageLabel: "Resident Signature Pending",
    updated: "Sep 24",
    bucket: "resident",
    status: "Resident Signature Pending",
    pdfVersion: 1,
    notes: "",
    thread: [],
    managerSignature: null,
    residentSignature: null,
    sentToResidentAt: "2026-09-24T12:00:00.000Z",
    ...over,
  } as LeasePipelineRow;
}

describe("LeaseSignersCard (the compact signature strip)", () => {
  it("is one labelled strip with each party inline, not a list under a heading", () => {
    render(<LeaseSignersCard row={lease()} managerName="Alex Rivera" onRemind={vi.fn()} onSign={vi.fn()} />);
    const strip = screen.getByRole("region", { name: "Who signed" });
    expect(within(strip).getByText("Who signed")).toBeTruthy();
    expect(within(strip).getByText("Casey Morgan")).toBeTruthy();
    expect(within(strip).getByText(/Sent Sep 24/)).toBeTruthy();
    expect(strip.querySelector("ul")).toBeNull();
  });

  it("offers the bell to remind a resident who has not signed", () => {
    const onRemind = vi.fn();
    render(<LeaseSignersCard row={lease()} managerName="Alex Rivera" onRemind={onRemind} onSign={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Remind Casey" }));
    expect(onRemind).toHaveBeenCalledWith("lease_a");
  });

  it("is read-only where no handlers are passed (the resident record's Lease section)", () => {
    render(<LeaseSignersCard row={lease()} managerName="Alex Rivera" />);
    expect(screen.getByRole("region", { name: "Who signed" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Remind/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign" })).toBeNull();
  });

  it("the manager gets Sign once the resident has signed", () => {
    const onSign = vi.fn();
    render(
      <LeaseSignersCard
        row={lease({
          bucket: "signed",
          status: "Manager Signature Pending",
          residentSignature: { role: "resident", name: "Casey Morgan", signedAtIso: "2026-09-29T09:00:00.000Z" },
        })}
        managerName="Alex Rivera"
        onRemind={vi.fn()}
        onSign={onSign}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign" }));
    expect(onSign).toHaveBeenCalledTimes(1);
  });
});

describe("one lease signature strip on every record", () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
  it("the manager lease record and the resident record's Lease section both use LeaseSignersCard", () => {
    expect(read("src/components/portal/pro-leases-pipeline-panel.tsx")).toContain("<LeaseSignersCard");
    const residents = read("src/components/portal/pro-residents.tsx");
    expect(residents).toContain("<LeaseSignersCard row={residentLease} />");
    expect(residents).not.toContain("ManagerResidentLeaseSigners");
  });
});
