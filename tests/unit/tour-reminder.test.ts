import { describe, expect, it } from "vitest";
import { normalizeTourReminderMinutesBeforeList } from "@/lib/payment-automation-settings";
import {
  DEFAULT_TOUR_REMINDER_TEMPLATE,
  fillTourReminderTemplate,
  tourReminderSendAtIso,
} from "@/lib/tour-reminder";

describe("tour-reminder", () => {
  it("normalizes multi-select minutes and dedupes", () => {
    expect(normalizeTourReminderMinutesBeforeList([30, 15, 30, 90], 60)).toEqual([90, 30, 15]);
    expect(normalizeTourReminderMinutesBeforeList(null, 45)).toEqual([45]);
  });

  it("fills template placeholders", () => {
    const { subject, body } = fillTourReminderTemplate(DEFAULT_TOUR_REMINDER_TEMPLATE, {
      guestName: "Alex",
      propertyTitle: "Oak Street",
      tourTime: "Mon 3:00 PM",
      managerName: "Jamie",
      instructions: "Ring the bell",
    });
    expect(subject).toContain("Oak Street");
    expect(body).toContain("Hi Alex");
    expect(body).toContain("Mon 3:00 PM");
    expect(body).toContain("Ring the bell");
  });

  it("computes send time before tour start", () => {
    const tourStart = "2030-06-15T18:00:00.000Z";
    const now = new Date("2030-06-15T16:00:00.000Z");
    const sendAt = tourReminderSendAtIso(tourStart, 30, now);
    expect(sendAt).toBe("2030-06-15T17:30:00.000Z");
  });

  it("returns null when reminder would be in the past", () => {
    const tourStart = "2020-01-01T18:00:00.000Z";
    const sendAt = tourReminderSendAtIso(tourStart, 30, new Date("2020-01-01T17:45:00.000Z"));
    expect(sendAt).toBeNull();
  });
});
