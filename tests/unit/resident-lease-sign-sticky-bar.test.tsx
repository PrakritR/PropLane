// @vitest-environment jsdom
//
// C128: the phone-only sticky "Sign lease" bar pinned above the bottom tab
// bar. Tested in isolation — it is a plain button wrapper with no fetches.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ResidentLeaseSignStickyBar } from "@/components/portal/resident-lease-panel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ResidentLeaseSignStickyBar", () => {
  it("renders the sign label, hidden on desktop (lg:hidden), pinned above the bottom nav", () => {
    render(<ResidentLeaseSignStickyBar onSign={() => {}} disabled={false} label="Sign lease" />);
    const bar = screen.getByText("Sign lease").closest('[data-attr="resident-lease-sign-sticky-bar"]');
    expect(bar).toBeInTheDocument();
    expect(bar).toHaveClass("lg:hidden");
    expect(bar).toHaveClass("fixed");
  });

  it("calls onSign when tapped", () => {
    const onSign = vi.fn();
    render(<ResidentLeaseSignStickyBar onSign={onSign} disabled={false} label="Sign lease" />);
    fireEvent.click(screen.getByText("Sign lease"));
    expect(onSign).toHaveBeenCalledTimes(1);
  });

  it("disables the button while the lease document is still loading", () => {
    render(<ResidentLeaseSignStickyBar onSign={() => {}} disabled label="Loading lease…" />);
    expect(screen.getByText("Loading lease…").closest("button")).toBeDisabled();
  });
});
