// @vitest-environment jsdom
//
// Room pricing popup (captain, Oct 3): no "Fees" sub-heading, Custom start
// surcharge only when asked for (month-to-month has none), and Application fee / Lease fee bound to the step they sit on.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ArrangementStandardFeeRows } from "@/components/portal/listing-wizard-v2/arrangement-standard-fee-rows";

afterEach(() => cleanup());

describe("ArrangementStandardFeeRows", () => {
  it("has no Fees sub-heading, only the fee rows", () => {
    render(
      <ArrangementStandardFeeRows count={1} row={{ count: 1 }} onPatch={() => {}} showCustomStart />,
    );
    expect(screen.queryByText(/^Fees( per resident)?$/)).toBeNull();
    for (const label of ["Lease fee", "Application fee", "Move-in fee", "Custom start surcharge"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("shows the custom start surcharge only when Custom is offered, and never a month-to-month surcharge", () => {
    const { rerender } = render(<ArrangementStandardFeeRows count={1} row={{ count: 1 }} onPatch={() => {}} showCustomStart />);
    expect(screen.queryByText("Month-to-month surcharge")).toBeNull();
    expect(screen.getByText("Custom start surcharge")).toBeTruthy();
    rerender(<ArrangementStandardFeeRows count={1} row={{ count: 1 }} onPatch={() => {}} showCustomStart={false} />);
    expect(screen.queryByText("Month-to-month surcharge")).toBeNull();
    expect(screen.queryByText("Custom start surcharge")).toBeNull();
  });

  it("the Long-term step writes the shared fees", () => {
    const onPatch = vi.fn();
    render(
      <ArrangementStandardFeeRows
        count={1}
        row={{ count: 1, applicationFee: "50", leaseFee: "100", shortTermLeaseFee: "40" }}
        onPatch={onPatch}
        showCustomStart={false}
        scope="long"
      />,
    );
    const lease = screen.getByLabelText("Private room long-term lease fee") as HTMLInputElement;
    expect(lease.value).toBe("100");
    fireEvent.change(lease, { target: { value: "120" } });
    expect(onPatch).toHaveBeenLastCalledWith({ leaseFee: "120" });
    fireEvent.change(screen.getByLabelText("Private room long-term application fee"), { target: { value: "55" } });
    expect(onPatch).toHaveBeenLastCalledWith({ applicationFee: "55" });
  });

  it("the Short term step edits its own fees and shows the shared one only as a placeholder", () => {
    const onPatch = vi.fn();
    render(
      <ArrangementStandardFeeRows
        count={1}
        row={{ count: 1, applicationFee: "50", leaseFee: "100", shortTermLeaseFee: "40" }}
        onPatch={onPatch}
        showCustomStart={false}
        scope="short"
      />,
    );
    const lease = screen.getByLabelText("Private room short term lease fee") as HTMLInputElement;
    expect(lease.value).toBe("40");
    const application = screen.getByLabelText("Private room short term application fee") as HTMLInputElement;
    expect(application.value).toBe("");
    expect(application.placeholder).toBe("50");
    fireEvent.change(application, { target: { value: "20" } });
    expect(onPatch).toHaveBeenLastCalledWith({ shortTermApplicationFee: "20" });
    fireEvent.change(lease, { target: { value: "45" } });
    expect(onPatch).toHaveBeenLastCalledWith({ shortTermLeaseFee: "45" });
  });
});
