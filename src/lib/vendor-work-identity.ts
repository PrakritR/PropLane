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
    | "none";
};

export type VendorWorkIdentityUsage = {
  outboundUsed: number;
  outboundCap: number;
  capState: "available" | "exhausted" | "unconfigured";
};

export type VendorWorkIdentityResponse = {
  sponsoredBy: "proplane";
  email: VendorWorkIdentityChannel;
  sms: VendorWorkIdentityChannel;
  /** Availability of routing inbound messages; it does not enable the SMS UI. */
  inboundAvailable: { email: boolean; sms: boolean };
  smsUiEnabled: boolean;
  usage: VendorWorkIdentityUsage;
};
