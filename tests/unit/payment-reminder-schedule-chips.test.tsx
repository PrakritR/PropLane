// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

const pressed = (name: string) => screen.getByRole("button", { name }).getAttribute("aria-pressed");

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
  it("shows a stored schedule as pressed chips and the rest unpressed", () => {
    render(<Harness initial={{ preDueReminderDays: [21, 3], sameDayReminderEnabled: true, overdueDailyEnabled: false }} />);
    expect(pressed("21 days")).toBe("true");
    expect(pressed("3 days")).toBe("true");
    expect(pressed("30 days")).toBe("false");
    expect(pressed("Due date")).toBe("true");
    expect(pressed("Every day late")).toBe("false");
    expect(screen.getByText("Sends 21 and 3 days before and on the due date.")).toBeTruthy();
  });

  it("round-trips: chips → settings → chips is the identity", () => {
    const drafts: ManagerAutomationSettings[] = [];
    render(<Harness initial={{ preDueReminderDays: [14], sameDayReminderEnabled: false, overdueDailyEnabled: false }} onDraft={(d) => drafts.push(d)} />);
    fireEvent.click(screen.getByRole("button", { name: "30 days" }));
    fireEvent.click(screen.getByRole("button", { name: "Every day late" }));
    const last = drafts[drafts.length - 1];
    expect(last.preDueReminderDays).toEqual([30, 14]);
    expect(last.overdueDailyEnabled).toBe(true);
    expect(last.sameDayReminderEnabled).toBe(false);
    const tokens = reminderScheduleTokensFromSettings(last);
    expect(settingsPatchFromReminderScheduleTokens(tokens).preDueReminderDays).toEqual([30, 14]);
  });

  it("adds a custom day in sorted position, dedupes onto a default, and drops it when turned off", () => {
    const drafts: ManagerAutomationSettings[] = [];
    render(<Harness initial={{ preDueReminderDays: [21], sameDayReminderEnabled: false, overdueDailyEnabled: false }} onDraft={(d) => drafts.push(d)} />);
    fireEvent.click(screen.getByRole("button", { name: "+ Custom" }));
    const input = screen.getByLabelText("Custom days before due") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "45" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(drafts[drafts.length - 1].preDueReminderDays).toEqual([45, 21]);
    const group = screen.getByRole("group", { name: "Days before due" });
    const labels = Array.from(group.querySelectorAll("button[aria-pressed]")).map((b) => b.textContent);
    expect(labels[0]).toBe("45 days");
    expect(pressed("45 days")).toBe("true");

    // 7 is a default: adding it as "custom" just turns that chip on, no duplicate.
    fireEvent.click(screen.getByRole("button", { name: "+ Custom" }));
    const input2 = screen.getByLabelText("Custom days before due") as HTMLInputElement;
    fireEvent.change(input2, { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Add custom day" }));
    expect(drafts[drafts.length - 1].preDueReminderDays).toEqual([45, 21, 7]);
    expect(screen.getAllByRole("button", { name: "7 days" }).length).toBe(1);

    // A custom chip only exists while it is on.
    fireEvent.click(screen.getByRole("button", { name: "45 days" }));
    expect(drafts[drafts.length - 1].preDueReminderDays).toEqual([21, 7]);
    expect(screen.queryByRole("button", { name: "45 days" })).toBeNull();
  });

  it("refuses an out-of-range custom day with a sentence and changes nothing", () => {
    const drafts: ManagerAutomationSettings[] = [];
    render(<Harness initial={{ preDueReminderDays: [21], sameDayReminderEnabled: false, overdueDailyEnabled: false }} onDraft={(d) => drafts.push(d)} />);
    fireEvent.click(screen.getByRole("button", { name: "+ Custom" }));
    const input = screen.getByLabelText("Custom days before due") as HTMLInputElement;
    for (const bad of ["0", "61", "x", ""]) {
      fireEvent.change(input, { target: { value: bad } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(screen.getByRole("alert").textContent).toContain("1 to 60");
    }
    expect(drafts.length).toBe(0);
    // Escape closes the box without adding anything.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByLabelText("Custom days before due")).toBeNull();
    expect(screen.getByRole("button", { name: "+ Custom" })).toBeTruthy();
  });

  it("allows an empty schedule and says what it means", () => {
    const drafts: ManagerAutomationSettings[] = [];
    render(<Harness initial={{ preDueReminderDays: [3], sameDayReminderEnabled: true, overdueDailyEnabled: false }} onDraft={(d) => drafts.push(d)} />);
    fireEvent.click(screen.getByRole("button", { name: "3 days" }));
    fireEvent.click(screen.getByRole("button", { name: "Due date" }));
    const last = drafts[drafts.length - 1];
    expect(last.preDueReminderDays).toEqual([]);
    expect(last.sameDayReminderEnabled).toBe(false);
    expect(screen.getByText(EMPTY_REMINDER_SCHEDULE_SUMMARY)).toBeTruthy();
  });
});
