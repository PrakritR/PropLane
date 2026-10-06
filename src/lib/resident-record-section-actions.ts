import { Bell, CheckCircle2, Download, Pencil, PenLine, Plus, RefreshCw, Send, Trash2, Undo2, XCircle } from "lucide-react";
import type { RecordHeaderAction } from "@/lib/portals/record-sections";
import type { ResidentRecordStatusBucketId } from "@/lib/resident-detail-subsection-tabs";
import type { LeaseListTabId } from "@/lib/lease-pipeline-storage";

/**
 * The icon actions in a manager resident record's tab header (captain, 2026-10-06): only what applies
 * to the sub-tab that is open, absent (never disabled) otherwise, and never a ⋯ overflow. Every id is
 * an action the record already handled; this decides only WHEN each one is on screen.
 */
export type ResidentSectionActionContext = {
  tab: string;
  /** What the registry lists for this tab (`recordSections(...).headerActions`). */
  registry: RecordHeaderAction[];
  application: {
    /** The record's own application row, when it has one. */
    present: boolean;
    /** The sub-tab it sits under (Incomplete · Pending · Approved · Rejected). */
    rowBucket: ResidentRecordStatusBucketId | null;
    /** The sub-tab that is open. */
    subTab: ResidentRecordStatusBucketId;
    hasForm: boolean;
    /** Withdrawn or never submitted: nothing to approve or reject. */
    undecidable: boolean;
    remindable: boolean;
    screening: boolean;
    checkStatus: string | undefined;
    hasCheck: boolean;
  };
  lease: { present: boolean; subTab: LeaseListTabId };
  payments: { bucket: "overdue" | "pending" | "paid"; rowsInBucket: number };
  tourBucket: string;
};

const DOWNLOAD_PDF: RecordHeaderAction = { id: "download", label: "Download PDF", icon: Download };
const EDIT: RecordHeaderAction = { id: "edit", label: "Edit", icon: Pencil };

export function residentSectionHeaderActions(ctx: ResidentSectionActionContext): RecordHeaderAction[] {
  const { application: app } = ctx;
  switch (ctx.tab) {
    case "application": {
      // The actions are the one application's, so they show only under the sub-tab it sits in.
      if (!app.present || app.rowBucket !== app.subTab) return [];
      if (app.subTab === "incomplete") {
        return [
          ...(app.remindable ? [{ id: "remind-application", label: "Send reminder", icon: Bell }] : []),
          ...(app.hasForm ? [EDIT] : []),
          { id: "send-application", label: "Send application", icon: Send, tone: "primary" as const },
        ];
      }
      if (app.subTab === "pending") {
        return [
          ...(app.undecidable ? [] : [{ id: "decline", label: "Reject", icon: XCircle, tone: "danger" as const }]),
          ...(app.hasForm ? [EDIT] : []),
          DOWNLOAD_PDF,
          ...(app.undecidable ? [] : [{ id: "approve", label: "Approve", icon: CheckCircle2, tone: "primary" as const }]),
        ];
      }
      if (app.subTab === "approved") {
        return [DOWNLOAD_PDF, { id: "send-lease", label: "Send lease", icon: Send, tone: "primary" }];
      }
      // Rejected: a decision can be taken back, or the application deleted (the page confirms first).
      return [
        DOWNLOAD_PDF,
        { id: "move-pending", label: "Move to pending", icon: Undo2 },
        { id: "delete-application", label: "Delete", icon: Trash2, tone: "danger" as const },
      ];
    }
    case "lease": {
      // One lease is shown at a time; what can be done to it follows the stage it is in.
      if (!ctx.lease.present) return [];
      if (ctx.lease.subTab === "draft") {
        return [
          { id: "edit-lease", label: "Edit", icon: Pencil },
          { id: "send-lease", label: "Send lease", icon: Send, tone: "primary" },
        ];
      }
      if (ctx.lease.subTab === "resident") return [{ id: "remind-sign", label: "Send reminder", icon: Bell }];
      if (ctx.lease.subTab === "manager") return [{ id: "sign-lease", label: "Sign", icon: PenLine, tone: "primary" }];
      return [{ id: "download", label: "Download", icon: Download }];
    }
    case "background-check": {
      // No check yet: Run check. Pending: nothing to run. Done (or cancelled): "Run new check".
      if (app.screening || app.checkStatus === "pending") return ctx.registry.filter((a) => a.id !== "run-check");
      if (app.hasCheck) {
        return ctx.registry.map((a) => (a.id === "run-check" ? { id: "run-check", label: "Run new check", icon: RefreshCw } : a));
      }
      return ctx.registry;
    }
    case "payments": {
      if (ctx.payments.bucket === "paid") {
        return ctx.payments.rowsInBucket > 0 ? [{ id: "download", label: "Download", icon: Download }] : [];
      }
      return [
        ...(ctx.payments.rowsInBucket > 0 ? [{ id: "remind-payment", label: "Payment reminder", icon: Bell }] : []),
        { id: "add-charge", label: "Add charge", icon: Plus, tone: "primary" as const },
      ];
    }
    case "tours":
      // Nothing is added to a tour that has already happened.
      return ctx.tourBucket === "past" ? [] : ctx.registry;
    default:
      return ctx.registry;
  }
}
