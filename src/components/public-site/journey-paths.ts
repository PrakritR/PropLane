/**
 * The prospect journey after a text: browse, a listing, a tour, applying, and the phone-bound doors
 * (`/l/<token>`, `/apply/<code>`, `/tour/<code>`, `/start/<token>`). These pages wear the approved
 * homepage look (`public-site.css`) and its top bar and footer instead of the older public chrome.
 */
const JOURNEY_PREFIXES = ["/rent", "/l/", "/apply/", "/tour/", "/start/"] as const;

export function isJourneyPath(pathname: string | null | undefined): boolean {
  const path = pathname ?? "";
  return JOURNEY_PREFIXES.some((prefix) =>
    prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix || path.startsWith(`${prefix}/`),
  );
}

/** Home anchors the top bar points at (the single-page homepage, spec v2). */
export const SITE_NAV_LINKS = [
  { label: "How it works", href: "/#how" },
  { label: "Service", href: "/#service" },
  { label: "Pricing", href: "/#pricing" },
  { label: "Contact", href: "/#contact" },
] as const;

export const SITE_PORTAL_HREF = "/auth/sign-in";

/** What a renter's "Text us" opens with. Same shape as `publicTextingConfig`'s smsHref. */
export const RENTER_SMS_BODY = "Hi PropLane, I'm looking for a room";

export function renterSmsHref(phone: string | null | undefined, body: string = RENTER_SMS_BODY): string | null {
  const number = String(phone ?? "").trim();
  return number ? `sms:${number}?&body=${encodeURIComponent(body)}` : null;
}
