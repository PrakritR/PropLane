/**
 * Reminder copy.
 *
 * The load-bearing rule here is that the two sides read differently: the
 * counterparty is told about THEIR appointment, the manager about someone
 * else's. Sending one voice to both is how a reminder reads as spam to the
 * person who scheduled it.
 */
import { describe, expect, it } from "vitest";
import { leadPhrase, renderReminder } from "@/lib/reminders/render";
import { DAY, HOUR } from "@/lib/reminders/rules";

const tourPayload = {
  title: "Tour",
  whenLabel: "Sun, Aug 30 at 2:00 PM",
  propertyLabel: "The Pioneer",
  counterpartyName: "Priya Nair",
  managerName: "Sam Okafor",
  recipientName: "Priya Nair",
  url: "https://prop-lane.space/portal/tours/t-1",
};

describe("leadPhrase", () => {
  it("says the lead time the way a person would", () => {
    expect(leadPhrase(15)).toBe("in 15 minutes");
    expect(leadPhrase(HOUR)).toBe("in 1 hour");
    expect(leadPhrase(DAY)).toBe("in 1 day");
  });
});

describe("the guest's copy vs the manager's", () => {
  it("addresses the guest about their own tour", () => {
    const out = renderReminder({
      kind: "tour",
      leadMinutes: 30,
      recipientRole: "counterparty",
      payload: tourPayload,
    });
    expect(out.subject).toBe("Reminder: your tour at The Pioneer is in 30 minutes");
    expect(out.body).toContain("Hi Priya Nair,");
    expect(out.body).toContain("your upcoming tour at The Pioneer");
    expect(out.body).toContain("When: Sun, Aug 30 at 2:00 PM");
    // The guest hears from the manager, so the manager signs it.
    expect(out.body).toContain("Sam Okafor");
  });

  it("tells the manager whose tour it is, and never says “your tour”", () => {
    const out = renderReminder({
      kind: "tour",
      leadMinutes: 30,
      recipientRole: "manager",
      payload: { ...tourPayload, recipientName: "Sam Okafor" },
    });
    expect(out.subject).toBe("Priya Nair's tour at The Pioneer is in 30 minutes");
    expect(out.body).toContain("With: Priya Nair");
    expect(out.body).not.toContain("your tour");
    expect(out.body).not.toContain("your upcoming");
  });
});

describe("a task is a deadline, not an appointment", () => {
  it("reads “due”, never “starts”", () => {
    const out = renderReminder({
      kind: "task",
      leadMinutes: DAY,
      recipientRole: "counterparty",
      payload: { title: "Collect rent", whenLabel: "Mon, Aug 31", recipientName: "Ada" },
    });
    expect(out.subject).toContain("Collect rent");
    expect(out.subject).toContain("due");
    expect(out.body).toContain("is due in 1 day");
    expect(out.body).not.toContain("starts");
  });

  it("does not print a property line for a task", () => {
    const out = renderReminder({
      kind: "task",
      leadMinutes: DAY,
      recipientRole: "manager",
      payload: { title: "Collect rent", propertyLabel: "The Pioneer" },
    });
    expect(out.body).not.toContain("Property: The Pioneer");
  });
});

describe("missing fields degrade instead of printing placeholders", () => {
  it("greets without a name and omits every absent line", () => {
    const out = renderReminder({
      kind: "service_order",
      leadMinutes: HOUR,
      recipientRole: "counterparty",
      payload: {},
    });
    expect(out.body.startsWith("Hi,")).toBe(true);
    expect(out.body).not.toContain("When:");
    expect(out.body).not.toContain("Where:");
    expect(out.body).not.toContain("View it here");
    expect(out.body).not.toContain("null");
    expect(out.body).not.toContain("undefined");
    // Still says the useful thing.
    expect(out.subject).toBe("Reminder: your service visit is in 1 hour");
  });

  it("never leaves a blank run or trailing whitespace in the body", () => {
    const out = renderReminder({
      kind: "booking",
      leadMinutes: 3 * DAY,
      recipientRole: "counterparty",
      payload: { title: "Stay", whenLabel: "Sep 2", recipientName: "Bo" },
    });
    expect(out.body).not.toMatch(/\n{3,}/);
    expect(out.body).toBe(out.body.trim());
  });

  it("includes the deep link only when there is one", () => {
    const withUrl = renderReminder({
      kind: "work_order",
      leadMinutes: 30,
      recipientRole: "counterparty",
      payload: { url: "https://prop-lane.space/x" },
    });
    expect(withUrl.body).toContain("View it here: https://prop-lane.space/x");
  });
});

describe("every subject renders a distinct noun", () => {
  it.each([
    ["tour", "tour"],
    ["service_order", "service visit"],
    ["work_order", "maintenance visit"],
    ["booking", "stay"],
  ] as const)("%s reads as “%s”", (kind, noun) => {
    const out = renderReminder({
      kind,
      leadMinutes: 30,
      recipientRole: "counterparty",
      payload: {},
    });
    expect(out.subject).toContain(noun);
  });
});
