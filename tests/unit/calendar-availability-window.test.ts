/**
 * The Add availability popup's model (studio-redesign-0929 C2-CALA2, CALA7):
 * what Save writes, what the small week previews, and Copy previous week /
 * Clear week on the stored slot sets.
 */
import { describe, expect, it } from "vitest";
import {
  ALL_HOUSES,
  AVAILABILITY_KIND_CHOICES,
  EVERY_WEEK_HORIZON_WEEKS,
  addKeys,
  choicesForStorageKinds,
  clearWeek,
  copyPreviousWeek,
  draftDates,
  draftSlotKeys,
  isRealDateStr,
  mondayOfDateStr,
  normalizeDraftStart,
  previewWeek,
  removeRun,
  shiftDateStr,
  storageKindsForChoices,
  toggleExclusiveChoice,
  validateDraft,
  weekdayOfDateStr,
  type AvailabilityDraft,
} from "@/lib/calendar-availability-window";
import { AVAILABILITY_KINDS } from "@/lib/manager-availability-kinds";
import { defaultTourSlotExclusionKey } from "@/lib/tour-slot-math";

const base: AvailabilityDraft = {
  kinds: ["tours"],
  on: "days",
  weekdays: [1],
  date: "2026-10-06",
  repeat: "week",
  startSlot: 26,
  endSlotExclusive: 32,
  propertyIds: [ALL_HOUSES],
  weekMonday: "2026-10-05",
};

describe("date helpers", () => {
  it("finds weekdays and Mondays without the server's zone", () => {
    expect(weekdayOfDateStr("2026-10-05")).toBe(0);
    expect(weekdayOfDateStr("2026-10-11")).toBe(6);
    expect(mondayOfDateStr("2026-10-11")).toBe("2026-10-05");
    expect(shiftDateStr("2026-10-31", 1)).toBe("2026-11-01");
    expect(isRealDateStr("2026-02-30")).toBe(false);
    expect(isRealDateStr("2026-02-28")).toBe(true);
  });
});

describe("exclusive choices (C2-CALA2)", () => {
  it("Everything clears the specific picks, and a specific pick clears Everything", () => {
    expect(toggleExclusiveChoice(["tours", "services"], "everything", true, "everything")).toEqual(["everything"]);
    expect(toggleExclusiveChoice(["everything"], "services", true, "everything")).toEqual(["services"]);
    expect(toggleExclusiveChoice(["services"], "tours", true, "everything")).toEqual(["services", "tours"]);
  });

  it("falls back to the exclusive entry when the last pick is unticked", () => {
    expect(toggleExclusiveChoice(["tours"], "tours", false, "everything")).toEqual(["everything"]);
    expect(toggleExclusiveChoice([ALL_HOUSES], ALL_HOUSES, false, ALL_HOUSES)).toEqual([ALL_HOUSES]);
  });

  it("offers exactly Tours, Services and Tasks, no Everything", () => {
    expect(AVAILABILITY_KIND_CHOICES.map((choice) => choice.label)).toEqual(["Tours", "Services", "Tasks"]);
    expect(AVAILABILITY_KINDS).toEqual(["tours", "services", "tasks"]);
  });

  it("maps choices to the kinds that are stored, in the fixed order", () => {
    expect(storageKindsForChoices(["tasks", "tours"])).toEqual(["tours", "tasks"]);
    expect(storageKindsForChoices([])).toEqual([]);
    expect(choicesForStorageKinds(AVAILABILITY_KINDS)).toEqual([...AVAILABILITY_KINDS]);
    expect(choicesForStorageKinds(["services", "tours"])).toEqual(["tours", "services"]);
  });
});

describe("what Save writes", () => {
  it("'This week only' is the picked days of that week", () => {
    const draft = { ...base, weekdays: [0, 2] };
    expect(draftDates(draft)).toEqual(["2026-10-05", "2026-10-07"]);
    expect(draftSlotKeys(draft)).toHaveLength(2 * 6);
    expect(draftSlotKeys(draft)[0]).toBe("2026-10-05:26");
  });

  it("'Every week' repeats the days over the horizon, and one week only is one week", () => {
    const weekly = draftDates({ ...base, repeat: "weekly", weekdays: [1] });
    expect(weekly).toHaveLength(EVERY_WEEK_HORIZON_WEEKS);
    expect(weekly[0]).toBe("2026-10-06");
    expect(weekly[1]).toBe("2026-10-13");
  });

  it("'A date' is that date only, and an impossible date writes nothing", () => {
    expect(draftDates({ ...base, on: "date", date: "2026-10-14" })).toEqual(["2026-10-14"]);
    expect(draftDates({ ...base, on: "date", date: "2026-02-30" })).toEqual([]);
  });

  it("writes nothing for an end before the start", () => {
    expect(draftSlotKeys({ ...base, startSlot: 30, endSlotExclusive: 30 })).toEqual([]);
  });

  it("starts an Every-week window no earlier than the current week", () => {
    const past = { ...base, repeat: "weekly" as const, weekMonday: "2026-09-21" };
    expect(normalizeDraftStart(past, "2026-10-08").weekMonday).toBe("2026-10-05");
    expect(normalizeDraftStart({ ...base, weekMonday: "2026-09-21" }, "2026-10-08").weekMonday).toBe("2026-09-21");
  });

  it("validates the form", () => {
    expect(validateDraft(base)).toBeNull();
    expect(validateDraft({ ...base, kinds: [] })).toBe("Pick what you are available for");
    expect(validateDraft({ ...base, weekdays: [] })).toBe("Pick at least one day");
    expect(validateDraft({ ...base, on: "date", date: "" })).toBe("Pick a date");
    expect(validateDraft({ ...base, endSlotExclusive: 26 })).toBe("The end time has to be after the start");
    expect(validateDraft({ ...base, propertyIds: [] })).toBe("Pick at least one house");
  });
});

