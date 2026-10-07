/**
 * Client-safe contract for a PropLane-sponsored vendor work identity.  This is
 * deliberately separate from a vendor's business contact details: these are
 * platform-owned sending and receiving identities only.
 */
export const VENDOR_WORK_IDENTITY_STATES = [
  "not_started",
  "provisioning",
  "reconciling",
  "ready",
  "blocked",
  "quarantined",
  "disabled",
  "released",
] as const;

export type VendorWorkIdentityState = (typeof VENDOR_WORK_IDENTITY_STATES)[number];

export type VendorWorkIdentityChannel = {
  state: VendorWorkIdentityState;
  /** Full normalized address/number, returned only after platform allocation. */
  value: string | null;
  sendReady: boolean;
  receiveReady: boolean;
  canSetup: boolean;
  blockedReason:
    | "provider_disabled"
    | "provider_unconfigured"
    | "platform_capacity_reached"
    | "identity_quarantined"
    | "identity_released"
    | "phone_unverified"
    | "none";
};

export type VendorWorkIdentityUsage = {
  /** Texts sent this Pacific calendar month (outbound SMS segments for the number; emails count one each). */
  outboundUsed: number;
  /** Fair-use cap per month. */
  outboundCap: number;
  capState: "available" | "exhausted" | "unconfigured";
  /** SMS segments this Pacific calendar month - what "Texts this month X of 1,000" shows. */
  smsSegmentsUsed: number;
};

/** The vendor's own verified phone: the eligibility gate and the forwarding destination. */
export type VendorWorkIdentityEligibility = {
  phoneVerified: boolean;
  /** Masked for display, e.g. "(206) 555-0142"; never used to route. */
  verifiedPhoneLabel: string | null;
};

export type VendorWorkIdentityResponse = {
  sponsoredBy: "proplane";
  email: VendorWorkIdentityChannel;
  sms: VendorWorkIdentityChannel;
  /** Availability of routing inbound messages; it does not enable the SMS UI. */
  inboundAvailable: { email: boolean; sms: boolean };
  smsUiEnabled: boolean;
  usage: VendorWorkIdentityUsage;
  /** Verified-phone gate for claiming a number. Optional so older fixtures still type-check. */
  eligibility?: VendorWorkIdentityEligibility;
  /** Forward managers' texts to the verified phone. Defaults on. */
  forwardToPhone?: boolean;
  /** True when provisioning is a dry run (no provider call, a fictional number). */
  dryRun?: boolean;
};
