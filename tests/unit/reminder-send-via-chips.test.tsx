// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReminderSendViaField, ReminderTimingMultiSelect, TourReminderTimingSelect } from "@/components/portal/reminder-settings-shared";

afterEach(cleanup);

const pressed = (name: string) => screen.getByRole("button", { name }).getAttribute("aria-pressed");

describe("ReminderSendViaField as chips", () => {
  it("shows every channel with its state and toggles one per tap", () => {
    const onChange = vi.fn();
    render(<ReminderSendViaField showProplaneChannel viaInbox viaEmail viaSms={false} onChange={onChange} />);
    expect(pressed("PropLane")).toBe("true");
    expect(pressed("Email")).toBe("true");
    expect(pressed("SMS")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "SMS" }));
    expect(onChange).toHaveBeenLastCalledWith({ viaInbox: true, viaEmail: true, viaSms: true });
  });

  it("refuses to turn the last channel off and says so", () => {
    const onChange = vi.fn();
    render(<ReminderSendViaField viaEmail viaSms={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Email" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("at least one channel");
  });

  it("shows an unavailable SMS chip disabled rather than hiding it", () => {
    render(<ReminderSendViaField viaEmail viaSms={false} smsAvailable={false} onChange={() => {}} />);
    const sms = screen.getByRole("button", { name: "SMS (not enabled)" }) as HTMLButtonElement;
    expect(sms.disabled).toBe(true);
  });

  it("falls back to the same default selection the dropdown used", () => {
    render(<ReminderSendViaField showProplaneChannel viaInbox={false} viaEmail={false} viaSms={false} onChange={() => {}} />);
    expect(pressed("PropLane")).toBe("true");
    expect(pressed("Email")).toBe("true");
  });
});

describe("ReminderTimingMultiSelect as chips", () => {
  it("splits before/after into two labelled rows and keeps the other row on change", () => {
    const onChange = vi.fn();
    render(
      <ReminderTimingMultiSelect
        timings={["before:1440", "after:60"]}
        directions={["before", "after"]}
        onChangeTimings={onChange}
      />,
    );
    expect(screen.getByRole("group", { name: "Reminders before" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Reminders after" })).toBeTruthy();
    const before = screen.getByRole("group", { name: "Reminders before" });
    fireEvent.click(before.querySelector('button[data-attr="reminder-timing-before-before:10080"]') as HTMLElement);
    expect(onChange).toHaveBeenLastCalledWith(expect.arrayContaining(["after:60", "before:1440", "before:10080"]));
    expect(onChange.mock.calls[0][0].length).toBe(3);
  });
});

describe("TourReminderTimingSelect as chips", () => {
  it("renders presets plus stored custom minutes and adds a custom value inline", () => {
    const onChange = vi.fn();
    render(<TourReminderTimingSelect minutesBeforeList={[30, 45]} onChangeMinutesList={onChange} />);
    expect(pressed("45 minutes")).toBe("true");
    expect(pressed("30 minutes")).toBe("true");
    expect(pressed("1 hour")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "+ Custom" }));
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