describe("the popup's week preview (C2-CALA2)", () => {
  it("is exactly the bands Save creates in that week", () => {
    const draft = { ...base, weekdays: [1, 3] };
    const preview = previewWeek(draft);
    expect(preview.weekdays).toEqual([1, 3]);
    const keys = draftSlotKeys(draft);
    expect(new Set(keys.map((key) => weekdayOfDateStr(key.split(":")[0]!)))).toEqual(new Set(preview.weekdays));
    expect(preview.weekOf).toBe("2026-10-05");
  });

  it("says 'every week' for a repeating window and follows a picked date to its week", () => {
    expect(previewWeek({ ...base, repeat: "weekly" }).weekOf).toBeNull();
    const dated = previewWeek({ ...base, on: "date", date: "2026-10-14" });
    expect(dated).toMatchObject({ weekOf: "2026-10-12", weekdays: [2] });
  });
});

describe("Copy previous week (C2-CALA7)", () => {
  it("brings last week's windows into this week and replaces what was there", () => {
    const current = new Set(["2026-09-29:20", "2026-09-30:21", "2026-10-07:30", "2026-10-20:18"]);
    const next = copyPreviousWeek(current, "2026-10-05");
    expect([...next].sort()).toEqual(["2026-09-29:20", "2026-09-30:21", "2026-10-06:20", "2026-10-07:21", "2026-10-20:18"].sort());
  });

  it("carries the days last week had cleared (default windows removed)", () => {
    const current = new Set([defaultTourSlotExclusionKey("2026-09-29", 18), "2026-10-07:30"]);
    const next = copyPreviousWeek(current, "2026-10-05");
    expect(next.has(defaultTourSlotExclusionKey("2026-10-06", 18))).toBe(true);
    expect(next.has("2026-10-07:30")).toBe(false);
    expect(next.has(defaultTourSlotExclusionKey("2026-09-29", 18))).toBe(true);
  });
});

describe("Clear week (C2-CALA7)", () => {
  it("removes this week's windows and leaves every other week alone", () => {
    const current = new Set(["2026-10-05:20", "2026-10-11:40", "2026-10-12:20", "2026-09-28:20"]);
    const next = clearWeek(current, "2026-10-05");
    expect([...next].sort()).toEqual(["2026-09-28:20", "2026-10-12:20"]);
  });

  it("keeps a repeating window repeating in the other weeks", () => {
    const weekly = new Set(draftSlotKeys({ ...base, repeat: "weekly", weekMonday: "2026-10-05" }));
    const next = clearWeek(weekly, "2026-10-05");
    expect(next.has("2026-10-06:26")).toBe(false);
    expect(next.has("2026-10-13:26")).toBe(true);
  });

  it("excludes the week's default tour windows when the 9 to 5 default is on, so it stays cleared", () => {
    const next = clearWeek(new Set(), "2026-10-05", { startSlot: 18, endSlotExclusive: 20 });
    expect(next.has(defaultTourSlotExclusionKey("2026-10-05", 18))).toBe(true);
    expect(next.has(defaultTourSlotExclusionKey("2026-10-11", 19))).toBe(true);
    expect(next.has(defaultTourSlotExclusionKey("2026-10-12", 18))).toBe(false);
  });
});

describe("editing a band (C2-CALA5)", () => {
  it("strips the clicked run on its date before the replacement is added", () => {
    const current = new Set(["2026-10-06:20", "2026-10-06:21", "2026-10-06:30", "2026-10-13:20"]);
    const stripped = removeRun(current, "2026-10-06", 20, 22);
    expect([...stripped].sort()).toEqual(["2026-10-06:30", "2026-10-13:20"]);
    const replaced = addKeys(stripped, ["2026-10-06:24"]);
    expect(replaced.has("2026-10-06:24")).toBe(true);
  });
});
