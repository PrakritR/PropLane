/**
 * Public marketing contact — single source for footer, contact, support, legal.
 * Support mail is the PropLane brand domain (support@prop-lane.space); its
 * forwarding to the founder inbox is handled outside the product. Brand copy is
 * PropLane; the address is the real deliverable mailbox.
 *
 * The legal + reviews pages (`/privacy`, `/tos`, `/sms-terms`, `/reviews`) still
 * hardcode this address rather than importing it, so changing it here is not
 * enough — `tests/unit/public-support-email.test.ts` pins those pages so a
 * half-done rename fails instead of shipping two addresses.
 */
export const PUBLIC_SUPPORT_EMAIL = "support@prop-lane.space";
/** Default leasing contact shown in promotion flyer / email blast placeholders. */
export const PUBLIC_LEASING_EMAIL = "leasing@prop-lane.space";
export const PUBLIC_SUPPORT_PHONE_DISPLAY = "(510) 309-8345";
export const PUBLIC_SUPPORT_PHONE_TEL = "+15103098345";
export const PUBLIC_SUPPORT_ADDRESS_LINE = "5259 Brooklyn Ave NE, Seattle, WA 98105";
export const PUBLIC_SUPPORT_ADDRESS_MAP_QUERY = "5259+Brooklyn+Ave+NE%2C+98105";

/**
 * Generic "Get started" — the visitor has NOT said who they are yet, so this
 * lands on the role picker and asks. PRP-307: every public CTA used to carry
 * role=manager, which put renters and vendors into manager signup and only
 * showed itself once they were inside the wrong portal.
 */
export const GET_STARTED_HREF = "/auth/create-account";

/**
 * Manager signup with the role already decided. Only for surfaces where the
 * visitor HAS declared it — the pricing plan CTAs, which also carry a tier.
 * Do not use this for a plain "Get started" button.
 */
export const MANAGER_GET_STARTED_HREF =
  "/auth/create-account?mode=create&role=manager";
export const BOOK_DEMO_HREF = "/contact?tab=schedule";

/**
 * Public social profiles, rendered as the footer icon row: Instagram, TikTok,
 * YouTube, LinkedIn.
 *
 * We do not hold a confirmed handle on most of these networks yet, and a public
 * link to an unclaimed handle either 404s or hands a squatter our brand — so the
 * defaults are the deliberately-neutral placeholder `PLACEHOLDER_SOCIAL_HREF`
 * ("#"), which renders the icon (the brand row is a design requirement) but does
 * NOT point anywhere real. `isPlaceholderSocialHref` lets the renderer drop the
 * new-tab target for those. Supply the real profile URL via `NEXT_PUBLIC_SOCIAL_*`
 * once an account exists; do not hardcode a guessed handle here.
 */
export type PublicSocialId = "instagram" | "tiktok" | "youtube" | "linkedin";

export type PublicSocialLink = {
  id: PublicSocialId;
  /** Accessible name — also the link title attribute. */
  label: string;
  href: string;
};

/** Neutral, non-navigating placeholder for a network we have no handle on yet. */
export const PLACEHOLDER_SOCIAL_HREF = "#";

/** True when `href` is unset or the neutral placeholder (no real destination). */
export function isPlaceholderSocialHref(href: string): boolean {
  return href.length === 0 || href === PLACEHOLDER_SOCIAL_HREF;
}

const SOCIAL_DEFAULTS: Record<PublicSocialId, { label: string; href: string }> = {
  instagram: { label: "PropLane on Instagram", href: PLACEHOLDER_SOCIAL_HREF },
  tiktok: { label: "PropLane on TikTok", href: PLACEHOLDER_SOCIAL_HREF },
  youtube: { label: "PropLane on YouTube", href: PLACEHOLDER_SOCIAL_HREF },
  linkedin: { label: "PropLane on LinkedIn", href: PLACEHOLDER_SOCIAL_HREF },
};

const SOCIAL_ENV: Record<PublicSocialId, string | undefined> = {
  // Read as literals so Next can inline them into the client bundle.
  instagram: process.env.NEXT_PUBLIC_SOCIAL_INSTAGRAM,
  tiktok: process.env.NEXT_PUBLIC_SOCIAL_TIKTOK,
  youtube: process.env.NEXT_PUBLIC_SOCIAL_YOUTUBE,
  linkedin: process.env.NEXT_PUBLIC_SOCIAL_LINKEDIN,
};

export const PUBLIC_SOCIAL_LINKS: PublicSocialLink[] = (
  Object.keys(SOCIAL_DEFAULTS) as PublicSocialId[]
).map((id) => {
  const override = SOCIAL_ENV[id]?.trim();
  return {
    id,
    label: SOCIAL_DEFAULTS[id].label,
    href: override && override.length > 0 ? override : SOCIAL_DEFAULTS[id].href,
  };
});
