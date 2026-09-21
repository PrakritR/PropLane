// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InboxScheduledCard } from "@/components/portal/portal-inbox-ui";
import {
  DEFAULT_MANAGER_AUTOMATION_SETTINGS,
  scheduledOverrideId,
  type ScheduledMessageOverride,
} from "@/lib/payment-automation-settings";
import { projectScheduledPaymentMessages } from "@/lib/scheduled-payment-messages";
import { combineScheduledPaymentMessages } from "@/lib/combined-payment-reminders";
import {
  automationChannelDefaultsFromSettings,
  threadScheduledItemFromAutomationMessage,
} from "@/lib/inbox-scheduled-thread";
import type { HouseholdCharge } from "@/lib/household-charges";

/**
 * A manager can now point ONE automated reminder at a different channel from
 * the automation's own delivery settings. Every failure here is silent by
 * nature — a dropped choice still sends a perfectly good message, just to the
 * wrong place — so the projection, the bundler and the card each get a test.
 */

const MANAGER = "mgr-1";

function makeCharge(overrides: Partial<HouseholdCharge> = {}): HouseholdCharge {
  return {
    id: "hc_rent_resident@test.com_prop1_2026-06",
    createdAt: new Date().toISOString(),
    residentEmail: "resident@test.com",
    residentName: "Resident Test",
    residentUserId: null,
    propertyId: "prop-1",
    propertyLabel: "Test Property",
    managerUserId: MANAGER,
    kind: "rent",
    title: "June rent",
    amountLabel: "$1000.00",
    balanceLabel: "$1000.00",
    status: "pending",
    blocksLeaseUntilPaid: false,
    rentMonth: "2026-06",
    dueDay: 10,
    dueDayMode: "first_of_month",
    ...overrides,
  };
}

function overridesFor(
  chargeId: string,
  patch: ScheduledMessageOverride,
): Map<string, ScheduledMessageOverride> {
  return new Map([
    [
      scheduledOverrideId({ managerUserId: MANAGER, chargeId, kind: "pre_due", daysBeforeDue: 7 }),
      patch,
    ],
  ]);
}

function project(
  charges: HouseholdCharge[],
  overrides?: Map<string, ScheduledMessageOverride>,
) {
  return projectScheduledPaymentMessages({
    managerUserId: MANAGER,
    charges,
    settings: { ...DEFAULT_MANAGER_AUTOMATION_SETTINGS, preDueReminderDays: [7] },
    overrides,
    now: new Date(2026, 5, 1),
    includeHidden: true,
  }).filter((m) => m.kind === "pre_due");
}

