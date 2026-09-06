/**
 * The agent's tool registries: the single contract every agent loop calls
 * through. Add new site capabilities here as typed, permission-scoped
 * ToolDefinitions. Write tools are confirm-gated by the framework
 * (preview → user confirmation → handler); see docs/ai-assistant.md.
 *
 * One registry + one context resolver per role — see AGENTS.md. They must never
 * be crossed: the manager registry binds to `AgentContext`, the resident and
 * vendor registries to their own scoped context types, so a manager tool cannot
 * even typecheck into a resident registry.
 */
import { managerInspectionTools } from "./domains/inspections";
import { buildRegistry, type ToolRegistry } from "./registry";
import type { AgentContext } from "./context";
import {
  delegatedSmsWithholdsTool,
  type ManagerSmsAccess,
} from "@/lib/sms/manager-sms-access";
import { getOverdueChargesTool, listChargesTool, sendRentReminderTool } from "./domains/payments";
import {
  createChargeTool,
  updateChargeTool,
  deleteChargeTool,
  markChargePaidTool,
} from "./domains/charges";
import {
  getAutomationSettingsTool,
  updateAutomationSettingsTool,
  cancelScheduledReminderTool,
  restoreScheduledReminderTool,
  rescheduleReminderTool,
} from "./domains/automation";
import {
  listLeasesTool,
  listLeaseSectionsTool,
  amendLeaseTool,
  voidLeaseTool,
  sendLeaseForSignatureTool,
  createLeaseDraftTool,
  updateLeaseDraftTool,
  updateLeasePacketTool,
  proposeLeaseSectionEditTool,
} from "./domains/leases";
import {
  listWorkOrdersTool,
  suggestVendorsForWorkOrderTool,
  listWorkOrderBidsTool,
  createWorkOrderTool,
  assignVendorTool,
  offerToVendorsTool,
  scheduleVendorVisitTool,
  acceptBidTool,
  completeWorkOrderTool,
  approveAndPayWorkOrderTool,
  sendWorkOrderReminderTool,
} from "./domains/work-orders";
import { listVendorsTool, addVendorTool, updateVendorTool, inviteVendorTool } from "./domains/vendors";
import { runFinancialReportTool, recordExpenseTool, recordIncomeTool } from "./domains/financials";
import {
  listResidentsTool,
  setResidentApprovalTool,
  sendResidentWelcomeTool,
  revokeResidentAccessTool,
  recordMoveOutTool,
} from "./domains/residents";
import {
  listApplicationsTool,
  getApplicationDetailsTool,
  updateApplicationBucketTool,
  orderBackgroundCheckTool,
} from "./domains/applications";
import {
  listPropertiesTool,
  getPropertyDetailsTool,
  createPropertyTool,
  updatePropertyTool,
  updateRoomRentTool,
  updatePropertyLeaseConfigTool,
  listPropertyLeaseTemplateSectionsTool,
  proposePropertyLeaseTemplateSectionEditTool,
  copyListingPhotosTool,
  sharePropertyLinkTool,
} from "./domains/properties";
import {
  getListingCreationChecklistTool,
  createListingDraftTool,
  updateListingDraftTool,
} from "./domains/listing-draft";
import { applyListingPhotosTool, getListingMediaInventoryTool } from "./domains/listing-media";
import { listInboxThreadsTool, getThreadMessagesTool, updateThreadTool } from "./domains/inbox";
import {
  sendMessageTool,
  replyToThreadTool,
  scheduleMessageTool,
  cancelScheduledMessageTool,
} from "./domains/messaging";
import {
  listCalendarEventsTool,
  listScheduledMessagesTool,
  listTourInquiriesTool,
  updateManagerAvailabilityTool,
  createCalendarEventTool,
  cancelCalendarEventTool,
  acceptTourInquiryTool,
} from "./domains/calendar";
import { listServiceRequestsTool } from "./domains/services";
import { findRecordsTool } from "./domains/search";
import { getManagerProfileTool, getDashboardSummaryTool } from "./domains/profile";
import {
  listPromotionsTool,
  createPromotionTool,
  generatePromotionFlyerTool,
  updatePromotionTool,
  deletePromotionTool,
} from "./domains/promotions";
import { listCoManagersTool } from "./domains/team";
import { listDocumentsTool } from "./domains/documents";
import { managerFinancialsWriteTools } from "./domains/financials-write";
import { managerServicesWriteTools } from "./domains/services-write";
import { confirmTourInquiryTool } from "./domains/tours-write";
import {
  bookTourTool,
  cancelTourTool,
  leasingRequestTourTool,
  listOpenTourSlotsTool,
  rescheduleTourTool,
} from "./domains/tours";
import {
  escalateToManagerTool,
  getJobAccessInfoTool,
  getJobDetailsTool as getSmsJobDetailsTool,
  listMyJobsWithThisManagerTool,
} from "./domains/vendor-work-order";
import {
  buildProspectLinksTool,
  escalateLeasingToManagerTool,
  getListingDetailsTool,
  getSiteLinksTool,
  listLiveListingsTool,
} from "./domains/leasing-sms";

