import type { DispatchUrgency } from "@/lib/vendor-dispatch/trades";
import type { DispatchJobDetails } from "@/lib/vendor-dispatch/text";

export type DispatchSourceType = "work_order" | "service_request" | "tour" | "cleaning" | "manual";

export type DispatchRunStatus =
  | "awaiting_approval"
  | "offering"
  | "accepted"
  | "exhausted"
  | "declined_by_manager"
  | "canceled"
  | "completed";

export type DispatchAttemptStatus =
  | "queued"
  | "offered"
  | "accepted"
  | "declined"
  | "busy"
  | "timed_out"
  | "superseded"
  | "canceled";

export type DispatchRuleRow = {
  id: string;
  workspace_id: string;
  owner_user_id: string;
  name: string;
  trade: string;
  issue: string | null;
  property_scope: "all" | "selected";
  property_ids: string[];
  urgencies: string[];
  hours: "any" | "business" | "after_hours";
  mode: "sequential" | "broadcast";
  broadcast_size: number;
  timeout_minutes: number | null;
  pay_cents: number | null;
  pay_model: "flat" | "hourly" | "per_room" | "quote";
  nte_cents: number | null;
  approval: "always";
  active: boolean;
  created_at: string;
  updated_at: string;
};

export type DispatchRunRow = {
  id: string;
  workspace_id: string;
  owner_user_id: string;
  handle: number;
  source_type: DispatchSourceType;
  source_id: string;
  rule_id: string | null;
  trade: string;
  issue: string | null;
  urgency: DispatchUrgency;
  property_id: string | null;
  offer_text: string;
  pay_cents: number | null;
  nte_cents: number | null;
  mode: "sequential" | "broadcast";
  timeout_minutes: number;
  status: DispatchRunStatus;
  approval_channel: "sms" | "portal" | null;
  approved_by: string | null;
  approved_at: string | null;
  approval_reminded_at: string | null;
  approval_escalated_at: string | null;
  accepted_vendor_directory_id: string | null;
  accepted_at: string | null;
  scheduled_for: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  details: DispatchJobDetails & Record<string, unknown>;
  resident_email: string | null;
  deadline_at: string | null;
  approval_notified_user_ids: string[];
  agreed_cents: number | null;
  wave: number;
  exhausted_at: string | null;
  vendor_done_at: string | null;
  completed_at: string | null;
  completion_state: "awaiting_resident" | "confirmed" | "reopened" | null;
  pending_invoice_cents: number | null;
};

export type DispatchAttemptRow = {
  id: string;
  run_id: string;
  vendor_directory_id: string;
  position: number;
  wave: number;
  status: DispatchAttemptStatus;
  offered_at: string | null;
  timeout_at: string | null;
  responded_at: string | null;
  response_text: string | null;
  busy_until: string | null;
  proposed_time: string | null;
  outbox_id: string | null;
  created_at: string;
  quote_cents: number | null;
  quote_status: "pending" | "approved" | "rejected" | null;
};

/** One reachable vendor in a dispatch chain. */
export type ChainVendor = {
  vendorDirectoryId: string;
  name: string;
  firstName: string;
  phone: string;
  vendorUserId: string | null;
  position: number;
};
