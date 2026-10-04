/** Query-string helpers so listing/property “Apply” links pre-fill the rental wizard. */

export type RentalApplyFromListingParams = {
  propertyId: string;
  /** Floor plan / modal room id (for your records; optional). */
  listingRoomId?: string;
  /** Display name, e.g. “Room 2”. */
  listingRoomName?: string;
  floorLabel?: string;
  roomPrice?: string;
  /** Manager-defined bundle id — pre-selects the bundle in the wizard. */
  bundleId?: string;
  /**
   * Prospect phone (E.164 or 10-digit US). Prefills the application phone field
   * when opened from a leasing SMS apply link.
   */
  phone?: string;
  /** Pre-select long-term vs short-term application form (`standard` | `short_term`). */
  rentalType?: "standard" | "short_term";
  /** Organizer application id for a joining roommate (`groupLeaderAppId` query param). */
  groupLeaderAppId?: string;
  /** A specific published application form the manager chose to send (`form` query param). */
  applicationFormId?: string;
};

/** Query param that carries the application form a manager chose when sending the link. */
export const APPLY_FORM_PARAM = "form";

export function buildRentalApplyHref(p: RentalApplyFromListingParams): string {
  const q = new URLSearchParams();
  q.set("propertyId", p.propertyId);
  if (p.listingRoomId) q.set("listingRoomId", p.listingRoomId);
  if (p.listingRoomName) q.set("roomName", p.listingRoomName);
  if (p.floorLabel) q.set("floor", p.floorLabel);
  if (p.roomPrice) q.set("roomPrice", p.roomPrice);
  if (p.bundleId) q.set("bundle", p.bundleId);
  if (p.phone?.trim()) q.set("phone", p.phone.trim());
  if (p.rentalType === "short_term") q.set("rentalType", "short_term");
  if (p.groupLeaderAppId?.trim()) q.set("groupLeaderAppId", p.groupLeaderAppId.trim());
  if (p.applicationFormId?.trim()) q.set(APPLY_FORM_PARAM, p.applicationFormId.trim());
  return `/rent/apply?${q.toString()}`;
}
