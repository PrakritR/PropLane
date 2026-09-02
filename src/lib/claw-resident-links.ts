/**
 * Canonical deep links for resident SMS / iMessage (payment, lease, move-in, …).
 * Always phone-reachable — never localhost.
 */

import { PRODUCTION_APP_ORIGIN } from "@/lib/app-url";

export type ResidentSmsLinkKind =
  | "payments"
  | "lease"
  | "move_in"
  | "inbox"
  | "services"
  | "services_work_orders"
  | "applications"
  | "login"
  | "signup"
  | "browse"
  | "apply";

/** Canonical origin for links embedded in resident-facing agent SMS. */
export function residentSmsLinkOrigin(): string {
  return PRODUCTION_APP_ORIGIN;
}

export function residentPortalPath(
  kind: ResidentSmsLinkKind,
  opts?: { propertyId?: string | null; bundleId?: string | null },
): string {
  switch (kind) {
    case "payments":
      return "/resident/payments/pending";
    case "lease":
      return "/resident/lease";
    case "move_in":
      return "/resident/move-in";
    case "inbox":
      return "/resident/communication/email/unopened";
    case "services":
    case "services_work_orders":
      return "/resident/services";
    case "applications":
      return "/resident/applications";
    case "login":
      // `/auth/sign-in` is the real route; `/auth/login` 404s. Every resident
      // onboarding email and SMS routes through here, so a wrong token here is a
      // dead end for the recipient of a lease, a charge, or a welcome message.
      return "/auth/sign-in";
    case "signup":
      return "/auth/resident-setup";
    case "browse":
      return "/rent/browse";
    case "apply": {
      const q = new URLSearchParams();
      const pid = opts?.propertyId?.trim();
      const bid = opts?.bundleId?.trim();
      if (pid) q.set("propertyId", pid);
      if (bid) q.set("bundle", bid);
      const qs = q.toString();
      return qs ? `/rent/apply?${qs}` : "/rent/apply";
    }
    default:
      return "/resident/communication/email/unopened";
  }
}

export function residentPortalUrl(
  kind: ResidentSmsLinkKind,
  opts?: { propertyId?: string | null; bundleId?: string | null },
): string {
  return `${residentSmsLinkOrigin()}${residentPortalPath(kind, opts)}`;
}

export type ManagerPortalLinkKind =
  | "properties"
  | "calendar"
  | "applications"
  | "leases"
  | "residents"
  | "payments"
  | "services_work_orders"
  | "services_requests"
  | "inbox"
  | "relationships"
  | "promotion";

export function managerPortalPath(kind: ManagerPortalLinkKind): string {
  switch (kind) {
    case "properties":
      return "/portal/properties";
    case "calendar":
      return "/portal/calendar";
    case "applications":
      return "/portal/applications";
    case "leases":
      return "/portal/leases";
    case "residents":
      return "/portal/residents";
    case "payments":
      return "/portal/payments";
    case "services_work_orders":
      return "/portal/services/work-orders";
    case "services_requests":
      return "/portal/services/requests";
    case "inbox":
      return "/portal/communication/inbox/unopened";
    case "relationships":
      return "/portal/teams/managers";
    case "promotion":
      return "/portal/promotion";
    default:
      return "/portal/communication/inbox/unopened";
  }
}

export function managerPortalUrl(kind: ManagerPortalLinkKind): string {
  return `${residentSmsLinkOrigin()}${managerPortalPath(kind)}`;
}

export function managerPortalUrlFromPath(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${residentSmsLinkOrigin()}${p}`;
}

export function smsLinkKindForThreadTopic(
  topic:
    | "payment"
    | "lease"
    | "leasing"
    | "move_in"
    | "general"
    | "applications"
    | "maintenance"
    | "services",
): ResidentSmsLinkKind {
  switch (topic) {
    case "payment":
      return "payments";
    case "lease":
      return "lease";
    case "move_in":
      return "move_in";
    case "leasing":
      return "browse";
    case "applications":
      return "applications";
    case "maintenance":
      return "services_work_orders";
    case "services":
      return "services";
    default:
      return "inbox";
  }
}

const LINK_LABEL: Record<ResidentSmsLinkKind, string> = {
  payments: "Pay / view charges",
  lease: "Sign / view lease",
  move_in: "House details",
  inbox: "Open inbox",
  services: "Services",
  services_work_orders: "Services",
  applications: "Applications",
  login: "Sign in",
  signup: "Create account",
  browse: "Browse homes",
  apply: "Apply",
};

/**
 * Appends a labeled portal link when the body does not already contain an http(s) URL.
 */
export function ensureSmsIncludesPortalLink(
  body: string,
  kind: ResidentSmsLinkKind,
  opts?: { propertyId?: string | null; bundleId?: string | null; label?: string },
): string {
  const text = body.trim();
  if (!text) return text;
  if (/https?:\/\//i.test(text)) return text;
  const url = residentPortalUrl(kind, opts);
  const label = (opts?.label ?? LINK_LABEL[kind]).trim() || LINK_LABEL[kind];
  return `${text}\n\n${label}: ${url}`;
}

/** Multi-line default SMS footer links (welcome / onboarding). */
export function defaultResidentOnboardingSmsLinks(): string[] {
  return [
    `Sign in: ${residentPortalUrl("login")}`,
    `Payments: ${residentPortalUrl("payments")}`,
    `Lease: ${residentPortalUrl("lease")}`,
  ];
}
