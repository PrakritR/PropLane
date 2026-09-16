// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReminderScheduleChips } from "@/components/portal/payment-schedule-ui";
import {
  DEFAULT_MANAGER_AUTOMATION_SETTINGS,
  type ManagerAutomationSettings,
} from "@/lib/payment-automation-settings";
import {
  EMPTY_REMINDER_SCHEDULE_SUMMARY,
  reminderScheduleTokensFromSettings,
  settingsPatchFromReminderScheduleTokens,
  summarizeReminderSchedule,
} from "@/lib/payment-reminder-presets";

afterEach(cleanup);

function Harness({
  initial,
  onDraft,
}: {
  initial: Partial<ManagerAutomationSettings>;
  onDraft?: (draft: ManagerAutomationSettings) => void;
}) {
  const [draft, setDraft] = useState<ManagerAutomationSettings>({ ...DEFAULT_MANAGER_AUTOMATION_SETTINGS, ...initial });
  return (
    <ReminderScheduleChips
      draft={draft}
      busy={false}
      onChange={(patch) => {
        const next = { ...draft, ...patch };
        setDraft(next);
        onDraft?.(next);
      }}
    />
  );
}

function openMenu(name: string) {
  fireEvent.click(screen.getByRole("button", { name, expanded: false }));
  return screen.getByRole("listbox", { name });
}

function tapOption(listbox: HTMLElement, label: string) {
  const target = within(listbox).getByRole("option", { name: label });
  fireEvent.pointerDown(target, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(target, { pointerId: 1, clientX: 10, clientY: 10 });
}

describe("summarizeReminderSchedule", () => {
  it("writes one sentence from the same tokens the save uses", () => {
    expect(summarizeReminderSchedule(["before:21", "before:14", "before:3", "before:2", "due_date"])).toBe(
      "Sends 21, 14, 3 and 2 days before and on the due date.",
    );
    expect(summarizeReminderSchedule(["before:1"])).toBe("Sends 1 day before.");
    expect(summarizeReminderSchedule(["due_date", "every_day_late"])).toBe(
      "Sends on the due date and every day it's late.",
    );
    expect(summarizeReminderSchedule([])).toBe(EMPTY_REMINDER_SCHEDULE_SUMMARY);
  });
});

describe("ReminderScheduleChips", () => {
  it("shows a stored schedule as selected dropdown options", () => {
    render(<Harness initial={{ preDueReminderDays: [21, 3], sameDayReminderEnabled: true, overdueDailyEnabled: false }} />);
    const before = openMenu("Days before due");
    expect(within(before).getByRole("option", { name: "21 days" }).getAttribute("aria-selected")).toBe("true");
    expect(within(before).getByRole("option", { name: "3 days" }).getAttribute("aria-selected")).toBe("true");
    expect(within(before).getByRole("option", { name: "30 days" }).getAttribute("aria-selected")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Days before due" }));
    const after = openMenu("On and after the due date");
    expect(within(after).getByRole("option", { name: "Due date" }).getAttribute("aria-selected")).toBe("true");
    expect(within(after).getByRole("option", { name: "Every day late" }).getAttribute("aria-selected")).toBe("false");
  });

  it("round-trips: dropdown → settings → dropdown is the identity", () => {
    const drafts: ManagerAutomationSettings[] = [];
    render(
      <Harness
        initial={{ preDueReminderDays: [14], sameDayReminderEnabled: false, overdueDailyEnabled: false }}
        onDraft={(d) => drafts.push(d)}
      />,
    );
    tapOption(openMenu("Days before due"), "30 days");
    fireEvent.click(screen.getByRole("button", { name: "Days before due" }));
    tapOption(openMenu("On and after the due date"), "Every day late");
    const last = drafts[drafts.length - 1];
    expect(last.preDueReminderDays).toEqual([30, 14]);
    expect(last.overdueDailyEnabled).toBe(true);
    expect(last.sameDayReminderEnabled).toBe(false);
    const tokens = reminderScheduleTokensFromSettings(last);
    expect(settingsPatchFromReminderScheduleTokens(tokens).preDueReminderDays).toEqual([30, 14]);
  });

  it("adds a custom day in sorted position, dedupes onto a default, and drops it when turned off", () => {
    const drafts: ManagerAutomationSettings[] = [];
    render(
      <Harness
        initial={{ preDueReminderDays: [21], sameDayReminderEnabled: false, overdueDailyEnabled: false }}
        onDraft={(d) => drafts.push(d)}
      />,
    );
    const before = openMenu("Days before due");
    fireEvent.click(screen.getByRole("button", { name: "+ Custom" }));
    const input = screen.getByLabelText("Custom days before due") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "45" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(drafts[drafts.length - 1].preDueReminderDays).toEqual([45, 21]);
    expect(within(before).getByRole("option", { name: "45 days" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "+ Custom" }));
    const input2 = screen.getByLabelText("Custom days before due") as HTMLInputElement;
    fireEvent.change(input2, { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Add custom day" }));
    expect(drafts[drafts.length - 1].preDueReminderDays).toEqual([45, 21, 7]);
    expect(within(before).getAllByRole("option", { name: "7 days" }).length).toBe(1);

    tapOption(before, "45 days");
    expect(drafts[drafts.length - 1].preDueReminderDays).toEqual([21, 7]);
    expect(within(before).queryByRole("option", { name: "45 days" })).toBeNull();
  });

  it("refuses an out-of-range custom day with a sentence and changes nothing", () => {
    const drafts: ManagerAutomationSettings[] = [];
    render(
      <Harness
        initial={{ preDueReminderDays: [21], sameDayReminderEnabled: false, overdueDailyEnabled: false }}
        onDraft={(d) => drafts.push(d)}
      />,
    );
    openMenu("Days before due");
    fireEvent.click(screen.getByRole("button", { name: "+ Custom" }));
    const input = screen.getByLabelText("Custom days before due") as HTMLInputElement;
    for (const bad of ["0", "61", "x", ""]) {
      fireEvent.change(input, { target: { value: bad } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(screen.getByRole("alert").textContent).toContain("1 to 60");
    }
    expect(drafts.length).toBe(0);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByLabelText("Custom days before due")).toBeNull();
    expect(screen.getByRole("button", { name: "+ Custom" })).toBeTruthy();
  });

  it("allows an empty schedule", () => {
    const drafts: ManagerAutomationSettings[] = [];
    render(
      <Harness
        initial={{ preDueReminderDays: [3], sameDayReminderEnabled: true, overdueDailyEnabled: false }}
        onDraft={(d) => drafts.push(d)}
      />,
    );
    tapOption(openMenu("Days before due"), "3 days");
    fireEvent.click(screen.getByRole("button", { name: "Days before due" }));
    tapOption(openMenu("On and after the due date"), "Due date");
    const last = drafts[drafts.length - 1];
    expect(last.preDueReminderDays).toEqual([]);
    expect(last.sameDayReminderEnabled).toBe(false);
  });
});