describe("per-reminder channel override", () => {
  it("leaves the channel absent when the manager never set one", () => {
    // Absent is not "off". The send path reads absence as "use the automation's
    // delivery settings", so a default row must not claim a decision.
    const [row] = project([makeCharge()]);
    expect(row).toBeTruthy();
    expect(row!.deliverViaEmail).toBeUndefined();
    expect(row!.deliverViaSms).toBeUndefined();
  });

  it("carries a stored choice onto the projected reminder", () => {
    const charge = makeCharge();
    const [row] = project(
      [charge],
      overridesFor(charge.id, { customDeliverViaEmail: false, customDeliverViaSms: true }),
    );
    expect(row!.deliverViaEmail).toBe(false);
    expect(row!.deliverViaSms).toBe(true);
  });

  it("keeps a channel turned OFF rather than falling back to the default", () => {
    // The `false` case is the one a `||` fallback would quietly undo.
    const charge = makeCharge();
    const [row] = project([charge], overridesFor(charge.id, { customDeliverViaEmail: false }));
    expect(row!.deliverViaEmail).toBe(false);
  });

  it("does not bundle two reminders the manager pointed at different channels", () => {
    // Bundling keeps only the first row's channel, so combining these would
    // send one of them somewhere the manager did not choose.
    const a = makeCharge({ id: "hc_a", title: "June rent" });
    const b = makeCharge({ id: "hc_b", title: "June parking" });
    const overrides = new Map([
      ...overridesFor(a.id, { customDeliverViaSms: true, customDeliverViaEmail: false }),
      ...overridesFor(b.id, { customDeliverViaSms: false, customDeliverViaEmail: true }),
    ]);
    const rows = project([a, b], overrides);
    expect(rows.length).toBe(2);
    expect(combineScheduledPaymentMessages(rows).length).toBe(2);
  });

  it("still bundles two reminders that agree on the channel", () => {
    const a = makeCharge({ id: "hc_a", title: "June rent" });
    const b = makeCharge({ id: "hc_b", title: "June parking" });
    const overrides = new Map([
      ...overridesFor(a.id, { customDeliverViaSms: true, customDeliverViaEmail: false }),
      ...overridesFor(b.id, { customDeliverViaSms: true, customDeliverViaEmail: false }),
    ]);
    const rows = project([a, b], overrides);
    expect(rows.length).toBe(2);
    const combined = combineScheduledPaymentMessages(rows);
    expect(combined.length).toBe(1);
    expect(combined[0]!.deliverViaSms).toBe(true);
    expect(combined[0]!.deliverViaEmail).toBe(false);
  });

  it("shows the stored choice on the thread card, and the email shape when there is none", () => {
    const charge = makeCharge();
    const [plain] = project([charge]);
    const plainCard = threadScheduledItemFromAutomationMessage(plain!);
    expect(plainCard.deliverViaEmail).toBe(true);
    expect(plainCard.deliverViaSms).toBe(false);
    expect(plainCard.channel).toBe("email");

    const [texted] = project(
      [charge],
      overridesFor(charge.id, { customDeliverViaEmail: false, customDeliverViaSms: true }),
    );
    const textedCard = threadScheduledItemFromAutomationMessage(texted!);
    expect(textedCard.deliverViaEmail).toBe(false);
    expect(textedCard.deliverViaSms).toBe(true);
    expect(textedCard.channel).toBe("sms");
  });

  it("shows what a NEVER-overridden reminder will actually do, not an email-only guess", () => {
    // A manager whose payment reminders go out by SMS only saw "Email" on every
    // untouched reminder — and the card is editable now, so that guess was one
    // save away from becoming the stored truth.
    const smsOnly = automationChannelDefaultsFromSettings({
      paymentReminderDeliverViaEmail: false,
      paymentReminderDeliverViaSms: true,
    });
    const [plain] = project([makeCharge()]);
    const card = threadScheduledItemFromAutomationMessage(plain!, smsOnly);
    expect(card.deliverViaEmail).toBe(false);
    expect(card.deliverViaSms).toBe(true);
    expect(card.channel).toBe("sms");
  });

  it("lets the reminder's OWN choice beat the automation default", () => {
    const smsOnly = automationChannelDefaultsFromSettings({
      paymentReminderDeliverViaEmail: false,
      paymentReminderDeliverViaSms: true,
    });
    const charge = makeCharge();
    const [emailed] = project(
      [charge],
      overridesFor(charge.id, { customDeliverViaEmail: true, customDeliverViaSms: false }),
    );
    const card = threadScheduledItemFromAutomationMessage(emailed!, smsOnly);
    expect(card.deliverViaEmail).toBe(true);
    expect(card.deliverViaSms).toBe(false);
  });
});

afterEach(cleanup);

