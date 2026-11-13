import "server-only";

/**
 * Prospect spine (design-1112 section 3.0): the one place a person who is not yet an account holder is written down.
 * Phone is the identity; `recordInbound` is the one writer; a link to an account happens only on a VERIFIED phone; a
 * platform thread merges by stitch code or a phone in the message, never by name or email.
 *
 * Every function takes the service-role client. Package B/C/D import only from here.
 */
export { contextLabel } from "@/lib/prospect-spine/label";
export { recordInbound, recordOutbound } from "@/lib/prospect-spine/record.server";
export { recordDeliveryIssue, clearDeliveryIssue } from "@/lib/prospect-spine/delivery-issue.server";
export { resolveInboundContext } from "@/lib/prospect-spine/context.server";
export { linkAccountToProspectRecord, loadProspectRecord } from "@/lib/prospect-spine/link.server";
export { mintStitchCode, stitchByCode, stitchByPhone, sourceReport } from "@/lib/prospect-spine/stitch.server";
export { resolveSmsPayer } from "@/lib/prospect-spine/payer.server";
