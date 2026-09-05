import type { ReminderSubjectKind } from "@/lib/reminders/rules";
import type { TimingDirection } from "@/lib/reminders/timings";

export type ReminderAudienceMode = "manager" | "counterparty" | "both";

export type ReminderSubjectSettingsMeta = {
  directions: TimingDirection[];
  timingLabel: string;
  notifyYouLabel: string;
  notifyTeamLabel: string;
  notifyCounterpartyLabel: string;
  defaultTemplate: { subject: string; body: string };
  placeholders: string;
  previewContext: Record<string, string>;
  recipientPreview: string;
};

const APPLICATION_META: ReminderSubjectSettingsMeta = {
  directions: ["after"],
  timingLabel: "Remind after started",
  notifyYouLabel: "You",
  notifyTeamLabel: "Team",
  notifyCounterpartyLabel: "Applicant",
  defaultTemplate: {
    subject: "Finish your PropLane rental application",
    body: [
      "Hi {applicantName},",
      "",
      "You started a rental application for {propertyTitle} on PropLane but have not submitted it yet.",
      "",
      "Sign in with the same email you used when you started, then continue where you left off:",
      "{resumeUrl}",
      "",
      "— PropLane",
    ].join("\n"),
  },
  placeholders: "Placeholders: {applicantName}, {propertyTitle}, {resumeUrl}",
  previewContext: {
    applicantName: "Alex Prospect",
    propertyTitle: "5257 Brooklyn Avenue Northeast",
    resumeUrl: "https://prop-lane.space/resident/applications",
  },
  recipientPreview: "Alex Prospect",
};

const LEASE_META: ReminderSubjectSettingsMeta = {
  directions: ["after"],
  timingLabel: "Remind after sent",
  notifyYouLabel: "You",
  notifyTeamLabel: "Team",
  notifyCounterpartyLabel: "Resident",
  defaultTemplate: {
    subject: "Reminder: sign your lease on PropLane",
    body: [
      "Hi {residentName},",
      "",
      "Your lease for {propertyTitle} is waiting for your signature on PropLane.",
      "",
      "Review and sign here:",
      "{leaseUrl}",
      "",
      "— {managerName}",
    ].join("\n"),
  },
  placeholders: "Placeholders: {residentName}, {propertyTitle}, {leaseUrl}, {managerName}",
  previewContext: {
    residentName: "Jamie Resident",
    propertyTitle: "5257 Brooklyn Avenue Northeast",
    leaseUrl: "https://prop-lane.space/resident/lease",
    managerName: "Your property manager",
  },
  recipientPreview: "Jamie Resident",
};

const TOUR_META: ReminderSubjectSettingsMeta = {
  directions: ["before"],
  timingLabel: "Remind before start",
  notifyYouLabel: "You",
  notifyTeamLabel: "Team",
  notifyCounterpartyLabel: "Guest",
  defaultTemplate: {
    subject: "Tour {duePhrase}: {counterpartyName} at {propertyTitle}",
    body: [
      "Hi {recipientName},",
      "",
      "Reminder: {counterpartyName} has a tour at {propertyTitle} {duePhrase}.",
      "",
      "When: {whenLabel}",
      "",
      "View it in PropLane:",
      "{url}",
      "",
      "— PropLane",
    ].join("\n"),
  },
  placeholders:
    "Placeholders: {recipientName}, {counterpartyName}, {propertyTitle}, {whenLabel}, {duePhrase}, {url}",
  previewContext: {
    recipientName: "Your team",
    counterpartyName: "Alex Prospect",
    propertyTitle: "5257 Brooklyn Avenue Northeast",
    whenLabel: "Sun, Sep 6 at 2:00 PM",
    duePhrase: "in 30 minutes",
    url: "https://prop-lane.space/portal/tours",
  },
  recipientPreview: "Your team",
};

const TASK_META: ReminderSubjectSettingsMeta = {
  directions: ["before", "after"],
  timingLabel: "Remind around due date",
  notifyYouLabel: "You",
  notifyTeamLabel: "Team",
  notifyCounterpartyLabel: "Assignee",
  defaultTemplate: {
    subject: "Task due {duePhrase}: {title}",
    body: [
      "Hi {recipientName},",
      "",
      "Reminder: {title} is due {duePhrase}.",
      "",
      "Due: {whenLabel}",
      "",
      "Open in PropLane:",
      "{url}",
      "",
      "— PropLane",
    ].join("\n"),
  },
  placeholders: "Placeholders: {recipientName}, {title}, {whenLabel}, {duePhrase}, {url}",
  previewContext: {
    recipientName: "Your team",
    title: "Collect September rent",
    whenLabel: "Mon, Sep 8 at 5:00 PM",
    duePhrase: "in 1 day",
    url: "https://prop-lane.space/portal/tasks",
  },
  recipientPreview: "Your team",
};

