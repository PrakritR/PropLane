/**
 * The vendor portal's tool registry. Tools bind to VendorAgentContext and
 * scope every query by `vendor_user_id = ctx.userId` (or the owning-manager
 * check for directory rows).
 */
import { buildRegistry, type ToolDefinition, type ToolRegistry } from "./registry";
import type { VendorAgentContext } from "./vendor-context";
import { getMyAvailabilityTool, updateMyAvailabilityTool } from "./domains/vendor/availability";
import { markJobDoneTool, setMyPriceTool, submitBidTool } from "./domains/vendor/job-actions";
import { getJobDetailsTool, listMyBidsTool, listMyJobsTool, listMyOffersTool } from "./domains/vendor/jobs";
import { listMyInboxThreadsTool, sendMessageToManagerTool } from "./domains/vendor/messaging";
import { getMyProfileTool, listMyPayoutsTool } from "./domains/vendor/profile";
import { listMyScheduleTool } from "./domains/vendor/schedule";
import { getVendorLinksTool } from "./domains/portal-links";
import {
  listVendorInvoicesTool,
  listVendorPayoutsTool,
  submitVendorInvoiceTool,
} from "./domains/vendor-financials";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type VendorTool = ToolDefinition<any, any, VendorAgentContext>;

const ALL_VENDOR_TOOLS: VendorTool[] = [
  // Link-first: the portal page for whatever the vendor wants to do.
  getVendorLinksTool,
  // Jobs / bids / offers
  listMyJobsTool,
  getJobDetailsTool,
  listMyBidsTool,
  listMyOffersTool,
  submitBidTool,
  setMyPriceTool,
  markJobDoneTool,
  // Payouts / profile
  listMyPayoutsTool,
  getMyProfileTool,
  // Invoicing (Phase 4): totals are recomputed server-side from line items.
  listVendorInvoicesTool,
  submitVendorInvoiceTool,
  listVendorPayoutsTool,
  // Availability + calendar
  getMyAvailabilityTool,
  updateMyAvailabilityTool,
  listMyScheduleTool,
  // Inbox / messaging
  listMyInboxThreadsTool,
  sendMessageToManagerTool,
];

export const vendorAgentRegistry: ToolRegistry<VendorAgentContext> = buildRegistry(ALL_VENDOR_TOOLS);
