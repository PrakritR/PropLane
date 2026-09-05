/**
 * The reminder spine's rule model.
 *
 * These cases pin the two things that made short lead times impossible before:
 * one unit (minutes) for every subject, and a send time that is only ever
 * scheduled into the future.
 */
import { describe, expect, it } from "vitest";
import {
  DAY,
  DEFAULT_QUIET_HOURS,
  DEFAULT_REMINDER_RULES,
  HOUR,
  MAX_LEADS_PER_RULE,
  MAX_LEAD_MINUTES,
  MIN_LEAD_MINUTES,
  REMINDER_SUBJECT_KINDS,
  applyQuietHours,
  clampLeadMinutes,
  formatLeadLabel,
  formatLeadSummary,
  isQuietHour,
  normalizeLeadMinutesList,
  normalizeReminderSettings,
  reminderDedupeKey,
  reminderSendTimes,
  type ReminderRule,
} from "@/lib/reminders/rules";

function rule(over: Partial<ReminderRule> = {}): ReminderRule {
  return { ...DEFAULT_REMINDER_RULES.tour, ...over };
}

describe("lead times are one unit for every subject", () => {
  it("clamps below the dispatch floor and above the 30-day ceiling", () => {
    expect(clampLeadMinutes(1)).toBe(MIN_LEAD_MINUTES);
    expect(clampLeadMinutes(0)).toBe(MIN_LEAD_MINUTES);
    expect(clampLeadMinutes(-90)).toBe(MIN_LEAD_MINUTES);
    expect(clampLeadMinutes(999_999)).toBe(MAX_LEAD_MINUTES);
    expect(clampLeadMinutes(Number.NaN)).toBe(MIN_LEAD_MINUTES);
  });

  it("dedupes and orders furthest-out first, because the UI reads it aloud", () => {
    expect(normalizeLeadMinutesList([30, 1440, 30, 60], [])).toEqual([1440, 60, 30]);
  });

  it("falls back only when nothing usable was stored", () => {
    expect(normalizeLeadMinutesList(undefined, [DAY])).toEqual([DAY]);
    expect(normalizeLeadMinutesList("not a list", [30])).toEqual([30]);
    expect(normalizeLeadMinutesList([], [HOUR])).toEqual([HOUR]);
  });

  it("caps the list so a rule cannot become a mailing list", () => {
    const many = [5, 10, 15, 20, 25, 30, 35, 40, 45];
    expect(normalizeLeadMinutesList(many, []).length).toBe(MAX_LEADS_PER_RULE);
  });

  it("labels each unit the way a person says it", () => {
    expect(formatLeadLabel(15)).toBe("15 minutes before");
    expect(formatLeadLabel(HOUR)).toBe("1 hour before");
    expect(formatLeadLabel(2 * HOUR)).toBe("2 hours before");
    expect(formatLeadLabel(DAY)).toBe("1 day before");
    expect(formatLeadLabel(3 * DAY)).toBe("3 days before");
    expect(formatLeadSummary([DAY, 30])).toBe("1 day, 30 minutes before");
    expect(formatLeadSummary([])).toBe("No reminders");
  });
});