describe("Send via on an automated reminder", () => {
  function renderAutomationCard() {
    return render(
      <InboxScheduledCard
        sendLabel="Sep 30, 2026, 9:00 AM"
        subject="Payment due in 21 days: Security deposit"
        body="This is a reminder that your Security deposit payment is due."
        source="automation"
        presentation="detail"
        emailAvailable
        smsAvailable
        recipient="marcus.chen@test.proplane.local"
        editable
        onCancel={vi.fn()}
        onSendNow={vi.fn()}
        onSaveEdit={vi.fn()}
      />,
    );
  }

  it("lets the manager change the channel", () => {
    // It used to be disabled here: the channel was only editable on MANUAL
    // scheduled messages, because a reminder had nowhere to store one.
    renderAutomationCard();
    const trigger = screen.getByLabelText("Send via");
    expect(trigger.hasAttribute("disabled")).toBe(false);
    expect(trigger.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("hands the chosen channel to the save when the manager moves it", async () => {
    const onSaveEdit = vi.fn();
    render(
      <InboxScheduledCard
        sendLabel="Sep 30, 2026, 9:00 AM"
        subject="Payment due in 21 days: Security deposit"
        body="This is a reminder that your Security deposit payment is due."
        source="automation"
        presentation="detail"
        emailAvailable
        smsAvailable
        deliverViaEmail
        deliverViaSms={false}
        recipient="marcus.chen@test.proplane.local"
        editable
        onCancel={vi.fn()}
        onSendNow={vi.fn()}
        onSaveEdit={onSaveEdit}
      />,
    );
    await userEvent.click(screen.getByLabelText("Send via"));
    await userEvent.click(await screen.findByText(/^SMS$/i));
    fireEvent.click(screen.getByRole("button", { name: /Schedule|Save/i }));

    expect(onSaveEdit).toHaveBeenCalled();
    const arg = onSaveEdit.mock.calls[0]![0] as { deliverViaEmail?: boolean; deliverViaSms?: boolean };
    // The channel travels with the save now, rather than being dropped because
    // the row happened to come from an automation.
    expect(arg.deliverViaEmail).toBe(true);
    expect(arg.deliverViaSms).toBe(true);
  });

  it("does NOT write a channel when the manager only edited the body", async () => {
    // An automated reminder with no override of its own follows the automation
    // settings, and absence is what keeps it doing that. Emitting the displayed
    // channel on a body-only save froze the reminder onto whatever the card
    // happened to show.
    const onSaveEdit = vi.fn();
    render(
      <InboxScheduledCard
        sendLabel="Sep 30, 2026, 9:00 AM"
        subject="Payment due in 21 days: Security deposit"
        body="This is a reminder that your Security deposit payment is due."
        source="automation"
        presentation="detail"
        emailAvailable
        smsAvailable
        deliverViaEmail
        deliverViaSms={false}
        recipient="marcus.chen@test.proplane.local"
        editable
        onCancel={vi.fn()}
        onSendNow={vi.fn()}
        onSaveEdit={onSaveEdit}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/Write your message/i), {
      target: { value: "Fixed a typo." },
    });
    fireEvent.click(screen.getByRole("button", { name: /Schedule|Save/i }));

    expect(onSaveEdit).toHaveBeenCalled();
    const arg = onSaveEdit.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.body).toBe("Fixed a typo.");
    expect("deliverViaEmail" in arg).toBe(false);
    expect("deliverViaSms" in arg).toBe(false);
  });

  it("keeps an SMS-only reminder on SMS when a surface cannot offer SMS", () => {
    // The charge Reminders modal used to pass no channel props at all, so the
    // card fell back to email-only and every save moved the reminder off SMS.
    const onSaveEdit = vi.fn();
    render(
      <InboxScheduledCard
        sendLabel="Sep 30, 2026, 9:00 AM"
        subject="Payment due in 21 days: Security deposit"
        body="This is a reminder that your Security deposit payment is due."
        source="automation"
        presentation="detail"
        emailAvailable
        smsAvailable={false}
        deliverViaEmail={false}
        deliverViaSms
        recipient="marcus.chen@test.proplane.local"
        editable
        onCancel={vi.fn()}
        onSendNow={vi.fn()}
        onSaveEdit={onSaveEdit}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Schedule|Save/i }));

    const arg = onSaveEdit.mock.calls[0]![0] as Record<string, unknown>;
    expect("deliverViaEmail" in arg).toBe(false);
    expect("deliverViaSms" in arg).toBe(false);
  });
});
