/**
 * Client-safe resident SMS intent classifier for the PropLane command hub.
 */

import { looksLikeMaintenanceRequest } from "@/lib/claw-maintenance-detect";

export { residentGreetingText, residentHelpMenuText } from "@/lib/claw-resident-tone";

export type ResidentSmsIntent =
  | "maintenance"
  | "service_request"
  | "balance"
  | "pay"
  | "i_paid"
  | "lease"
  | "applications"
  | "move_in"
  | "inbox"
  | "help"
  | "greeting"
  | "unknown";

export type ResidentSmsDomain =
  | "Services"
  | "Payments"
  | "Leases"
  | "Applications"
  | "Move-in"
  | "Inbox"
  | "Properties"
  | "Calendar"
  | "Residents"
  | "Team"
  | "Promotions";

export type ClassifiedResidentSms = {
  intent: ResidentSmsIntent;
  domain: ResidentSmsDomain;
  wantsLabel: string;
  /** Manager portal path for the brief "Open:" line. */
  managerPath: string;
  /** Skip manager SMS noise for pure help/greeting. */
  skipManagerBrief: boolean;
};

const SERVICE_REQUEST_RE =
  /\b(parking|reserved parking|amenity|amenities|cleaning service|housekeeping|pet (fee|deposit)|storage (unit|space)|furniture|custom (service )?request|request (parking|cleaning|storage)|book (a )?(cleaning|parking))\b/i;

const I_PAID_RE =
  /\b(i (just )?paid|i('ve| have) paid|we (just )?paid|paid (via|with|through|using)|sent (it |the money |payment |the rent )?(over|already)|(i|we)('ve| have| just)? sent (it|the rent|the money|payment))\b/i;

const BALANCE_RE =
  /\b(how much|what do i owe|balance|owing|overdue|what('s| is) due|rent due|outstanding|what i owe)\b/i;

const PAY_RE =
  /\b(pay rent|make a payment|pay (my |the )?rent|want to pay|pay now|payment link|where (do|can) i pay)\b/i;

const LEASE_RE =
  /\b(lease|sign(ing)? (my )?lease|e-?sign|renewal|renew (my )?lease|where('s| is) my lease|lease document)\b/i;

const APPLICATIONS_RE =
  /\b(application status|my application|did you (get|receive) my app|apply|rental app|submit (an )?app)\b/i;

const MOVE_IN_RE =
  /\b(move[-\s]?in|keys|key pickup|getting keys|moving in|move in date)\b/i;

const INBOX_RE =
  /\b(message (my )?manager|talk to (my )?manager|inbox|reply to manager)\b/i;

/** Standalone keywords residents text from the help menu. */
const RENT_KEYWORD_RE = /^(rent|rent due)$/i;
const MAINTENANCE_KEYWORD_RE = /^(maintenance|work[\s-]?order|repair|fix something)$/i;

/**
 * Classify a known resident's inbound SMS.
 * Order matters: maintenance before amenity requests; i_paid before generic pay.
 */
export function classifyResidentSmsIntent(text: string): ClassifiedResidentSms {
  const t = text.trim();
  const lower = t.toLowerCase();

  if (!t) {
    return {
      intent: "unknown",
      domain: "Inbox",
      wantsLabel: "manager attention / reply",
      managerPath: "/portal/communication/inbox/unopened",
      skipManagerBrief: false,
    };
  }

  if (/^(hi|hello|hey|yo)[\s!.?,]*$/i.test(t) || lower === "start") {
    return {
      intent: "greeting",
      domain: "Inbox",
      wantsLabel: "opened chat",
      managerPath: "/portal/communication/inbox/unopened",
      skipManagerBrief: true,
    };
  }

  if (/^(help|menu|options)[\s!.?,]*$/i.test(t) || lower === "info") {
    return {
      intent: "help",
      domain: "Inbox",
      wantsLabel: "help menu",
      managerPath: "/portal/communication/inbox/unopened",
      skipManagerBrief: true,
    };
  }

  if (RENT_KEYWORD_RE.test(t)) {
    return {
      intent: "pay",
      domain: "Payments",
      wantsLabel: "pay rent / open payment link",
      managerPath: "/portal/payments",
      skipManagerBrief: false,
    };
  }

  if (MAINTENANCE_KEYWORD_RE.test(t)) {
    return {
      intent: "maintenance",
      domain: "Services",
      wantsLabel: "file a maintenance work order",
      managerPath: "/portal/services/work-orders",
      skipManagerBrief: false,
    };
  }

  if (looksLikeMaintenanceRequest(t)) {
    return {
      intent: "maintenance",
      domain: "Services",
      wantsLabel: "file a maintenance work order",
      managerPath: "/portal/services/work-orders",
      skipManagerBrief: false,
    };
  }

  if (SERVICE_REQUEST_RE.test(t)) {
    return {
      intent: "service_request",
      domain: "Services",
      wantsLabel: "submit an add-on service request",
      managerPath: "/portal/services/requests",
      skipManagerBrief: false,
    };
  }

  if (I_PAID_RE.test(t)) {
    return {
      intent: "i_paid",
      domain: "Payments",
      wantsLabel: "says they paid (pointed at PropLane payments)",
      managerPath: "/portal/payments",
      skipManagerBrief: false,
    };
  }

  if (BALANCE_RE.test(t)) {
    return {
      intent: "balance",
      domain: "Payments",
      wantsLabel: "see balance / amounts owed",
      managerPath: "/portal/payments",
      skipManagerBrief: false,
    };
  }

  if (PAY_RE.test(t) || lower === "pay" || lower === "balance") {
    return {
      intent: lower === "balance" ? "balance" : "pay",
      domain: "Payments",
      wantsLabel: "pay rent / open payment link",
      managerPath: "/portal/payments",
      skipManagerBrief: false,
    };
  }

  if (LEASE_RE.test(t) || lower === "lease") {
    return {
      intent: "lease",
      domain: "Leases",
      wantsLabel: "view or sign lease",
      managerPath: "/portal/leases",
      skipManagerBrief: false,
    };
  }

  if (APPLICATIONS_RE.test(t) || lower === "apply") {
    return {
      intent: "applications",
      domain: "Applications",
      wantsLabel: "application status or apply",
      managerPath: "/portal/applications",
      skipManagerBrief: false,
    };
  }

  if (MOVE_IN_RE.test(t) || lower === "move-in" || lower === "movein") {
    return {
      intent: "move_in",
      domain: "Move-in",
      wantsLabel: "move-in details / keys",
      managerPath: "/portal/residents",
      skipManagerBrief: false,
    };
  }

  if (INBOX_RE.test(t)) {
    return {
      intent: "inbox",
      domain: "Inbox",
      wantsLabel: "message the manager",
      managerPath: "/portal/communication/inbox/unopened",
      skipManagerBrief: false,
    };
  }

  return {
    intent: "unknown",
    domain: "Inbox",
    wantsLabel: "manager attention / reply",
    managerPath: "/portal/communication/inbox/unopened",
    skipManagerBrief: false,
  };
}