describe("settings normalize from whatever is stored", () => {
  it("returns defaults for absent, null, and junk input", () => {
    for (const input of [undefined, null, 42, "x", []]) {
      expect(normalizeReminderSettings(input).rules).toEqual(DEFAULT_REMINDER_RULES);
    }
  });

  it("keeps a stored rule and defaults the subjects beside it", () => {
    const settings = normalizeReminderSettings({
      rules: { task: { enabled: false, leadMinutes: [120] } },
    });
    expect(settings.rules.task.enabled).toBe(false);
    expect(settings.rules.task.leadMinutes).toEqual([120]);
    // Audience and channels fall back rather than vanishing.
    expect(settings.rules.task.email).toBe(true);
    expect(settings.rules.task.audience.team).toBe(false);
    expect(settings.rules.tour).toEqual(DEFAULT_REMINDER_RULES.tour);
  });

  it("includes defaults for application, lease, and outgoing payment reminder kinds", () => {
    const settings = normalizeReminderSettings(undefined);
    for (const kind of [
      "application",
      "application_manager",
      "application_post_tour",
      "lease",
      "lease_manager",
      "payment_manager",
      "outgoing_payment",
    ] as const) {
      expect(settings.rules[kind]).toEqual(DEFAULT_REMINDER_RULES[kind]);
    }
    expect(REMINDER_SUBJECT_KINDS).toContain("application_post_tour");
    expect(REMINDER_SUBJECT_KINDS).toContain("lease_manager");
    expect(REMINDER_SUBJECT_KINDS).toContain("payment_manager");
  });

  it("splits legacy combined application and lease rules on read", () => {
    const settings = normalizeReminderSettings({
      rules: {
        application: {
          enabled: true,
          timings: ["after:1440"],
          audience: { manager: true, counterparty: true, team: false },
        },
        lease: {
          enabled: true,
          timings: ["after:2880"],
          audience: { manager: true, counterparty: true, team: false },
        },
      },
    });
    expect(settings.rules.application.audience).toEqual({ manager: false, counterparty: true, team: false });
    expect(settings.rules.application_manager.enabled).toBe(true);
    expect(settings.rules.application_manager.audience.manager).toBe(true);
    expect(settings.rules.lease.audience).toEqual({ manager: false, counterparty: true, team: false });
    expect(settings.rules.lease_manager.enabled).toBe(true);
  });

  it("normalizes team audience, teamUserIds, and template fields", () => {
    const settings = normalizeReminderSettings({
      rules: {
        lease: {
          audience: { manager: true, counterparty: false, team: true },
          teamUserIds: [" mgr-1 ", "mgr-1", "mgr-2"],
          template: { subject: " Sign ", body: " Body " },
        },
      },
    });
    expect(settings.rules.lease.audience.team).toBe(true);
    expect(settings.rules.lease.teamUserIds).toEqual(["mgr-1", "mgr-2"]);
    expect(settings.rules.lease.template).toEqual({ subject: "Sign", body: "Body" });
  });

  it("treats a zero-length quiet window as off, not as an enabled no-op", () => {
    const q = normalizeReminderSettings({
      quietHours: { enabled: true, startHour: 9, endHour: 9 },
    }).quietHours;
    expect(q.enabled).toBe(false);
  });

  it("rejects out-of-range hours instead of storing them", () => {
    const q = normalizeReminderSettings({
      quietHours: { enabled: true, startHour: 99, endHour: -3 },
    }).quietHours;
    expect(q.startHour).toBe(DEFAULT_QUIET_HOURS.startHour);
    expect(q.endHour).toBe(DEFAULT_QUIET_HOURS.endHour);
  });
});

describe("quiet hours", () => {
  const wrapping = { enabled: true, startHour: 21, endHour: 8 };
  const daytime = { enabled: true, startHour: 9, endHour: 17 };

  it("handles a window that wraps midnight", () => {
    expect(isQuietHour(wrapping, 22)).toBe(true);
    expect(isQuietHour(wrapping, 3)).toBe(true);
    expect(isQuietHour(wrapping, 8)).toBe(false);
    expect(isQuietHour(wrapping, 20)).toBe(false);
  });

  it("handles a window that does not wrap", () => {
    expect(isQuietHour(daytime, 12)).toBe(true);
    expect(isQuietHour(daytime, 17)).toBe(false);
    expect(isQuietHour(daytime, 8)).toBe(false);
  });

  it("is inert when disabled", () => {
    expect(isQuietHour({ enabled: false, startHour: 0, endHour: 23 }, 5)).toBe(false);
  });

  it("pushes a send forward out of the window, never backward", () => {
    const at3am = new Date(2026, 7, 30, 3, 12, 0, 0);
    const moved = applyQuietHours(at3am, wrapping);
    expect(moved.getHours()).toBe(8);
    expect(moved.getDate()).toBe(30);
    expect(moved.getTime()).toBeGreaterThan(at3am.getTime());
  });

  it("carries a late-night send into the NEXT day's opening hour", () => {
    const at2330 = new Date(2026, 7, 30, 23, 30, 0, 0);
    const moved = applyQuietHours(at2330, wrapping);
    expect(moved.getHours()).toBe(8);
    expect(moved.getDate()).toBe(31);
  });

  it("leaves a send outside the window exactly where it was", () => {
    const noon = new Date(2026, 7, 30, 12, 0, 0, 0);
    expect(applyQuietHours(noon, wrapping).getTime()).toBe(noon.getTime());
  });
});

