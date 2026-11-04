/** Data that may cross the public vendor quote boundary. Never add resident or property secrets. */
export type VendorQuoteSenderIdentity = {
  mode: "software" | "managed";
  managerUserId: string;
  displayName: string;
  legalName: string;
  email: string;
  workPhone: string | null;
  messagingServiceSid: string | null;
  workspaceId: string;
  transportKind?: "shared" | "workspace_number" | "service_number" | null;
  selectedLineId?: string | null;
  providerMessagingServiceSid?: string | null;
  version: number;
};

export type VendorQuoteExistingResponse = {
  laborCents: number | null;
  materialsCents: number | null;
  diagnosticFeeCents: number | null;
  scope: string | null;
  exclusions: string | null;
  durationMinutes: number | null;
  windows: VendorQuoteWindow[];
};

export type VendorQuoteWindow = { startIso: string; endIso: string; timeZone: string };

export type PublicVendorServiceFacts = {
  category: string;
  serviceReference: string;
  city: string;
  problemSummary: string | null;
};

export type VendorQuotePublicProjection = {
  sessionBinding?: string;
  reference: string;
  category: string;
  city: string;
  problemDescription?: string | null;
  senderName: string;
  senderEmail: string;
  expiresAt: string;
  currentVersion: number;
  quote: VendorQuoteExistingResponse | null;
  followUpReply?: string | null;
  windows: VendorQuoteWindow[];
  canStopEmail: boolean;
  smsConsent: "not_requested" | "pending" | "granted";
};

export type VendorQuoteResponseInput = {
  laborCents: number | null;
  materialsCents: number | null;
  diagnosticFeeCents: number | null;
  scope: string;
  exclusions: string;
  durationMinutes: number | null;
  windows: VendorQuoteWindow[];
  question: string;
};

export type VendorQuoteCapabilityPurpose = "response" | "inbound_reply" | "withdrawal";

export type VendorQuoteEmailDispatchResult =
  | { ok: true; state: "accepted" | "captured"; providerMessageId: string; capabilityId: string }
  | { ok: false; state: "manual_contact_required" | "suppressed" | "unknown" | "failed_before_send"; reason: string };

/** The exact inbound SMS grammar accepted by the vendor quote consent parser. */
export function formatVendorQuoteSmsChallengeMessage(code: string): string {
  return `QUOTE ${code}`;
}
