import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

export type MockProperty = {
  id: string;
  title: string;
  tagline: string;
  address: string;
  /** Approximate ZIP for demo radius filtering from home search */
  zip: string;
  neighborhood: string;
  beds: number;
  baths: number;
  rentLabel: string;
  available: string;
  petFriendly: boolean;
  /** Same id for all units in one building (tours, grouping) */
  buildingId: string;
  buildingName: string;
  unitLabel: string;
  /** Optional map center for listing detail. WGS84 */
  mapLat?: number;
  mapLng?: number;
  /** When set, listing detail sections are generated from manager submission. */
  listingSubmission?: ManagerListingSubmissionV1;
  /** Supabase user id of the owning manager (demo localStorage scoping). */
  managerUserId?: string;
  /**
   * Manager Twilio work number (E.164) for public "Text to tour/apply" CTAs.
   * Populated from `profiles.sms_from_number` on public listing APIs.
   */
  contactSmsPhone?: string;
  /**
   * Manager PropLane work email for the public "Email" CTA. Populated from that
   * listing's own manager on public listing APIs, and never from
   * `profiles.email` — a prospect emailing here reaches the leasing assistant
   * and the Communication inbox, not somebody's private mailbox.
   */
  contactWorkEmail?: string;
  /** Manager account email for public apply contact when applications are closed. */
  managerContactEmail?: string;
  /** When true, listing is admin-approved for live rent display; property portal inventory only shows extras with this set. */
  adminPublishLive?: boolean;
  /**
   * Set by `publicListingProjection` on anonymous payloads: this row's
   * `listingSubmission` is the public ALLOWLIST, not the stored blob. The public
   * catalog and the manager's own editable catalog share one localStorage map,
   * so `cachePublicExtraListings` reads this to refuse to downgrade an
   * authoritative row it already holds. Never persisted back to `property_data`.
   */
  publicProjection?: boolean;
};

export type MockRow = Record<string, string>;