export const agentRegistry = buildRegistry([
  ...managerInspectionTools,
  // Cross-domain entity search — the model's first stop for loose names
  findRecordsTool,
  // Reads
  getOverdueChargesTool,
  listChargesTool,
  listLeasesTool,
  listLeaseSectionsTool,
  listWorkOrdersTool,
  suggestVendorsForWorkOrderTool,
  listWorkOrderBidsTool,
  listVendorsTool,
  runFinancialReportTool,
  listResidentsTool,
  listApplicationsTool,
  getApplicationDetailsTool,
  listPropertiesTool,
  getPropertyDetailsTool,
  getListingCreationChecklistTool,
  getListingMediaInventoryTool,
  listInboxThreadsTool,
  getThreadMessagesTool,
  listCalendarEventsTool,
  listScheduledMessagesTool,
  listTourInquiriesTool,
  // What is actually open: published minus calendar-busy minus booked, the same
  // grid the public booking page draws. Every tour write reads from it.
  listOpenTourSlotsTool,
  listServiceRequestsTool,
  listDocumentsTool,
  getManagerProfileTool,
  getDashboardSummaryTool,
  getAutomationSettingsTool,
  listPromotionsTool,
  listCoManagersTool,
  // Write tools: previewed from the model loop, executed only via the gated
  // confirm endpoint after explicit user confirmation.
  sendRentReminderTool,
  createChargeTool,
  updateChargeTool,
  deleteChargeTool,
  markChargePaidTool,
  updateAutomationSettingsTool,
  cancelScheduledReminderTool,
  restoreScheduledReminderTool,
  rescheduleReminderTool,
  sendMessageTool,
  replyToThreadTool,
  scheduleMessageTool,
  cancelScheduledMessageTool,
  // Low-risk inbox housekeeping; see MANAGER_INLINE_WRITE_TOOLS below.
  updateThreadTool,
  updateManagerAvailabilityTool,
  createCalendarEventTool,
  cancelCalendarEventTool,
  acceptTourInquiryTool,
  // Confirm a proposed tour into a booked event + notify the guest. Backs the
  // approval-first auto-tour flow, executed only through the confirm gate.
  confirmTourInquiryTool,
  // Book / move / cancel a tour outright. `confirm_tour_inquiry` above needs an
  // existing request; these do not, so "book Jane Thursday at 3" is reachable.
  bookTourTool,
  rescheduleTourTool,
  cancelTourTool,
  createWorkOrderTool,
  assignVendorTool,
  offerToVendorsTool,
  scheduleVendorVisitTool,
  acceptBidTool,
  completeWorkOrderTool,
  approveAndPayWorkOrderTool,
  sendWorkOrderReminderTool,
  addVendorTool,
  updateVendorTool,
  inviteVendorTool,
  createPropertyTool,
  createListingDraftTool,
  updateListingDraftTool,
  applyListingPhotosTool,
  updatePropertyTool,
  updateRoomRentTool,
  updatePropertyLeaseConfigTool,
  listPropertyLeaseTemplateSectionsTool,
  proposePropertyLeaseTemplateSectionEditTool,
  copyListingPhotosTool,
  sharePropertyLinkTool,
  setResidentApprovalTool,
  sendResidentWelcomeTool,
  revokeResidentAccessTool,
  recordMoveOutTool,
  updateApplicationBucketTool,
  orderBackgroundCheckTool,
  createLeaseDraftTool,
  updateLeaseDraftTool,
  updateLeasePacketTool,
  proposeLeaseSectionEditTool,
  amendLeaseTool,
  voidLeaseTool,
  sendLeaseForSignatureTool,
  recordExpenseTool,
  recordIncomeTool,
  createPromotionTool,
  generatePromotionFlyerTool,
  updatePromotionTool,
  deletePromotionTool,
  ...managerServicesWriteTools,
  // The accounting writes (bills, budgets, deposit dispositions, owner
  // distributions, bank reconciliation). Each carries a preview, which is what
  // makes it safe to expose — the model can propose, only the landlord can
  // execute.
  ...managerFinancialsWriteTools,
]);

