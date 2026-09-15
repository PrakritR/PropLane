// @vitest-environment jsdom
/**
 * Reminder pickers are dropdowns, not chips (AGENTS.md § No subtext: picks are
 * dropdowns, never pills). The rules inside are unchanged from the chip era:
 * at least one channel stays on, an unavailable SMS option is disabled rather
 * than hidden, and the before/after timing rows never clobber each other.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ReminderSendViaField,
  ReminderTimingMultiSelect,
  TourReminderTimingSelect,
} from "@/components/portal/reminder-settings-shared";

afterEach(cleanup);

function openMenu(name: string) {
  fireEvent.click(screen.getByRole("button", { name, expanded: false }));
  return screen.getByRole("listbox", { name });
}

function option(listbox: HTMLElement, label: string) {
  return within(listbox).getByRole("option", { name: label });
}

function tap(target: HTMLElement) {
  fireEvent.pointerDown(target, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(target, { pointerId: 1, clientX: 10, clientY: 10 });
}

describe("ReminderSendViaField as a dropdown", () => {
  it("shows every channel with its state and toggles one per pick", () => {
    const onChange = vi.fn();
    render(<ReminderSendViaField showProplaneChannel viaInbox viaEmail viaSms={false} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Send via" }).textContent).toContain("PropLane, Email");
    const listbox = openMenu("Send via");
    expect(option(listbox, "PropLane").getAttribute("aria-selected")).toBe("true");
    expect(option(listbox, "Email").getAttribute("aria-selected")).toBe("true");
    expect(option(listbox, "SMS").getAttribute("aria-selected")).toBe("false");
    tap(option(listbox, "SMS"));
    expect(onChange).toHaveBeenLastCalledWith({ viaInbox: true, viaEmail: true, viaSms: true });
  });

  it("refuses to turn the last channel off and says so", () => {
    const onChange = vi.fn();
    render(<ReminderSendViaField viaEmail viaSms={false} onChange={onChange} />);
    const listbox = openMenu("Send via");
    tap(option(listbox, "Email"));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("at least one channel");
  });

  it("shows an unavailable SMS option disabled rather than hiding it", () => {
    render(<ReminderSendViaField viaEmail viaSms={false} smsAvailable={false} onChange={() => {}} />);
    const listbox = openMenu("Send via");
    expect(option(listbox, "SMS (not enabled)").getAttribute("aria-disabled")).toBe("true");
  });

  it("falls back to the same default selection the old dropdown used", () => {
    render(<ReminderSendViaField showProplaneChannel viaInbox={false} viaEmail={false} viaSms={false} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Send via" }).textContent).toContain("PropLane, Email");
  });

  it("draws no sentence under the control", () => {
    const { container } = render(<ReminderSendViaField viaEmail viaSms={false} onChange={() => {}} />);
    expect(container.querySelectorAll("p")).toHaveLength(0);
  });
});

describe("ReminderTimingMultiSelect as dropdowns", () => {
  it("splits before/after into two dropdowns and keeps the other row on change", () => {
    const onChange = vi.fn();
    render(
      <ReminderTimingMultiSelect
        timings={["before:1440", "after:60"]}
        directions={["before", "after"]}
        onChangeTimings={onChange}
      />,
    );
    expect(screen.getByRole("button", { name: "Reminders before" }).textContent).toContain("1 day");
    expect(screen.getByRole("button", { name: "Reminders after" }).textContent).toContain("1 hour");
    const before = openMenu("Reminders before");
    tap(option(before, "7 days"));
    expect(onChange).toHaveBeenLastCalledWith(expect.arrayContaining(["after:60", "before:1440", "before:10080"]));
    expect(onChange.mock.calls[0][0].length).toBe(3);
  });

  it("keeps a stored custom timing visible in its dropdown and offers Custom… at the bottom", () => {
    render(
      <ReminderTimingMultiSelect
        timings={["before:45"]}
        directions={["before"]}
        onChangeTimings={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Reminders before" }).textContent).toContain("45 minutes");
    const before = openMenu("Reminders before");
    expect(option(before, "45 minutes").getAttribute("aria-selected")).toBe("true");
    fireEvent.click(within(before.parentElement as HTMLElement).getByRole("button", { name: "Custom…" }));
    expect(screen.getByLabelText("Custom minutes before")).toBeTruthy();
  });

  it("draws no summary sentence under the dropdowns", () => {
    const { container } = render(
      <ReminderTimingMultiSelect timings={["before:1440"]} directions={["before", "after"]} onChangeTimings={() => {}} />,
    );
    expect(container.textContent).not.toMatch(/Sends /);
  });
});

describe("TourReminderTimingSelect as a dropdown", () => {
  it("renders presets plus stored custom minutes and adds a custom value inline", () => {
    const onChange = vi.fn();
    render(<TourReminderTimingSelect minutesBeforeList={[30, 45]} onChangeMinutesList={onChange} />);
    const listbox = openMenu("Before the tour");
    expect(option(listbox, "45 minutes").getAttribute("aria-selected")).toBe("true");
    expect(option(listbox, "30 minutes").getAttribute("aria-selected")).toBe("true");
    expect(option(listbox, "1 hour").getAttribute("aria-selected")).toBe("false");
    fireEvent.click(within(listbox.parentElement as HTMLElement).getByRole("button", { name: "Custom…" }));
    const input = screen.getByLabelText("Custom minutes before tour") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toContain("5 to 1440");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "90" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith([90, 45, 30]);
  });
});
