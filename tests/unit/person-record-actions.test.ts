import { describe, expect, it } from "vitest";
import {
  personRecordListActions,
  personRecordNeedsYouItems,
  personRecordReminderKind,
  personRecordReminderLabel,
} from "@/lib/person-record-actions";

describe("person-record-actions", () => {
  it("omits setup when the person already has a portal user", () => {
    const actions = personRecordListActions({
      kind: "resident",
      hasPortalUser: true,
    });
    expect(actions.map((a) => a.id)).toEqual(["edit", "delete"]);
  });

  it("includes Message to setup account when there is no portal user", () => {
    const actions = personRecordListActions({
      kind: "vendor",
      hasPortalUser: false,
    });
    expect(actions[0]).toEqual({ id: "setup", label: "Message to setup account" });
  });

  it("picks application over lease over tour for the one reminder", () => {
    expect(
      personRecordReminderKind({
        applicationIncomplete: true,
        leaseUnsigned: true,
        tourPending: true,
      }),
    ).toBe("application");
    expect(
      personRecordReminderKind({
        applicationIncomplete: false,
        leaseUnsigned: true,
        tourPending: true,
      }),
    ).toBe("lease");
    expect(
      personRecordReminderKind({
        tourPending: true,
      }),
    ).toBe("tour");
    expect(personRecordReminderKind({})).toBeNull();
  });

  it("labels the reminder by stage", () => {
    expect(personRecordReminderLabel("application")).toBe("Remind to finish application");
    expect(personRecordReminderLabel("lease")).toBe("Remind to sign lease");
    expect(personRecordReminderLabel("tour")).toBe("Remind for tour");
    expect(personRecordReminderLabel(null)).toBeNull();
  });

  it("shows no setup or reminder for a current signed resident with an account and no tour", () => {
    const actions = personRecordListActions({
      kind: "resident",
      hasPortalUser: true,
      applicationIncomplete: false,
      leaseUnsigned: false,
      tourPending: false,
    });
    expect(actions.map((a) => a.id)).toEqual(["edit", "delete"]);
    expect(personRecordNeedsYouItems({
      kind: "resident",
      hasPortalUser: true,
    })).toEqual([]);
  });

  it("Needs you lists setup and the stage reminder when those apply", () => {
    const items = personRecordNeedsYouItems({
      kind: "resident",
      hasPortalUser: false,
      applicationIncomplete: true,
    });
    expect(items.map((i) => i.id)).toEqual(["setup", "remind"]);
    expect(items[1]?.title).toBe("Remind to finish application");
  });
});
