// @vitest-environment jsdom
/**
 * A tab strip that cannot fit a phone screen is the record page's dropdown picker there; one that
 * fits stays tabs (captain, 2026-10-06). The strip itself never leaves the DOM, so desktop is
 * unchanged and anything that targets a tab keeps working.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import {
  estimatePhoneStripWidth,
  PHONE_STRIP_FIT_PX,
  phoneStripFits,
  PhoneStripPickerScope,
} from "@/components/ui/phone-strip-picker";
import { WizardStepTabs } from "@/components/portal/listing-wizard-v2/wizard-primitives";

afterEach(() => cleanup());

const APPLICATION_TABS = [
  { id: "incomplete", label: "Incomplete", count: 0 },
  { id: "pending", label: "Pending", count: 0 },
  { id: "approved", label: "Approved", count: 1 },
  { id: "rejected", label: "Rejected", count: 0 },
];
const TOUR_TABS = [
  { id: "pending", label: "Scheduled", count: 1 },
  { id: "upcoming", label: "Upcoming", count: 0 },
  { id: "past", label: "Past", count: 2 },
];

/** Four short labels that fit as plain tabs but not once each reserves a count pill. */
const BOUNDARY_LABELS = ["Open", "Pending", "Paid", "Late"];

describe("what fits one phone screen", () => {
  it("measures the strips the audit found overflowing at 390px, and the ones that fit", () => {
    expect(phoneStripFits(APPLICATION_TABS)).toBe(false);
    expect(phoneStripFits(TOUR_TABS)).toBe(true);
    expect(estimatePhoneStripWidth(TOUR_TABS)).toBeLessThanOrEqual(PHONE_STRIP_FIT_PX);
    expect(
      phoneStripFits(["Draft", "Resident signature", "Manager signature", "Signed"].map((label) => ({ label }))),
    ).toBe(false);
  });

  it("charges the count pill to a countable strip only, and to every one of its tabs", () => {
    const labels = BOUNDARY_LABELS.map((label) => ({ label }));
    const countable = BOUNDARY_LABELS.map((label) => ({ label, countable: true }));
    expect(phoneStripFits(labels)).toBe(true);
    expect(phoneStripFits(countable)).toBe(false);
    expect(estimatePhoneStripWidth(countable) - estimatePhoneStripWidth(labels)).toBe(23 * BOUNDARY_LABELS.length);
  });
});

describe("a strip whose tabs can carry counts", () => {
  const items = BOUNDARY_LABELS.map((label) => ({ id: label.toLowerCase(), label }));
  const render4 = (tabs: { id: string; label: string; count?: number }[]) =>
    render(
      <PhoneStripPickerScope>
        <LocalDestinationNav items={tabs} activeId={tabs[0]!.id} onChange={() => {}} ariaLabel="Charge status" appearance="command" />
      </PhoneStripPickerScope>,
    );

  it("gives the same answer before and after the counts load", () => {
    render4(items);
    expect(document.querySelector('[data-attr="phone-strip-picker"]')).not.toBeNull();
    cleanup();
    render4(items.map((item, index) => ({ ...item, count: index })));
    expect(document.querySelector('[data-attr="phone-strip-picker"]')).not.toBeNull();
  });
});

describe("LocalDestinationNav in a record or pop-up", () => {
  const strip = (tabs: typeof APPLICATION_TABS, onChange = vi.fn()) => (
    <PhoneStripPickerScope>
      <LocalDestinationNav items={tabs} activeId={tabs[0]!.id} onChange={onChange} ariaLabel="Application status" appearance="command" />
    </PhoneStripPickerScope>
  );

  it("draws the picker beside the (hidden-on-phone) strip when the tabs overflow", () => {
    render(strip(APPLICATION_TABS));
    expect(screen.getByRole("navigation", { name: "Application status" })).toBeTruthy();
    const toggle = screen.getByRole("button", { name: /Incomplete/, expanded: false });
    expect(toggle.getAttribute("data-attr")).toBe("phone-strip-picker-toggle");
    expect(toggle.closest('[data-attr="phone-strip-picker"]')?.className).toContain("sm:hidden");
    expect(screen.getByRole("navigation", { name: "Application status" }).parentElement?.className).toContain("max-sm:hidden");
  });

  it("opens the shared sheet and picking a row changes the tab", () => {
    const onChange = vi.fn();
    render(strip(APPLICATION_TABS, onChange));
    fireEvent.click(screen.getByRole("button", { name: /Incomplete/, expanded: false }));
    fireEvent.click(screen.getByRole("option", { name: /Approved/ }));
    expect(onChange).toHaveBeenCalledWith("approved");
  });

  it("keeps plain tabs when they fit, and outside a record or pop-up", () => {
    render(strip(TOUR_TABS as never));
    expect(document.querySelector('[data-attr="phone-strip-picker"]')).toBeNull();
    cleanup();
    render(
      <LocalDestinationNav items={APPLICATION_TABS} activeId="pending" onChange={() => {}} ariaLabel="List status" appearance="command" />,
    );
    expect(document.querySelector('[data-attr="phone-strip-picker"]')).toBeNull();
  });
});

describe("the pop-up's step tabs", () => {
  const steps = ["Basics", "Rooms", "Bathrooms", "Shared spaces", "Application", "Lease"].map((label) => ({
    id: label.toLowerCase().replace(/\s+/g, "-"),
    label,
  }));

  it("become the Steps picker, reaching any step, when they cannot share one screen", () => {
    const onJump = vi.fn();
    render(<WizardStepTabs steps={steps} current={0} onJump={onJump} />);
    expect(document.querySelector('[data-attr="workspace-step-picker"]')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Basics/, expanded: false }));
    fireEvent.click(screen.getByRole("option", { name: /Shared spaces/ }));
    expect(onJump).toHaveBeenCalledWith(3);
  });

  it("stay tabs when there are only a few", () => {
    render(<WizardStepTabs steps={steps.slice(0, 3)} current={0} onJump={() => {}} />);
    expect(document.querySelector('[data-attr="phone-strip-picker"]')).toBeNull();
  });

  it("stay tabs at four steps: a step never draws a count pill, so none is reserved", () => {
    const four = ["Basics", "Rooms", "Bathrooms", "Lease"].map((label) => ({ id: label.toLowerCase(), label }));
    render(<WizardStepTabs steps={four} current={0} onJump={() => {}} />);
    expect(document.querySelector('[data-attr="phone-strip-picker"]')).toBeNull();
    expect(screen.queryByRole("button", { name: /Basics/, expanded: false })).toBeNull();
  });

  it("tells a locked step's reason instead of jumping", () => {
    const onJump = vi.fn();
    const onLockedTap = vi.fn();
    const locked = steps.map((step, index) => (index === 4 ? { ...step, disabled: true, lockedReason: "Verify your phone first" } : step));
    render(<WizardStepTabs steps={locked} current={0} onJump={onJump} onLockedTap={onLockedTap} />);
    fireEvent.click(screen.getByRole("button", { name: /Basics/, expanded: false }));
    fireEvent.click(screen.getByRole("option", { name: /Application/ }));
    expect(onJump).not.toHaveBeenCalled();
    expect(onLockedTap).toHaveBeenCalledWith("Verify your phone first");
  });
});
