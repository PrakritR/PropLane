import type { ReminderSubjectKind } from "@/lib/reminders/rules";
import type { TimingDirection } from "@/lib/reminders/timings";

export type ReminderAudienceMode = "manager" | "counterparty" | "both";

export type ReminderSubjectSettingsMeta = {
  directions: TimingDirection[];
  timingLabel: string;
  notifyYouLabel: string;
  notifyTeamLabel: string;
  notifyCounterpartyLabel: string;
  /** Present only on kinds that can reach the dispatched vendor (`VENDOR_AUDIENCE_KINDS`). */
  notifyVendorLabel?: string;
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

const APPLICATION_MANAGER_META: ReminderSubjectSettingsMeta = {
  directions: ["after"],
  timingLabel: "Remind after started",
  notifyYouLabel: "You",
  notifyTeamLabel: "Team",
  notifyCounterpartyLabel: "Applicant",
  defaultTemplate: {
    subject: "Incomplete application waiting: {propertyTitle}",
    body: [
      "Hi {recipientName},",
      "",
      "{applicantName} started a rental application for {propertyTitle} but has not submitted it yet.",
      "",
      "Open Applications in PropLane to review or follow up:",
      "{url}",
      "",
      "— PropLane",
    ].join("\n"),
  },
  placeholders: "Placeholders: {recipientName}, {applicantName}, {propertyTitle}, {url}",
  previewContext: {
    recipientName: "Your team",
    applicantName: "Alex Prospect",
    propertyTitle: "5257 Brooklyn Avenue Northeast",
    url: "https://prop-lane.space/portal/applications",
  },
  recipientPreview: "Your team",
};

const APPLICATION_POST_TOUR_META: ReminderSubjectSettingsMeta = {
  directions: ["after"],
  timingLabel: "Remind after tour",
  notifyYouLabel: "You",
  notifyTeamLabel: "Team",
  notifyCounterpartyLabel: "Prospect",
  defaultTemplate: {
    subject: "Apply for {propertyTitle} on PropLane",
    body: [
      "Hi {applicantName},",
      "",
      "Thanks for touring {propertyTitle}. If you would like to move forward, start your rental application here:",
      "{applyUrl}",
      "",
      "What happens next:",
      "• Complete the application in PropLane",
      "• Your property manager reviews it",
      "• If approved, you will receive a lease to sign",
      "",
      "— PropLane",
    ].join("\n"),
  },
  placeholders: "Placeholders: {applicantName}, {propertyTitle}, {applyUrl}, {tourTime}",
  previewContext: {
    applicantName: "Alex Prospect",
    propertyTitle: "5257 Brooklyn Avenue Northeast",
    applyUrl: "https://prop-lane.space/rent/apply",
    tourTime: "Aug 15, 2026 at 10:00 AM",
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

const LEASE_MANAGER_META: ReminderSubjectSettingsMeta = {
  directions: ["after"],
  timingLabel: "Remind after sent",
  notifyYouLabel: "You",
  notifyTeamLabel: "Team",
  notifyCounterpartyLabel: "Resident",
  defaultTemplate: {
    subject: "Lease needs attention: {propertyTitle}",
    body: [
      "Hi {recipientName},",
      "",
      "The lease for {propertyTitle} with {residentName} still needs your attention.",
      "",
      "Open the lease pipeline in PropLane:",
      "{url}",
      "",
      "— PropLane",
    ].join("\n"),
  },
  placeholders: "Placeholders: {recipientName}, {residentName}, {propertyTitle}, {url}",
  previewContext: {
    recipientName: "Your team",
    residentName: "Jamie Resident",
    propertyTitle: "5257 Brooklyn Avenue Northeast",
    url: "https://prop-lane.space/portal/leases",
  },
  recipientPreview: "Your team",
};

const PAYMENT_MANAGER_META: ReminderSubjectSettingsMeta = {
  directions: ["after"],
  timingLabel: "Remind after due",
  notifyYouLabel: "You",
  notifyTeamLabel: "Team",
  notifyCounterpartyLabel: "Resident",
  defaultTemplate: {
    subject: "Unpaid rent {duePhrase}: {chargeTitle}",
    body: [
      "Hi {recipientName},",
      "",
      "{residentName} still owes {chargeTitle} for {propertyTitle} {duePhrase}.",
      "",
      "Amount due: {amountLabel}",
      "Due: {dueDateLabel}",
      "",
      "Open Payments in PropLane:",
      "{url}",
      "",
      "— PropLane",
    ].join("\n"),
  },
  placeholders:
    "Placeholders: {recipientName}, {residentName}, {chargeTitle}, {propertyTitle}, {amountLabel}, {dueDateLabel}, {duePhrase}, {url}",
  previewContext: {
    recipientName: "Your team",
    residentName: "Alex Resident",
    chargeTitle: "April rent",
    propertyTitle: "5257 Brooklyn Avenue Northeast",
    amountLabel: "$1,200.00",
    dueDateLabel: "Apr 15, 2026",
    duePhrase: "1 day past due",
    url: "https://prop-lane.space/portal/payments",
  },
  recipientPreview: "Your team",
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
      "Reminder: {counterpartyName}'s service ({title}) at {propertyTitle} is scheduled {duePhrase}.",
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
  notifyVendorLabel: "Vendor",
  defaultTemplate: {
    subject: "Service visit {duePhrase}: {title}",
    body: [
      "Hi {recipientName},",
      "",
      "Reminder: {counterpartyName}'s service visit ({title}) at {propertyTitle} starts {duePhrase}.",
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

const BOOKING_META: ReminderSubjectSettingsMeta = {
  directions: ["before"],
  timingLabel: "Remind before check-in",
  notifyYouLabel: "You",
  notifyTeamLabel: "Team",
  // There is no counterparty control on this subject — an imported channel
  // booking carries no guest contact — but the label is here so the shared
  // panel has something to render if a guest-reachable source is ever added.
  notifyCounterpartyLabel: "Guest",
  defaultTemplate: {
    subject: "Check-in {duePhrase}: {counterpartyName} at {propertyTitle}",
    body: [
      "Hi {recipientName},",
      "",
      "Reminder: {counterpartyName} checks in to {propertyTitle} {duePhrase}.",
      "",
      "Stay: {whenLabel}",
      "",
      "See the booking in PropLane:",
      "{url}",
      "",
      "— PropLane",
    ].join("\n"),
  },
  placeholders:
    "Placeholders: {recipientName}, {counterpartyName}, {propertyTitle}, {whenLabel}, {duePhrase}, {url}",
  previewContext: {
    recipientName: "Your team",
    counterpartyName: "Airbnb guest",
    propertyTitle: "Ash Flats 6 · Room B",
    whenLabel: "Fri, Sep 18 \u2013 Tue, Sep 22",
    duePhrase: "in 1 day",
    url: "https://prop-lane.space/portal/bookings/upcoming",
  },
  recipientPreview: "Your team",
};


/**
 * Compact meta for the PLAN-0915 kinds. Each is one Settings row (toggle +
 * one timing) with an editable template; the placeholder set is the shared
 * reminder context, so `{recipientName}`, `{title}`, `{propertyTitle}`,
 * `{counterpartyName}`, `{whenLabel}`, `{duePhrase}`, `{amountLabel}`,
 * `{dueDateLabel}` and `{url}` work on every one of them.
 */
type CompactMetaInput = {
  directions: TimingDirection[];
  timingLabel: string;
  counterparty: string;
  subject: string;
  body: string[];
  preview?: Record<string, string>;
  recipientPreview?: string;
};

const SHARED_PLACEHOLDERS =
  "Placeholders: {recipientName}, {title}, {propertyTitle}, {counterpartyName}, {whenLabel}, {duePhrase}, {amountLabel}, {dueDateLabel}, {url}";

function compactMeta(input: CompactMetaInput): ReminderSubjectSettingsMeta {
  return {
    directions: input.directions,
    timingLabel: input.timingLabel,
    notifyYouLabel: "You",
    notifyTeamLabel: "Team",
    notifyCounterpartyLabel: input.counterparty,
    defaultTemplate: { subject: input.subject, body: ["Hi {recipientName},", "", ...input.body, "", "— PropLane"].join("\n") },
    placeholders: SHARED_PLACEHOLDERS,
    previewContext: {
      recipientName: input.recipientPreview ?? "Alex Resident",
      title: "Leaking faucet",
      propertyTitle: "5257 Brooklyn Avenue Northeast",
      counterpartyName: "Alex Resident",
      whenLabel: "Thu, Sep 18 at 10:00 AM",
      duePhrase: "in 1 day",
      amountLabel: "$180.00",
      dueDateLabel: "Sep 18, 2026",
      url: "https://prop-lane.space/portal",
      ...(input.preview ?? {}),
    },
    recipientPreview: input.recipientPreview ?? "Alex Resident",
  };
}

const PLAN_0915_META: Partial<Record<ReminderSubjectKind, ReminderSubjectSettingsMeta>> = {
  // ---- Services ----
  work_order_unassigned: compactMeta({ directions: ["after"], timingLabel: "Escalate after filed", counterparty: "Resident", recipientPreview: "Your team",
    subject: "Still unassigned: {title}", body: ["“{title}” at {propertyTitle} was filed {duePhrase} and nobody is on it yet.", "", "Assign it: {url}"] }),
  work_order_unassigned_emergency: compactMeta({ directions: ["after"], timingLabel: "Escalate after filed", counterparty: "Resident", recipientPreview: "Your team",
    subject: "EMERGENCY still unassigned: {title}", body: ["Emergency “{title}” at {propertyTitle} was filed {duePhrase} and nobody is on it.", "", "Assign it now: {url}"] }),
  work_order_no_on_my_way: compactMeta({ directions: ["after"], timingLabel: "Tell me after the visit window opens", counterparty: "Vendor", recipientPreview: "Your team",
    subject: "No “On my way” for {title}", body: ["{counterpartyName} has not tapped On my way for the {whenLabel} visit for “{title}” at {propertyTitle}.", "", "Check in: {url}"] }),
  vendor_offer_expiry: compactMeta({ directions: ["before"], timingLabel: "Nudge before the offer expires", counterparty: "Vendor", recipientPreview: "Juniper Services",
    subject: "Your offer for {title} expires {duePhrase}", body: ["Your offer for “{title}” at {propertyTitle} expires {whenLabel}.", "", "Accept or decline it: {url}"], preview: { url: "https://prop-lane.space/vendor/work-orders" } }),
  vendor_invoice_nudge: compactMeta({ directions: ["after"], timingLabel: "Nudge after marked done", counterparty: "Vendor", recipientPreview: "Juniper Services",
    subject: "Invoice for {title}?", body: ["You marked “{title}” at {propertyTitle} done {duePhrase}. Submit your invoice when you are ready.", "", "{url}"], preview: { url: "https://prop-lane.space/vendor/financials/invoices" } }),
  invoice_approval: compactMeta({ directions: ["after"], timingLabel: "Remind after the invoice arrives", counterparty: "Vendor", recipientPreview: "Your team",
    subject: "Invoice waiting: {title}", body: ["{counterpartyName}’s {amountLabel} invoice arrived {duePhrase} and has not been decided.", "", "Review it: {url}"], preview: { counterpartyName: "Juniper Services", title: "Juniper Services’s $180.00 invoice", url: "https://prop-lane.space/portal/finances" } }),
  service_request_decision: compactMeta({ directions: ["after"], timingLabel: "Remind after submitted", counterparty: "Resident", recipientPreview: "Your team",
    subject: "Add-on request waiting: {title}", body: ["{counterpartyName}’s request for “{title}” has waited {duePhrase}.", "", "Decide: {url}"], preview: { title: "Parking", url: "https://prop-lane.space/portal/services/requests" } }),
  service_request_unpaid: compactMeta({ directions: ["after"], timingLabel: "Remind after approved", counterparty: "Resident",
    subject: "Pay to activate {title}", body: ["“{title}” is approved — pay {amountLabel} to activate it.", "", "{url}"], preview: { title: "Parking", amountLabel: "$75.00", url: "https://prop-lane.space/resident/payments" } }),
  vendor_document_expiry: compactMeta({ directions: ["before"], timingLabel: "Warn before it expires", counterparty: "Vendor", recipientPreview: "Juniper Services",
    subject: "{title} expires {duePhrase}", body: ["The {title} on file for {counterpartyName} expires {whenLabel}. Upload a new one to stay eligible for offers.", "", "{url}"], preview: { title: "Certificate of insurance", counterpartyName: "Juniper Services", whenLabel: "Oct 12, 2026", duePhrase: "in 30 days", url: "https://prop-lane.space/vendor/documents/all" } }),
  // ---- Leases, move-in, move-out ----
  lease_ending: compactMeta({ directions: ["before"], timingLabel: "Tell the resident before the end", counterparty: "Resident",
    subject: "Your lease at {propertyTitle} ends {dueDateLabel}", body: ["Your lease at {propertyTitle} ends on {dueDateLabel} ({duePhrase}). Your property manager will be in touch about renewal or next steps — you can also reply here with questions."], preview: { dueDateLabel: "Nov 30, 2026", duePhrase: "in 60 days" } }),
  lease_ending_manager: compactMeta({ directions: ["before"], timingLabel: "Remind me before the end", counterparty: "Resident", recipientPreview: "Your team",
    subject: "{counterpartyName}’s lease ends {duePhrase}", body: ["{counterpartyName}’s lease at {propertyTitle} ends on {dueDateLabel}. Renew, go month-to-month, or give notice.", "", "{url}"], preview: { dueDateLabel: "Nov 30, 2026", duePhrase: "in 90 days", url: "https://prop-lane.space/portal/leases" } }),
  renewal_offer_expiry: compactMeta({ directions: ["before"], timingLabel: "Remind before the offer expires", counterparty: "Resident",
    subject: "Your renewal offer expires {duePhrase}", body: ["Your renewal offer for {propertyTitle} expires on {dueDateLabel}. Accept or decline it here:", "{url}"], preview: { dueDateLabel: "Nov 15, 2026", duePhrase: "in 3 days", url: "https://prop-lane.space/resident/lease" } }),
  countersign_overdue: compactMeta({ directions: ["after"], timingLabel: "Remind after the resident signed", counterparty: "Resident", recipientPreview: "Your team",
    subject: "{counterpartyName}’s lease is waiting on your signature", body: ["{counterpartyName} signed the lease for {propertyTitle} {duePhrase}. It is waiting on your countersignature.", "", "{url}"], preview: { duePhrase: "2 days ago", url: "https://prop-lane.space/portal/leases" } }),
  move_in: compactMeta({ directions: ["before"], timingLabel: "Remind before move-in", counterparty: "Resident",
    subject: "Moving in {dueDateLabel} — your checklist", body: ["You move into {propertyTitle} on {dueDateLabel} ({duePhrase}).", "• Keys and arrival time", "• Utilities in your name from move-in day", "• Renters insurance on file", "• First payment due on move-in", "", "House info: {url}"], preview: { dueDateLabel: "Sat, Dec 1", duePhrase: "in 7 days", url: "https://prop-lane.space/resident/my-home" } }),
  move_in_payment_method: compactMeta({ directions: ["before"], timingLabel: "Remind before the first payment is due", counterparty: "Resident",
    subject: "Add a payment method before {dueDateLabel}", body: ["Your first payment of {amountLabel} is due {dueDateLabel} and there is no payment method on file yet.", "", "Add one: {url}"], preview: { amountLabel: "$1,850.00", dueDateLabel: "Dec 1, 2026", url: "https://prop-lane.space/resident/payments" } }),
  move_out: compactMeta({ directions: ["before"], timingLabel: "Remind before move-out", counterparty: "Resident",
    subject: "Moving out {dueDateLabel} — checklist", body: ["Your move-out date is {dueDateLabel} ({duePhrase}).", "• Return all keys", "• Leave the room clean and empty", "• Give us a forwarding address for your deposit statement", "• Move-out inspection time will be confirmed", "", "{url}"], preview: { dueDateLabel: "Nov 30, 2026", duePhrase: "in 7 days", url: "https://prop-lane.space/resident/lease" } }),
  move_out_inspection_manager: compactMeta({ directions: ["before"], timingLabel: "Remind me before move-out", counterparty: "Resident", recipientPreview: "Your team",
    subject: "Schedule {counterpartyName}’s move-out inspection", body: ["{counterpartyName} moves out of {propertyTitle} on {dueDateLabel}. Schedule the move-out inspection.", "", "{url}"], preview: { dueDateLabel: "Nov 30, 2026", url: "https://prop-lane.space/portal/inspections" } }),
  deposit_accounting: compactMeta({ directions: ["before"], timingLabel: "Remind me before the deadline", counterparty: "Resident", recipientPreview: "Your team",
    subject: "{counterpartyName}’s deposit accounting is due {duePhrase}", body: ["The deposit accounting for {counterpartyName} ({propertyTitle}) is due on {dueDateLabel}.", "", "Prepare it: {url}"], preview: { dueDateLabel: "Dec 21, 2026", duePhrase: "in 14 days", url: "https://prop-lane.space/portal/payments" } }),
  // Lease-ending sequence (PLAN-0915 area 4). Informational — never a
  // regulated notice: no statute citation, no accounting figure, just what is
  // coming and where to go for it.
  lease_renewal_offer: compactMeta({ directions: ["before"], timingLabel: "Send before the lease ends", counterparty: "Resident",
    subject: "Renew your lease at {propertyTitle}?", body: ["Your lease at {propertyTitle} ends on {dueDateLabel} ({duePhrase}). If you would like to stay, let your property manager know — they can send a renewal offer.", "", "{url}"], preview: { dueDateLabel: "Nov 30, 2026", duePhrase: "in 60 days" } }),
  move_out_instructions: compactMeta({ directions: ["before"], timingLabel: "Send before move-out", counterparty: "Resident",
    subject: "Moving out {dueDateLabel} — what to do", body: ["Your move-out date is {dueDateLabel} ({duePhrase}).", "• Return all keys", "• Leave the room clean and empty", "• Give us a forwarding address", "", "{url}"], preview: { dueDateLabel: "Nov 30, 2026", duePhrase: "in 14 days", url: "https://prop-lane.space/resident/lease" } }),
  deposit_return_notice: compactMeta({ directions: ["before"], timingLabel: "Send on move-out day", counterparty: "Resident",
    subject: "Your deposit is being processed", body: ["Today is your move-out date at {propertyTitle}. Your security deposit accounting will follow once the move-out inspection is complete.", "", "{url}"], preview: { url: "https://prop-lane.space/resident/payments" } }),
  // ---- Applications ----
  application_documents: compactMeta({ directions: ["after"], timingLabel: "Remind after requested", counterparty: "Applicant", recipientPreview: "Alex Prospect",
    subject: "Documents still needed for {propertyTitle}", body: ["Your property manager asked for {title} {duePhrase} and has not received it yet.", "", "Upload: {url}"], preview: { title: "pay stubs (last 2)", duePhrase: "2 days ago", url: "https://prop-lane.space/resident/applications" } }),
  application_decision_manager: compactMeta({ directions: ["after"], timingLabel: "Remind after submitted", counterparty: "Applicant", recipientPreview: "Your team",
    subject: "Decision waiting: {counterpartyName}", body: ["{counterpartyName}’s application for {propertyTitle} was submitted {duePhrase} and has no decision.", "", "{url}"], preview: { counterpartyName: "Alex Prospect", duePhrase: "3 days ago", url: "https://prop-lane.space/portal/applications" } }),
  application_no_lease_manager: compactMeta({ directions: ["after"], timingLabel: "Remind after approval", counterparty: "Applicant", recipientPreview: "Your team",
    subject: "{counterpartyName} is approved but has no lease", body: ["You approved {counterpartyName} for {propertyTitle} {duePhrase}; no lease has been sent.", "", "Create one: {url}"], preview: { counterpartyName: "Alex Prospect", duePhrase: "2 days ago", url: "https://prop-lane.space/portal/leases" } }),
  cosigner: compactMeta({ directions: ["after"], timingLabel: "Remind after invited", counterparty: "Cosigner", recipientPreview: "Jordan Cosigner",
    subject: "Cosigner form for {counterpartyName}", body: ["{counterpartyName} listed you as a cosigner for {propertyTitle} {duePhrase}. The form has not been completed yet.", "", "{url}"], preview: { counterpartyName: "Alex Prospect", duePhrase: "2 days ago", url: "https://prop-lane.space/cosign" } }),
  group_application: compactMeta({ directions: ["after"], timingLabel: "Remind after the first member applied", counterparty: "Applicant", recipientPreview: "Sam Roommate",
    subject: "Add your application for {propertyTitle}", body: ["{counterpartyName} applied to {propertyTitle} as a group {duePhrase}. Your own application is still missing.", "", "Apply: {url}"], preview: { counterpartyName: "Alex Prospect", duePhrase: "2 days ago", url: "https://prop-lane.space/apply" } }),
  // ---- Tours ----
  tour_request_unanswered: compactMeta({ directions: ["after"], timingLabel: "Remind after the request", counterparty: "Guest", recipientPreview: "Your team",
    subject: "Tour request waiting: {counterpartyName}", body: ["{counterpartyName} asked for a tour of {propertyTitle} on {whenLabel}, {duePhrase}. Confirm or propose another time.", "", "{url}"], preview: { counterpartyName: "Alex Prospect", duePhrase: "4 hours ago", url: "https://prop-lane.space/portal/tours" } }),
  tour_request_reoffer: compactMeta({ directions: ["after"], timingLabel: "Offer other times after", counterparty: "Guest", recipientPreview: "Alex Prospect",
    subject: "Pick another time to tour {propertyTitle}", body: ["We could not confirm {whenLabel} yet. Pick another time that works:", "{url}"], preview: { url: "https://prop-lane.space/tour" } }),
  tour_no_show_manager: compactMeta({ directions: ["after"], timingLabel: "Ask me after the tour ended", counterparty: "Guest", recipientPreview: "Your team",
    subject: "Did {counterpartyName} tour {propertyTitle}?", body: ["{counterpartyName}’s tour of {propertyTitle} was at {whenLabel}. Mark it toured or a no-show.", "", "{url}"], preview: { counterpartyName: "Alex Prospect", url: "https://prop-lane.space/portal/tours" } }),
  tour_feedback: compactMeta({ directions: ["after"], timingLabel: "Ask after the tour", counterparty: "Guest", recipientPreview: "Alex Prospect",
    subject: "How was your tour of {propertyTitle}?", body: ["Thanks for touring {propertyTitle} today. A quick rating helps us:", "{url}"], preview: { url: "https://prop-lane.space/tour/feedback" } }),
  // ---- Payments, communication, documents, tasks, residents, inspections ----
  delinquency_manager: compactMeta({ directions: ["after"], timingLabel: "Remind after due", counterparty: "Resident", recipientPreview: "Your team",
    subject: "{counterpartyName} is {duePhrase} late", body: ["{counterpartyName}’s {title} of {amountLabel} at {propertyTitle} is {duePhrase} past due.", "", "Review and send a notice if needed: {url}"], preview: { title: "December rent", amountLabel: "$1,900.00", duePhrase: "10 days", url: "https://prop-lane.space/portal/payments" } }),
  message_unanswered: compactMeta({ directions: ["after"], timingLabel: "Remind after the message", counterparty: "Resident", recipientPreview: "Your team",
    subject: "Unanswered: {counterpartyName}", body: ["{counterpartyName} wrote {duePhrase} and has not had a reply: “{title}”", "", "Reply: {url}"], preview: { title: "Is the dryer supposed to make that noise?", duePhrase: "1 day ago", url: "https://prop-lane.space/portal/communication" } }),
  document_signature: compactMeta({ directions: ["after"], timingLabel: "Remind after requested", counterparty: "Signer",
    subject: "“{title}” is waiting for your signature", body: ["Your property manager asked you to sign “{title}” {duePhrase}.", "", "Sign it: {url}"], preview: { title: "Pet addendum", duePhrase: "3 days ago", url: "https://prop-lane.space/resident/documents" } }),
  task_overdue: compactMeta({ directions: ["after"], timingLabel: "Remind after due", counterparty: "Assignee", recipientPreview: "Jordan Team",
    subject: "Overdue: {title}", body: ["“{title}” was due {dueDateLabel} and is {duePhrase} overdue.", "", "{url}"], preview: { title: "Replace hallway bulb", dueDateLabel: "Sep 17, 2026", duePhrase: "1 day", url: "https://prop-lane.space/portal/tasks" } }),
  resident_welcome: compactMeta({ directions: ["after"], timingLabel: "Send after the account is created", counterparty: "Resident",
    subject: "Welcome to PropLane", body: ["Welcome to {propertyTitle}. Set up your account, add a payment method, and request service any time from Services.", "", "{url}"], preview: { url: "https://prop-lane.space/resident/dashboard" } }),
  inspection_acknowledge: compactMeta({ directions: ["after"], timingLabel: "Remind after the report is shared", counterparty: "Resident",
    subject: "Review your inspection report", body: ["Your {title} for {propertyTitle} was shared {duePhrase} and is waiting for your acknowledgement.", "", "{url}"], preview: { title: "move-in report", duePhrase: "5 days ago", url: "https://prop-lane.space/resident/inspections" } }),
};

export const REMINDER_SUBJECT_SETTINGS_META: Partial<
  Record<ReminderSubjectKind, ReminderSubjectSettingsMeta>
> = {
  ...PLAN_0915_META,
  tour: TOUR_META,
  tour_interest: { ...TOUR_META, directions: ["after"], timingLabel: "24 hours after your tour response",
    defaultTemplate: { subject: "Still interested in a tour?", body: "Hi, are you still interested in a tour? Reply and we can find a time that works for you." } },
  task: TASK_META,
  service_order: SERVICE_ORDER_META,
  work_order: WORK_ORDER_META,
  application: APPLICATION_META,
  application_manager: APPLICATION_MANAGER_META,
  application_post_tour: APPLICATION_POST_TOUR_META,
  lease: LEASE_META,
  lease_manager: LEASE_MANAGER_META,
  payment_manager: PAYMENT_MANAGER_META,
  outgoing_payment: OUTGOING_PAYMENT_META,
  booking: BOOKING_META,
  inspection: { ...BOOKING_META, directions: ["before", "after"], timingLabel: "Remind around the move date", notifyCounterpartyLabel: "Resident", recipientPreview: "Resident",
    defaultTemplate: { subject: "Add your room photos", body: "Hi {recipientName},\n\nTake a few photos of your room so the condition on the day is on the record. It takes about two minutes, and it is what protects your deposit later.\n\n{url}" } },
  inspection_manager: { ...BOOKING_META, directions: ["before", "after"], timingLabel: "Remind around the move date", notifyCounterpartyLabel: "Resident",
    defaultTemplate: { subject: "No room photos yet", body: "Hi {recipientName},\n\nThis room has no move-in or move-out photos from either side yet. Open PropLane to add them, or nudge the resident.\n\n{url}" } },
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