const SERVICE_ORDER_META: ReminderSubjectSettingsMeta = {
  directions: ["before"],
  timingLabel: "Remind before return date",
  notifyYouLabel: "You",
  notifyTeamLabel: "Team",
  notifyCounterpartyLabel: "Resident",
  defaultTemplate: {
    subject: "Service visit {duePhrase}: {title}",
    body: [
      "Hi {recipientName},",
      "",
      "Reminder: {counterpartyName}'s add-on service ({title}) at {propertyTitle} is scheduled {duePhrase}.",
      "",
      "When: {whenLabel}",
      "",
      "View it in PropLane:",
      "{url}",
      "",
      "— PropLane",
    ].join("\n"),
  },
  placeholders:
    "Placeholders: {recipientName}, {counterpartyName}, {title}, {propertyTitle}, {whenLabel}, {duePhrase}, {url}",
  previewContext: {
    recipientName: "Your team",
    counterpartyName: "Jamie Resident",
    title: "Parking spot",
    propertyTitle: "5257 Brooklyn Avenue Northeast",
    whenLabel: "Wed, Sep 10",
    duePhrase: "in 1 day",
    url: "https://prop-lane.space/portal/services",
  },
  recipientPreview: "Your team",
};

const WORK_ORDER_META: ReminderSubjectSettingsMeta = {
  directions: ["before"],
  timingLabel: "Remind before visit",
  notifyYouLabel: "You",
  notifyTeamLabel: "Team",
  notifyCounterpartyLabel: "Resident",
  defaultTemplate: {
    subject: "Maintenance visit {duePhrase}: {title}",
    body: [
      "Hi {recipientName},",
      "",
      "Reminder: {counterpartyName}'s maintenance visit ({title}) at {propertyTitle} starts {duePhrase}.",
      "",
      "When: {whenLabel}",
      "",
      "View it in PropLane:",
      "{url}",
      "",
      "— PropLane",
    ].join("\n"),
  },
  placeholders:
    "Placeholders: {recipientName}, {counterpartyName}, {title}, {propertyTitle}, {whenLabel}, {duePhrase}, {url}",
  previewContext: {
    recipientName: "Your team",
    counterpartyName: "Jamie Resident",
    title: "Leaky faucet",
    propertyTitle: "5257 Brooklyn Avenue Northeast",
    whenLabel: "Thu, Sep 11 at 10:00 AM",
    duePhrase: "in 30 minutes",
    url: "https://prop-lane.space/portal/services",
  },
  recipientPreview: "Your team",
};

const OUTGOING_PAYMENT_META: ReminderSubjectSettingsMeta = {
  directions: ["before"],
  timingLabel: "Remind before due",
  notifyYouLabel: "You",
  notifyTeamLabel: "Team",
  notifyCounterpartyLabel: "Payee",
  defaultTemplate: {
    subject: "Outgoing payment due {duePhrase}: {paymentTitle}",
    body: [
      "Hi {recipientName},",
      "",
      "Reminder: {paymentTitle} for {propertyTitle} is due {duePhrase}.",
      "",
      "Amount: {amountLabel}",
      "Due: {dueDateLabel}",
      "",
      "View it in PropLane:",
      "{url}",
      "",
      "— PropLane",
    ].join("\n"),
  },
  placeholders:
    "Placeholders: {recipientName}, {paymentTitle}, {propertyTitle}, {amountLabel}, {dueDateLabel}, {duePhrase}, {url}",
  previewContext: {
    recipientName: "Your team",
    paymentTitle: "Property tax installment",
    propertyTitle: "5257 Brooklyn Avenue Northeast",
    amountLabel: "$2,450.00",
    dueDateLabel: "Sep 15, 2026",
    duePhrase: "in 3 days",
    url: "https://prop-lane.space/portal/finances",
  },
  recipientPreview: "Your team",
};

export const REMINDER_SUBJECT_SETTINGS_META: Partial<
  Record<ReminderSubjectKind, ReminderSubjectSettingsMeta>
> = {
  tour: TOUR_META,
  task: TASK_META,
  service_order: SERVICE_ORDER_META,
  work_order: WORK_ORDER_META,
  application: APPLICATION_META,
  lease: LEASE_META,
  outgoing_payment: OUTGOING_PAYMENT_META,
};

export function reminderSubjectSettingsMeta(kind: ReminderSubjectKind): ReminderSubjectSettingsMeta | null {
  return REMINDER_SUBJECT_SETTINGS_META[kind] ?? null;
}

export function fillReminderTemplate(
  template: { subject: string; body: string },
  context: Record<string, string>,
): { subject: string; body: string } {
  const fill = (value: string) =>
    Object.entries(context).reduce((acc, [key, replacement]) => acc.replaceAll(`{${key}}`, replacement), value);
  return { subject: fill(template.subject), body: fill(template.body) };
}

export function defaultTemplateForKind(kind: ReminderSubjectKind): { subject: string; body: string } | null {
  return REMINDER_SUBJECT_SETTINGS_META[kind]?.defaultTemplate ?? null;
}
