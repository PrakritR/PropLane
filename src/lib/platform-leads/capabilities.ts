import type { PlatformSource } from "@/lib/prospect-spine/contracts";

/**
 * What each site lets a reply carry, and how a reply leaves (design-1112 §3.4). The captain's per-site statements are
 * encoded here as one editable table; nothing posts to a platform: a reply either goes by the site's own relay EMAIL
 * (`email_relay`) or sits in the thread as a draft the manager copies and pastes on the site (`manual_copy`).
 */
export type ChannelCapability = {
  site: PlatformSource;
  label: string;
  /** manual_copy = draft shown in the thread with Copy, opened on the site. */
  replyMode: "email_relay" | "manual_copy";
  allowsLinkInMessage: boolean;
  allowsPhoneInMessage: boolean;
  notes: string;
};

export const CHANNEL_CAPABILITIES: Record<PlatformSource, ChannelCapability> = {
  spareroom: { site: "spareroom", label: "SpareRoom", replyMode: "email_relay", allowsLinkInMessage: true, allowsPhoneInMessage: true, notes: "Relay by email when the mail carried one, else a draft to copy. Not allowed in the listing text itself." },
  roomies: { site: "roomies", label: "Roomies", replyMode: "manual_copy", allowsLinkInMessage: true, allowsPhoneInMessage: true, notes: "Draft to copy and paste on Roomies. Not allowed in the listing text itself." },
  zillow: { site: "zillow", label: "Zillow", replyMode: "email_relay", allowsLinkInMessage: true, allowsPhoneInMessage: true, notes: "Relay by email when the mail named Zillow's relay address, else a draft. No links in descriptions." },
  craigslist: { site: "craigslist", label: "Craigslist", replyMode: "email_relay", allowsLinkInMessage: false, allowsPhoneInMessage: true, notes: "Anonymised relay (reply.craigslist.org). Plain text, no links." },
  facebook: { site: "facebook", label: "Facebook", replyMode: "manual_copy", allowsLinkInMessage: false, allowsPhoneInMessage: true, notes: "Draft to copy. A DM to a non-friend may be filtered: prefer a comment reply." },
  roomster: { site: "roomster", label: "Roomster", replyMode: "manual_copy", allowsLinkInMessage: false, allowsPhoneInMessage: true, notes: "Draft to copy and paste on Roomster." },
  airbnb: { site: "airbnb", label: "Airbnb", replyMode: "email_relay", allowsLinkInMessage: false, allowsPhoneInMessage: false, notes: "Existing guest-message behaviour; forbids contact details." },
  booking_com: { site: "booking_com", label: "Booking.com", replyMode: "email_relay", allowsLinkInMessage: false, allowsPhoneInMessage: false, notes: "Existing guest-message behaviour; forbids contact details." },
  padsplit: { site: "padsplit", label: "PadSplit", replyMode: "email_relay", allowsLinkInMessage: true, allowsPhoneInMessage: true, notes: "Existing guest-message behaviour." },
};