/**
 * Write tools the MANAGER chat surfaces let the model run inline, without a
 * confirmation card. Deliberately tiny and explicit: `update_thread` is inbox
 * housekeeping (mark read/unread, trash, restore) that a manager would find
 * absurd to confirm one card at a time, and it audit-logs itself. Adding a
 * tool here removes its confirmation gate — nothing that moves money, sends
 * mail, or changes a lease may ever be listed.
 */
export const MANAGER_INLINE_WRITE_TOOLS: readonly string[] = [updateThreadTool.name];

/**
 * The MANAGER SMS agent's registry: everything the manager portal assistant has,
 * minus every tool flagged `destructive`.
 *
 * The line is drawn by the flag, never by a hand-typed name list, so a
 * destructive tool added later is withheld automatically rather than silently
 * becoming textable.
 *
 * Why withhold anything at all when the portal grants it: over SMS the only
 * credential is the Twilio `From` header, which is attacker-influencable (the
 * same reasoning `resident-sms-context.ts` spells out). Before this surface
 * existed, a spoofed manager cell bought a text relay; letting it reach
 * `approve_and_pay_work_order`, `void_lease`, `delete_charge`,
 * `revoke_resident_access`, `delete_promotion` or `cancel_calendar_event` —
 * behind a one-word "YES" with no card to re-read — is a materially different
 * blast radius. Those stay portal-only, and the system prompt says so.
 *
 * ponytail: one flat exclusion rule. If a manager ever needs a destructive
 * action by text, add a per-manager opt-in plus a stronger confirmation token
 * than YES; do not weaken this filter.
 */
let managerSmsRegistry: ToolRegistry<AgentContext> | null = null;

export function buildManagerSmsRegistry(
  access?: ManagerSmsAccess | null,
): ToolRegistry<AgentContext> {
  // Memoized: the filter is static, and `buildRegistry` runs `zodToJsonSchema`
  // over every write tool to enforce the identity-field rule. That is real work
  // to repeat on each inbound text.
  managerSmsRegistry ??= buildRegistry(
    [...agentRegistry.values()].filter((tool) => !(tool.kind === "write" && tool.destructive)),
  );
  if (access?.mode !== "delegated") return managerSmsRegistry;
  return buildRegistry(
    [...managerSmsRegistry.values()].filter((tool) => !delegatedSmsWithholdsTool(tool.name)),
  );
}

/**
 * The 24/7 vendor work-order agent's registry: three reads pinned to ONE work
 * order via ctx.vendorScope plus escalate_to_manager (the only write, allow-
 * listed for autonomous calls). Deliberately tiny and separate from every other
 * registry — the SMS/inbox agent must never see invoices, financials, or any
 * manager tool.
 */
export const vendorWorkOrderAgentRegistry = buildRegistry([
  getSmsJobDetailsTool,
  getJobAccessInfoTool,
  listMyJobsWithThisManagerTool,
  escalateToManagerTool,
]);

/**
 * Prospect-facing leasing SMS agent on each manager's Twilio work number.
 * Separate registry so it never sees financials, residents, or vendor tools.
 */
export const leasingSmsAgentRegistry = buildRegistry([
  listLiveListingsTool,
  getListingDetailsTool,
  buildProspectLinksTool,
  getSiteLinksTool,
  escalateLeasingToManagerTool,
  // A texting prospect can see real open times and file a tour REQUEST. It
  // books nothing — the manager still confirms. See LEASING_SMS_INLINE_WRITE_TOOLS.
  listOpenTourSlotsTool,
  leasingRequestTourTool,
]);

/**
 * Write tools the prospect-facing leasing SMS agent may run inline.
 *
 * A texting prospect is anonymous: there is no `user_id` for a pending action
 * to be claimed on, so a confirmation card is not merely absent, it is
 * impossible. Both entries here are therefore chosen for being the same risk
 * class — each files a request and notifies the manager, and neither changes
 * anything the manager has not then seen and acted on. Nothing that books,
 * charges, sends on the manager's behalf, or reads personal data may join them.
 */
export const LEASING_SMS_INLINE_WRITE_TOOLS: readonly string[] = [
  escalateLeasingToManagerTool.name,
  leasingRequestTourTool.name,
];

/**
 * The manager-financials WRITE tools on their own, for tests and for any caller
 * that needs just the accounting writes. These are ALSO part of `agentRegistry`:
 * every one carries a preview, so the model can propose them and only the
 * landlord's explicit confirmation executes them — the same gate every other
 * write tool goes through.
 */
export const managerWriteRegistry = buildRegistry([...managerFinancialsWriteTools]);

export { resolveAgentContext, type AgentContext } from "./context";
export { resolveResidentAgentContext, type ResidentAgentContext } from "./resident-context";
export { resolveVendorAgentContext, type VendorAgentContext } from "./vendor-context";
