import { readFileSync } from "node:fs";
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

  it("includes Send setup when there is no portal user", () => {
    const actions = personRecordListActions({
      kind: "vendor",
      hasPortalUser: false,
    });
    expect(actions[0]).toEqual({ id: "setup", label: "Send setup" });
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

  it("resident Send setup is hidden after login and defaults SMS, email, and PropLane", () => {
    const src = readFileSync("src/components/portal/pro-residents.tsx", "utf8");
    expect(src).toContain('title="Send setup"');
    expect(src).toContain("selectedHasPortalAccount ? null");
    expect(src).toContain("singleListSelectedNeedsSetup");
    const setupModal = src.slice(src.indexOf('title="Send setup"'), src.indexOf('confirmLabel="Send setup"'));
    expect(setupModal).toContain("defaultViaEmail");
    expect(setupModal).toContain("defaultViaSms");
    expect(setupModal).not.toContain("defaultViaSms={false}");
    const onboardBlock = src.slice(
      src.indexOf("onboard-existing-resident"),
      src.indexOf('if (opts?.channels && (viaSms || viaEmail || viaInbox))'),
    );
    expect(onboardBlock).toContain("viaEmail");
    expect(onboardBlock).toContain("viaSms");
    expect(onboardBlock).toContain("viaInbox");
    expect(onboardBlock).not.toContain("send-inbox-message");
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
