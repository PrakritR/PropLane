import { describe, expect, it } from "vitest";
import { teamRecipientsScopedToSubject, type TeamReminderRecipient } from "@/lib/reminders/manager-recipients.server";
import { DEFAULT_REMINDER_RULES } from "@/lib/reminders/rules";

/**
 * A reminder must not reach a co-manager the API would refuse. An outgoing
 * payment carries payee, amount, due date and property, and `GET
 * /api/manager-bills` is owner-only — so fan-out has to respect the invite's
 * property assignment and per-property module grants, not just "is linked".
 */
function member(overrides: Partial<TeamReminderRecipient> = {}): TeamReminderRecipient {
  return {
    userId: "co-1",
    email: "co@example.com",
    name: "Co Manager",
    assignedPropertyIds: ["prop-1"],
    permissions: { "prop-1": { financials: { notification: true } } },
    ...overrides,
  };
}

describe("teamRecipientsScopedToSubject", () => {
  it("keeps a co-manager assigned the property and granted the module", () => {
    expect(teamRecipientsScopedToSubject([member()], "prop-1", "financials")).toHaveLength(1);
  });

  it("drops a co-manager who was never assigned that property", () => {
    expect(teamRecipientsScopedToSubject([member()], "prop-2", "financials")).toHaveLength(0);
  });

  it("drops a co-manager assigned the property but not granted the module", () => {
    const m = member({ permissions: { "prop-1": { services: { read: true } } } });
    expect(teamRecipientsScopedToSubject([m], "prop-1", "financials")).toHaveLength(0);
  });

  it("treats an empty permission map as no access, never as full access", () => {
    const m = member({ permissions: {} });
    expect(teamRecipientsScopedToSubject([m], "prop-1", "financials")).toHaveLength(0);
  });

  it("drops a co-manager with no property assignment at all", () => {
    const m = member({ assignedPropertyIds: [] });
    expect(teamRecipientsScopedToSubject([m], "prop-1", "financials")).toHaveLength(0);
  });

  it("requires the module on EVERY assigned property when the subject has none", () => {
    const partial = member({
      assignedPropertyIds: ["prop-1", "prop-2"],
      permissions: { "prop-1": { financials: { notification: true } } },
    });
    expect(teamRecipientsScopedToSubject([partial], null, "financials")).toHaveLength(0);

    const full = member({
      assignedPropertyIds: ["prop-1", "prop-2"],
      permissions: {
        "prop-1": { financials: { notification: true } },
        "prop-2": { financials: { notification: true } },
      },
    });
    expect(teamRecipientsScopedToSubject([full], null, "financials")).toHaveLength(1);
  });
});

describe("reminder audience defaults", () => {
  it("never defaults a subject to the team audience", () => {
    for (const [kind, rule] of Object.entries(DEFAULT_REMINDER_RULES)) {
      expect(rule.audience.team, `${kind} must not fan out to the team by default`).toBe(false);
    }
  });
});
