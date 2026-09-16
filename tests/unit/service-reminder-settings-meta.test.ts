import { describe, expect, it } from "vitest";
import { reminderSubjectSettingsMeta } from "@/lib/reminders/subject-settings-meta";

describe("service reminder settings meta (PRP-403)", () => {
  it("labels work-order counterparty as the resident — the assigned vendor rides with Team", () => {
    expect(reminderSubjectSettingsMeta("work_order")?.notifyCounterpartyLabel).toBe("Resident");
  });

  it("uses Service visit subject copy for both service kinds", () => {
    expect(reminderSubjectSettingsMeta("work_order")?.defaultTemplate.subject).toContain("Service visit");
    expect(reminderSubjectSettingsMeta("service_order")?.defaultTemplate.subject).toContain("Service visit");
  });
});