describe("reminderSendTimes", () => {
  const quietOff = { enabled: false, startHour: 0, endHour: 0 };
  const now = new Date(2026, 7, 30, 9, 0, 0, 0);
  const anchor = new Date(2026, 7, 30, 15, 0, 0, 0).toISOString(); // 6h out

  it("produces one send per lead time, soonest first", () => {
    const out = reminderSendTimes(rule({ leadMinutes: [4 * HOUR, 30] }), anchor, quietOff, now);
    expect(out.map((s) => s.leadMinutes)).toEqual([4 * HOUR, 30]);
    expect(out[0]!.sendAt.getHours()).toBe(11);
    expect(out[1]!.sendAt.getHours()).toBe(14);
  });

  it("schedules a 15-minute lead time at all — the thing the daily cron could never do", () => {
    const out = reminderSendTimes(rule({ leadMinutes: [15] }), anchor, quietOff, now);
    expect(out).toHaveLength(1);
    expect(out[0]!.sendAt.toISOString()).toBe(new Date(2026, 7, 30, 14, 45).toISOString());
  });

  it("drops a lead time that already passed rather than sending it late", () => {
    // 12h before a 6h-away anchor is 6h in the past.
    const out = reminderSendTimes(rule({ leadMinutes: [12 * HOUR, 30] }), anchor, quietOff, now);
    expect(out.map((s) => s.leadMinutes)).toEqual([30]);
  });

  it("returns nothing for a disabled rule, no channel, or an unreadable anchor", () => {
    expect(reminderSendTimes(rule({ enabled: false }), anchor, quietOff, now)).toEqual([]);
    // Every channel off means there is nowhere to deliver, so nothing schedules.
    expect(reminderSendTimes(rule({ inbox: false, email: false, sms: false }), anchor, quietOff, now)).toEqual([]);
    // …but the in-app thread alone is still a real destination.
    expect(
      reminderSendTimes(rule({ inbox: true, email: false, sms: false, leadMinutes: [30] }), anchor, quietOff, now),
    ).toHaveLength(1);
    expect(reminderSendTimes(rule(), "not-a-date", quietOff, now)).toEqual([]);
    expect(reminderSendTimes(rule(), "", quietOff, now)).toEqual([]);
  });

  it("returns nothing once the anchor itself is in the past", () => {
    const past = new Date(2026, 7, 30, 8, 0, 0, 0).toISOString();
    expect(reminderSendTimes(rule({ leadMinutes: [30] }), past, quietOff, now)).toEqual([]);
  });

  it("drops a reminder that quiet hours would push past the event it announces", () => {
    // Anchor 07:00; a 30-minute lead lands 06:30, inside 21:00-08:00 quiet, and
    // would be pushed to 08:00 — after the tour. Better silent than misleading.
    const early = new Date(2026, 7, 31, 7, 0, 0, 0).toISOString();
    const out = reminderSendTimes(
      rule({ leadMinutes: [30] }),
      early,
      { enabled: true, startHour: 21, endHour: 8 },
      new Date(2026, 7, 30, 9, 0, 0, 0),
    );
    expect(out).toEqual([]);
  });

  it("uses directional timings when present, including after anchors", () => {
    const submitted = new Date(2026, 7, 30, 9, 0, 0, 0).toISOString();
    const now = new Date(2026, 7, 30, 9, 30, 0, 0);
    const out = reminderSendTimes(
      rule({
        timings: ["after:60", "after:1440"],
        leadMinutes: [30],
      }),
      submitted,
      quietOff,
      now,
    );
    expect(out.map((entry) => entry.leadMinutes)).toEqual([-60, -1440]);
    expect(out[0]!.sendAt.toISOString()).toBe(new Date(2026, 7, 30, 10, 0, 0, 0).toISOString());
    expect(out[1]!.sendAt.toISOString()).toBe(new Date(2026, 7, 31, 9, 0, 0, 0).toISOString());
  });

  it("falls back to leadMinutes when timings are absent", () => {
    const out = reminderSendTimes(rule({ leadMinutes: [30], timings: undefined }), anchor, quietOff, now);
    expect(out.map((entry) => entry.leadMinutes)).toEqual([30]);
  });
});

describe("reminderDedupeKey", () => {
  it("is stable across recipient casing and whitespace", () => {
    const a = reminderDedupeKey({ kind: "tour", subjectId: "t-1", leadMinutes: 30, recipient: "A@X.com" });
    const b = reminderDedupeKey({ kind: "tour", subjectId: " t-1 ", leadMinutes: 30, recipient: " a@x.com " });
    expect(a).toBe(b);
  });

  it("separates the manager's copy from the guest's, and each lead time", () => {
    const base = { kind: "tour" as const, subjectId: "t-1", leadMinutes: 30 };
    expect(reminderDedupeKey({ ...base, recipient: "mgr@x.com" })).not.toBe(
      reminderDedupeKey({ ...base, recipient: "guest@x.com" }),
    );
    expect(reminderDedupeKey({ ...base, recipient: "a@x.com" })).not.toBe(
      reminderDedupeKey({ ...base, leadMinutes: 1440, recipient: "a@x.com" }),
    );
  });
});
