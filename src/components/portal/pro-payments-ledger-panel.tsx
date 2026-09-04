"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  ApplicationHouseholdCluster,
  PortalListClusterSelectCheckbox,
  togglePortalListClusterSelection,
} from "@/components/portal/application-household-list";

import {
  PortalDataTableEmpty,
} from "@/components/portal/portal-data-table";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { DataList } from "@/components/ui/data-list";
import { PORTAL_LIST_ADD_ICONS } from "@/components/portal/portal-list-add-row";
import type { DemoManagerPaymentLedgerRow, ManagerPaymentBucket, ManagerPaymentDirection } from "@/data/demo-portal";
import { PortalRecordDetailPage } from "@/components/portal/portal-record-detail-page";
import {
  clusterManagerPaymentLedgerRowsByMode,
  type ManagerPaymentPropertyCluster,
  type ManagerPaymentResidentCluster,
} from "@/lib/manager-payment-ledger-grouping";
import { isPropertyClusterList, type PortalListGroupMode } from "@/lib/portal-list-grouping";
import { paymentDetailHref, paymentListHref } from "@/lib/portal-detail-routes";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { RESIDENT_DETAIL_HEADER_ACTION_BTN } from "@/components/portal/portal-metrics";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { deleteManagerPaymentLedgerEntry, markManagerPaymentLedgerPaid, markManagerPaymentLedgerPending } from "@/lib/demo-manager-payment-ledger";
import { deleteHouseholdCharge, legacyChargeIdAliases, markHouseholdChargePaid, markHouseholdChargePending, publicChargeIdForUrl, updateHouseholdChargeAmount } from "@/lib/household-charges";
import {
  syncResidentAfterStayPaymentEdit,
  syncResidentBillingAndLeases,
} from "@/lib/resident-lease-billing-sync";
import {
  parseShortTermStayChargeTitle,
  shortTermStayChargeTitle,
  shortTermStayTotalAmount,
} from "@/lib/short-term-stay-pricing";
import { Input } from "@/components/ui/input";
import {
  PortalBulkMessageReadonlyCarouselModal,
} from "@/components/portal/portal-bulk-message-carousel-modal";
import {
  PortalNotificationPreviewModal,
  type BulkPaymentReminderPreviewItem,
} from "@/components/portal/portal-notification-preview-modal";
import {
  cancelFutureRemindersForPaidCharge,
  ChargeRemindersModal,
  patchScheduledMessage,
  restoreFutureRemindersForPendingCharge,
} from "@/components/portal/payment-schedule-ui";
import { PaymentScheduledMessagesLead } from "@/components/portal/payment-scheduled-lead";
import type { ScheduledPaymentMessage } from "@/lib/scheduled-payment-messages";
import { manageableRemindersForCharge, formatScheduledSendAt } from "@/lib/scheduled-payment-messages";
import { scheduledSendBadgeLabel, summariseScheduledSends } from "@/lib/scheduled-send-summary";
import {
  combineScheduledPaymentMessages,
  scheduledMessagesTouchingCharges,
} from "@/lib/combined-payment-reminders";
import { paymentReminderRecipientLabel } from "@/lib/payment-reminder-ui";
import {
  buildCombinedPaymentReminderBody,
  buildManualPaymentInstructionLines,
  buildPaymentReminderBody,
  sumPaymentBalanceLabels,
} from "@/lib/manual-payment-instructions";
import {
  PortalAdaptiveActionRow,
  type PortalAdaptiveAction,
} from "@/components/portal/portal-adaptive-action-row";
import { cn } from "@/lib/utils";

/** Compact outline buttons for the fixed bulk-selection bar (single row on mobile). */
const PAYMENTS_BULK_BAR_BTN =
  "h-8 min-h-0 shrink-0 whitespace-nowrap rounded-full border-border px-2.5 text-[10px] font-semibold sm:px-3 sm:text-[11px] !shadow-none hover:!translate-y-0 [html[data-theme=dark]_&]:portal-outline-control";

const PAYMENTS_BULK_MORE_BTN = cn(PAYMENTS_BULK_BAR_BTN, "min-w-9 px-0");

function isMarkableAsPaid(row: DemoManagerPaymentLedgerRow): boolean {
  return row.statusLabel !== "Paid" && row.balanceDue !== "$0.00";
}

function isPaidRow(row: DemoManagerPaymentLedgerRow): boolean {
  return row.statusLabel === "Paid" || row.balanceDue === "$0.00";
}

/**
 * A paid security deposit is the only thing PropLane can send back.
 *
 * Rent is the manager's income; a deposit was never their money. The route re-checks all of this
 * server-side — this only decides whether to OFFER the button, so a manager is not shown an
 * action that will always be refused.
 */
function isReturnableDepositRow(row: DemoManagerPaymentLedgerRow): boolean {
  return row.chargeKind === "security_deposit" && isPaidRow(row) && Boolean(row.householdChargeId);
}

function isRemindableRow(row: DemoManagerPaymentLedgerRow): boolean {
  return !isPaidRow(row) && Boolean(row.householdChargeId || row.id);
}

function paymentReminderMetaHint(
  row: DemoManagerPaymentLedgerRow,
  scheduledMessages: ScheduledPaymentMessage[],
): string | null {
  if (!row.householdChargeId || isPaidRow(row)) return null;
  const reminders = manageableRemindersForCharge(scheduledMessages, row.householdChargeId);
  const summary = summariseScheduledSends(reminders);
  if (summary.count > 0 && summary.nextSendAt) {
    const next = formatScheduledSendAt(summary.nextSendAt);
    return summary.count === 1
      ? `Next reminder ${next}`
      : `Next reminder ${next} (+${summary.count - 1} more)`;
  }
  const hasScheduled = reminders.some((message) => message.status === "scheduled");
  const hasActive = reminders.some((message) => message.status !== "cancelled" && message.status !== "sent");
  if (hasActive && !hasScheduled) return "Reminders paused";
  return null;
}

function formatDueMeta(due: string): string {
  const trimmed = due.trim();
  if (!trimmed) return "";
  if (/^(due|before)\b/i.test(trimmed)) return trimmed;
  return `Due ${trimmed}`;
}

function ledgerRowMetaLine(
  row: DemoManagerPaymentLedgerRow,
  scheduledMessages: ScheduledPaymentMessage[],
  options?: { includeProperty?: boolean; includeReminder?: boolean },
): string {
  const includeProperty = options?.includeProperty ?? true;
  const includeReminder = options?.includeReminder ?? true;
  const parts: string[] = [];
  if (includeProperty) {
    const property = ledgerRowPropertyLine(row);
    if (property !== "—") parts.push(property);
  }
  const due = formatDueMeta(row.dueDate ?? "");
  if (due) parts.push(due);
  if (includeReminder) {
    const reminder = paymentReminderMetaHint(row, scheduledMessages);
    if (reminder) parts.push(reminder);
  }
  return parts.join(" · ");
}

function dueDateDisplayToInputValue(display: string): string {
  const stripped = display.replace(/^(by|before)\s+/i, "").trim();
  const parsed = new Date(stripped);
  if (Number.isNaN(parsed.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
}

function dueDateInputToLabel(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  if (!year || !month || !day) return "";
  const d = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatLedgerRoomLabel(roomNumber: string): string {
  const trimmed = roomNumber.trim();
  if (!trimmed || trimmed === "—") return "";
  return /^room\b/i.test(trimmed) ? trimmed : `Room ${trimmed}`;
}

function isStayTotalRow(row: DemoManagerPaymentLedgerRow): boolean {
  return row.chargeKind === "stay_total" || /^Stay total \(/i.test(row.chargeTitle);
}

function ledgerRowPrimaryLabel(row: DemoManagerPaymentLedgerRow): string {
  if (row.manualPaymentReportedAt && row.manualPaymentChannel) {
    return `${row.chargeTitle} · ${row.manualPaymentChannel === "zelle" ? "Zelle" : "Venmo"} reported`;
  }
  return row.chargeTitle;
}

function ledgerRowPropertyLine(row: DemoManagerPaymentLedgerRow): string {
  return [row.propertyName, formatLedgerRoomLabel(row.roomNumber)].filter(Boolean).join(" · ") || "—";
}

export function ManagerPaymentsLedgerPanel({
  rows,
  managerUserId,
  activeBucket,
  scheduledMessages = [],
  reminderScheduleSummary,
  onOpenReminderSettings,
  onRowsChanged,
  onScheduleChanged,
  paymentId: paymentIdProp,
  listBasePath,
  direction = "incoming",
  embeddedInResident = false,
  buildPaymentDetailHref,
  onEmbeddedDetailActions,
  onEmbeddedBulkActions,
  onAddPayment,
  groupMode = "resident",
}: {
  rows: DemoManagerPaymentLedgerRow[];
  managerUserId: string | null;
  activeBucket: ManagerPaymentBucket;
  scheduledMessages?: ScheduledPaymentMessage[];
  reminderScheduleSummary?: string;
  onOpenReminderSettings?: () => void;
  onRowsChanged?: () => void;
  onScheduleChanged?: () => void;
  paymentId?: string;
  listBasePath?: string;
  direction?: ManagerPaymentDirection;
  /** When true, detail stays inside a parent shell (resident profile) instead of a full-page header. */
  embeddedInResident?: boolean;
  buildPaymentDetailHref?: (row: DemoManagerPaymentLedgerRow) => string;
  onEmbeddedDetailActions?: (actions: ReactNode | null) => void;
  onEmbeddedBulkActions?: (actions: ReactNode | null) => void;
  /** Dashed footer row — opens the add-charge / add-payment flow. */
  onAddPayment?: () => void;
  groupMode?: PortalListGroupMode;
}) {
  const { showToast } = useAppUi();
  const displayScheduledMessages = useMemo(
    () => combineScheduledPaymentMessages(scheduledMessages),
    [scheduledMessages],
  );
  const clusterScheduledBadgeLabel = useCallback(
    (chargeIds: ReadonlySet<string>) =>
      scheduledSendBadgeLabel(
        summariseScheduledSends(scheduledMessagesTouchingCharges(displayScheduledMessages, chargeIds)),
      ),
    [displayScheduledMessages],
  );
  const [returningDepositId, setReturningDepositId] = useState<string | null>(null);
  const navigate = usePortalNavigate();
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [editAmountDraft, setEditAmountDraft] = useState("");
  const [editDueDateDraft, setEditDueDateDraft] = useState("");
  const [editNightsDraft, setEditNightsDraft] = useState("");
  const [sendingReminderId, setSendingReminderId] = useState<string | null>(null);
  const [reminderPreview, setReminderPreview] = useState<{ row: DemoManagerPaymentLedgerRow; subject: string; body: string } | null>(null);
  const [bulkReminderPreview, setBulkReminderPreview] = useState<BulkPaymentReminderPreviewItem[] | null>(null);
  const [chargeRemindersRow, setChargeRemindersRow] = useState<DemoManagerPaymentLedgerRow | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const selectedRows = useMemo(
    () => rows.filter((row) => selectedIds.has(row.id)),
    [rows, selectedIds],
  );
  const singleSelectedRow = selectedRows.length === 1 ? selectedRows[0]! : null;
  const remindableSelectedRows = useMemo(
    () => selectedRows.filter(isRemindableRow),
    [selectedRows],
  );
  const showSelection = !paymentIdProp;
  const rowIdsKey = useMemo(() => rows.map((row) => row.id).join(","), [rows]);
  const ledgerClusters = useMemo(
    () =>
      embeddedInResident
        ? []
        : clusterManagerPaymentLedgerRowsByMode(rows, groupMode),
    [embeddedInResident, groupMode, rows],
  );

  /**
   * A resident's own Payments tab groups by WHERE THE MONEY STANDS, not by
   * resident — there is only one. Grouping by anything else left every charge
   * in one undifferentiated list, so "what does this person still owe, and what
   * is late" had to be read off individual due dates.
   *
   * The rows arrive already sorted overdue → pending → paid, so the sections
   * follow that order and an empty one is omitted rather than rendering a
   * header over nothing.
   */
  const residentStatusSections = useMemo(() => {
    if (!embeddedInResident) return [];
    const order: { bucket: ManagerPaymentBucket; label: string }[] = [
      { bucket: "overdue", label: "Overdue" },
      { bucket: "pending", label: "Pending" },
      { bucket: "paid", label: "Paid" },
    ];
    return order
      .map(({ bucket, label }) => ({
        bucket,
        label,
        rows: rows.filter((row) => row.bucket === bucket),
      }))
      .filter((section) => section.rows.length > 0);
  }, [embeddedInResident, rows]);
  const detailRow = useMemo(() => {
    if (!paymentIdProp) return null;
    const decoded = decodeURIComponent(paymentIdProp);
    const aliases = new Set(legacyChargeIdAliases(decoded));
    return rows.find((row) => aliases.has(row.id)) ?? null;
  }, [paymentIdProp, rows]);

  const navigateToList = useCallback(() => {
    if (listBasePath) navigate(paymentListHref(listBasePath, direction, activeBucket));
  }, [activeBucket, direction, listBasePath, navigate]);

  const openPaymentDetail = useCallback(
    (row: DemoManagerPaymentLedgerRow) => {
      const paymentKey = publicChargeIdForUrl(row.id);
      if (buildPaymentDetailHref) {
        navigate(buildPaymentDetailHref({ ...row, id: paymentKey }));
        return;
      }
      if (listBasePath) navigate(paymentDetailHref(listBasePath, direction, activeBucket, paymentKey));
    },
    [activeBucket, buildPaymentDetailHref, direction, listBasePath, navigate],
  );

  useEffect(() => {
    setSelectedIds(new Set());
    setEditingRowId(null);
    setEditAmountDraft("");
    setEditDueDateDraft("");
    setEditNightsDraft("");
  }, [activeBucket, rowIdsKey]);

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleClusterSelection = (ids: readonly string[]) => {
    togglePortalListClusterSelection(setSelectedIds, ids);
  };

  const openChargeRemindersModal = (row: DemoManagerPaymentLedgerRow) => {
    if (!row.householdChargeId) {
      showToast("This payment has no charge id yet. Sync payments and try again.");
      return;
    }
    setChargeRemindersRow(row);
  };

  const markSelectedAsPaid = async () => {
    const targets = rows.filter((row) => selectedIds.has(row.id) && isMarkableAsPaid(row));
    if (targets.length === 0) return;
    let ok = 0;
    for (const row of targets) {
      if (row.householdChargeId) {
        if (markHouseholdChargePaid(row.householdChargeId, managerUserId)) {
          await cancelFutureRemindersForPaidCharge(row.householdChargeId, scheduledMessages).catch(() => undefined);
          ok += 1;
        }
      } else {
        markManagerPaymentLedgerPaid(row.id);
        ok += 1;
      }
    }
    setSelectedIds(new Set());
    onRowsChanged?.();
    onScheduleChanged?.();
    showToast(ok === 1 ? "Marked as paid." : `Marked ${ok} payments as paid.`);
  };

  const moveSelectedToPending = async () => {
    const targets = selectedRows;
    if (targets.length === 0) return;
    let ok = 0;
    for (const row of targets) {
      if (row.householdChargeId) {
        if (markHouseholdChargePending(row.householdChargeId, managerUserId)) ok += 1;
      } else {
        markManagerPaymentLedgerPending(row.id);
        ok += 1;
      }
    }
    onRowsChanged?.();
    onScheduleChanged?.();
    for (const row of targets) {
      if (!row.householdChargeId) continue;
      await restoreFutureRemindersForPendingCharge(row.householdChargeId).catch(() => undefined);
    }
    onScheduleChanged?.();
    setSelectedIds(new Set());
    showToast(ok === 1 ? "Moved to pending." : `Moved ${ok} payments to pending.`);
  };

  const deleteSelected = () => {
    const targets = selectedRows;
    if (targets.length === 0) return;
    if (!window.confirm(`Delete ${targets.length} payment${targets.length === 1 ? "" : "s"}?`)) return;
    let ok = 0;
    for (const row of targets) {
      if (row.householdChargeId) {
        if (deleteHouseholdCharge(row.householdChargeId, managerUserId)) ok += 1;
      } else if (deleteManagerPaymentLedgerEntry(row.id)) {
        ok += 1;
      }
    }
    setSelectedIds(new Set());
    onRowsChanged?.();
    showToast(ok === 1 ? "Payment removed." : `Removed ${ok} payments.`);
  };

  const startEdit = (row: DemoManagerPaymentLedgerRow) => {
    setEditingRowId(row.id);
    setEditAmountDraft(row.balanceDue.replace(/[^\d.]/g, ""));
    setEditDueDateDraft(dueDateDisplayToInputValue(row.dueDate));
    if (isStayTotalRow(row)) {
      const parsed = parseShortTermStayChargeTitle(row.chargeTitle);
      setEditNightsDraft(parsed ? String(parsed.nights) : "");
    } else {
      setEditNightsDraft("");
    }
  };

  const cancelEdit = () => {
    setEditingRowId(null);
    setEditAmountDraft("");
    setEditDueDateDraft("");
    setEditNightsDraft("");
  };

  const saveEdit = (row: DemoManagerPaymentLedgerRow) => {
    if (!row.householdChargeId) return;
    let amt = parseFloat(editAmountDraft.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(amt) || amt < 0) {
      showToast("Enter a valid amount.");
      return;
    }
    let title: string | undefined;
    if (isStayTotalRow(row)) {
      const parsed = parseShortTermStayChargeTitle(row.chargeTitle);
      const nights = parseInt(editNightsDraft.trim(), 10);
      if (!parsed) {
        showToast("Could not read this stay charge.");
        return;
      }
      if (!Number.isFinite(nights) || nights < 1) {
        showToast("Enter a valid number of nights.");
        return;
      }
      amt = shortTermStayTotalAmount(parsed.nightlyRate, nights);
      title = shortTermStayChargeTitle(nights, parsed.nightlyRate);
    }
    const dueLabel = editDueDateDraft.trim() ? dueDateInputToLabel(editDueDateDraft) : undefined;
    if (!dueLabel && editDueDateDraft.trim()) {
      showToast("Enter a valid due date.");
      return;
    }
    if (updateHouseholdChargeAmount(row.householdChargeId, amt, managerUserId, title, dueLabel)) {
      const email = row.residentEmail?.trim();
      if (email) {
        if (isStayTotalRow(row) && title) {
          const parsed = parseShortTermStayChargeTitle(title);
          if (parsed) {
            const leases = syncResidentAfterStayPaymentEdit({
              residentEmail: email,
              managerUserId,
              nights: parsed.nights,
              nightlyRate: parsed.nightlyRate,
            });
            showToast(leases > 0 ? "Payment and lease updated." : "Payment updated.");
          } else {
            void syncResidentBillingAndLeases({ residentEmail: email, managerUserId });
            showToast("Payment updated.");
          }
        } else {
          void syncResidentBillingAndLeases({ residentEmail: email, managerUserId });
          showToast("Payment updated.");
        }
      } else {
        showToast("Payment updated.");
      }
      onRowsChanged?.();
      onScheduleChanged?.();
    }
    cancelEdit();
  };

  const saveBulkEditAmount = () => {
    const row = singleSelectedRow;
    if (!row) return;
    saveEdit(row);
  };

  const renderAmountOwedCell = (row: DemoManagerPaymentLedgerRow) => {
    if (editingRowId === row.id && row.householdChargeId) {
      if (isStayTotalRow(row)) {
        const parsed = parseShortTermStayChargeTitle(row.chargeTitle);
        return (
          <span className="tabular-nums font-semibold text-foreground">
            ${shortTermStayTotalAmount(parsed?.nightlyRate ?? 0, parseInt(editNightsDraft, 10) || 0).toFixed(2)}
          </span>
        );
      }
      return (
        <span className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <span className="text-xs text-muted">$</span>
          <Input
            className="h-8 w-24 rounded-lg px-2 py-1 text-xs tabular-nums"
            inputMode="decimal"
            value={editAmountDraft}
            onChange={(e) => setEditAmountDraft(e.target.value)}
            aria-label="Amount owed"
          />
        </span>
      );
    }
    // Show the charge's FACE amount (what the charge is for), not the outstanding
    // balance — a paid charge's balance is $0.00, which made every Paid row read
    // "$0.00". Paid vs owed is conveyed by the status badge / bucket.
    return <span className="tabular-nums font-semibold text-foreground">{row.lineAmount}</span>;
  };

  const renderDueDateCell = (row: DemoManagerPaymentLedgerRow) => {
    if (editingRowId === row.id && row.householdChargeId) {
      return (
        <Input
          type="date"
          className="h-8 w-36 rounded-lg px-2 py-1 text-xs"
          value={editDueDateDraft}
          onChange={(e) => setEditDueDateDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          aria-label="Due date"
        />
      );
    }
    return <span className="block">{row.dueDate}</span>;
  };

  const buildReminderPreviewForRow = (row: DemoManagerPaymentLedgerRow): BulkPaymentReminderPreviewItem | null => {
    const chargeId = row.householdChargeId?.trim() || row.id?.trim();
    if (!chargeId) return null;
    const residentName = row.residentName || "Resident";
    const chargeTitle = row.chargeTitle || "outstanding charge";
    const subject = `Payment reminder: ${chargeTitle}`;
    const manualLines = buildManualPaymentInstructionLines({
      id: row.householdChargeId ?? row.id,
      paymentReference: row.paymentReference,
      zelleContactSnapshot: row.zelleContactSnapshot,
      venmoContactSnapshot: row.venmoContactSnapshot,
      balanceLabel: row.balanceDue,
      amountLabel: row.lineAmount,
    });
    const body = buildPaymentReminderBody({
      residentName,
      residentEmail: row.residentEmail?.trim(),
      chargeTitle,
      balanceDue: row.balanceDue,
      dueDate: row.dueDate,
      propertyLabel: row.propertyName,
      managerName: "Your property manager",
      manualPaymentLines: manualLines.length ? manualLines : undefined,
    });
    const chargeLabel = [chargeTitle, row.propertyName].filter(Boolean).join(" · ");
    return {
      id: row.id,
      recipient: paymentReminderRecipientLabel(row),
      chargeLabel,
      subject,
      body,
    };
  };

  const openReminderPreview = (row: DemoManagerPaymentLedgerRow) => {
    const preview = buildReminderPreviewForRow(row);
    if (!preview) {
      showToast("This payment is missing a charge id. Sync payments and try again.");
      return;
    }
    setReminderPreview({ row, subject: preview.subject, body: preview.body });
  };

  /**
   * ONE reminder per person, not one per charge.
   *
   * A resident with six outstanding charges got six separate messages, each
   * naming one of them — the same reminder six times over from their side, and
   * the review step made you page through six near-identical cards to send it.
   * Charges are grouped by recipient and a recipient with more than one gets a
   * single message itemising them with a total.
   *
   * The grouping key is the resident's email where there is one, because two
   * people can share a name and must never share a reminder; a row with no
   * email falls back to its own id, which groups with nothing.
   */
  const openBulkReminderPreview = () => {
    const targets = remindableSelectedRows;
    if (targets.length === 0) {
      showToast("Select unpaid charges to remind.");
      return;
    }

    const groups = new Map<string, DemoManagerPaymentLedgerRow[]>();
    for (const row of targets) {
      const key = row.residentEmail?.trim().toLowerCase() || `row:${row.id}`;
      const bucket = groups.get(key);
      if (bucket) bucket.push(row);
      else groups.set(key, [row]);
    }

    const items: BulkPaymentReminderPreviewItem[] = [];
    for (const rows of groups.values()) {
      const anchor = rows[0]!;
      if (rows.length === 1) {
        const preview = buildReminderPreviewForRow(anchor);
        if (preview) items.push(preview);
        continue;
      }
      const chargeId = anchor.householdChargeId?.trim() || anchor.id?.trim();
      if (!chargeId) continue;
      const residentName = anchor.residentName || "Resident";
      const charges = rows.map((row) => ({
        title: row.chargeTitle || "Outstanding charge",
        balanceDue: row.balanceDue,
        dueDate: row.dueDate,
      }));
      items.push({
        id: anchor.id,
        coveredRowIds: rows.map((row) => row.id),
        recipient: paymentReminderRecipientLabel(anchor),
        chargeLabel: `${rows.length} payments · ${anchor.propertyName}`,
        subject: `Payment reminder: ${rows.length} outstanding payments`,
        body: buildCombinedPaymentReminderBody({
          residentName,
          residentEmail: anchor.residentEmail?.trim(),
          charges,
          propertyLabel: anchor.propertyName,
          managerName: "Your property manager",
          totalLabel: sumPaymentBalanceLabels(rows.map((row) => row.balanceDue)),
        }),
      });
    }

    if (items.length === 0) {
      showToast("Selected payments are missing charge ids. Sync payments and try again.");
      return;
    }
    setBulkReminderPreview(items);
  };

  const sendReminderForRow = async (
    row: DemoManagerPaymentLedgerRow,
    channels?: { viaEmail?: boolean; viaSms?: boolean },
    draft?: { subject?: string; body?: string },
  ): Promise<{ ok: boolean; skipped?: boolean; chargePaid?: boolean; error?: string; emailSent?: boolean; smsSent?: boolean }> => {
    const chargeId = row.householdChargeId?.trim() || row.id?.trim();
    if (!chargeId) return { ok: false, error: "Missing charge id." };
    try {
      const res = await fetch("/api/portal/send-payment-reminder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        signal: AbortSignal.timeout(45_000),
        body: JSON.stringify({
          chargeId,
          viaEmail: channels?.viaEmail !== false,
          viaSms: channels?.viaSms === true,
          subject: draft?.subject?.trim() || undefined,
          text: draft?.body?.trim() || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        skipped?: boolean;
        code?: string;
        error?: string;
        emailSent?: boolean;
        smsSent?: boolean;
      };
      if (res.status === 409 && data.code === "charge_paid") {
        return { ok: false, chargePaid: true };
      }
      return {
        ok: Boolean(data.ok),
        skipped: data.skipped,
        error: data.error,
        emailSent: data.emailSent,
        smsSent: data.smsSent,
      };
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      return { ok: false, error: timedOut ? "Reminder request timed out." : "Network error." };
    }
  };

  const sendBulkReminders = async (
    targets: Array<
      | DemoManagerPaymentLedgerRow
      | { row: DemoManagerPaymentLedgerRow; subject: string; body: string }
    > = remindableSelectedRows,
  ) => {
    if (targets.length === 0) {
      showToast("Select unpaid charges to remind.");
      return;
    }
    setSendingReminderId("bulk");
    let ok = 0;
    let skipped = 0;
    let failed = 0;
    let lastError = "";
    try {
      for (const target of targets) {
        const row = "row" in target ? target.row : target;
        const draft = "row" in target ? { subject: target.subject, body: target.body } : undefined;
        // Bulk sends inbox + email only — SMS requires per-charge preview and channel pick.
        const result = await sendReminderForRow(row, { viaEmail: true, viaSms: false }, draft);
        if (result.chargePaid) continue;
        if (result.ok) {
          ok += 1;
          if (result.skipped) skipped += 1;
        } else {
          failed += 1;
          if (result.error) lastError = result.error;
        }
      }
    } finally {
      setSendingReminderId(null);
    }
    setSelectedIds(new Set());
    if (ok === 0) {
      showToast(lastError || "Could not send reminder. Please try again.");
      return;
    }
    if (failed > 0) {
      showToast(
        `Sent ${ok} reminder${ok === 1 ? "" : "s"}; ${failed} could not be sent${lastError ? `: ${lastError}` : "."}`,
      );
      return;
    }
    if (skipped === ok) {
      showToast(ok === 1 ? "Reminder saved to PropLane inbox." : `Sent ${ok} reminders to PropLane inbox.`);
    } else if (skipped > 0) {
      showToast(`Sent ${ok} reminder${ok === 1 ? "" : "s"} (${skipped} inbox-only).`);
    } else {
      showToast(ok === 1 ? "Reminder sent." : `Sent ${ok} reminders.`);
    }
  };

  const doSendReminder = async (
    skipMessage: boolean,
    channels?: { viaEmail?: boolean; viaSms?: boolean },
    draft?: { subject: string; body: string },
  ) => {
    if (!reminderPreview) return;
    if (skipMessage) {
      setReminderPreview(null);
      return;
    }
    const { row } = reminderPreview;
    setReminderPreview(null);
    setSendingReminderId(row.id);
    try {
      const result = await sendReminderForRow(row, channels, draft);
      if (result.chargePaid) {
        showToast("This charge is already paid. No reminder was sent.");
      } else if (result.ok) {
        const parts: string[] = ["PropLane inbox"];
        if (result.emailSent) parts.push("email");
        if (result.smsSent) parts.push("Messages");
        showToast(
          result.skipped
            ? "Reminder saved to PropLane inbox."
            : `Reminder sent via ${parts.join(" + ")}.`,
        );
      } else {
        showToast(result.error || "Could not send reminder. Please try again.");
      }
    } finally {
      setSendingReminderId(null);
    }
  };

  const hasAnySource = useMemo(() => rows.length > 0, [rows]);
  // Visible label stays the uniform "Add"; the accessible name says which one,
  // so a screen reader is not given two identically-named buttons.
  const addPaymentLabel = "Add";
  const addPaymentAriaLabel = embeddedInResident ? "Add payment" : "Add charge";
  const renderStayNightsCell = (row: DemoManagerPaymentLedgerRow) => {
    if (editingRowId !== row.id || !row.householdChargeId || !isStayTotalRow(row)) return null;
    const parsed = parseShortTermStayChargeTitle(row.chargeTitle);
    return (
      <div onClick={(e) => e.stopPropagation()}>
        <p className="text-xs font-medium text-muted">Nights</p>
        <Input
          className="mt-1 h-8 w-24 rounded-lg px-2 py-1 text-xs tabular-nums"
          inputMode="numeric"
          value={editNightsDraft}
          onChange={(e) => {
            const next = e.target.value.replace(/[^\d]/g, "");
            setEditNightsDraft(next);
            if (parsed && next) {
              const nights = parseInt(next, 10);
              if (Number.isFinite(nights) && nights >= 1) {
                setEditAmountDraft(shortTermStayTotalAmount(parsed.nightlyRate, nights).toFixed(2));
              }
            }
          }}
          aria-label="Number of nights"
        />
        {parsed ? (
          <p className="mt-1 text-xs text-muted">
            {parsed.nightlyRate % 1 === 0 ? `$${parsed.nightlyRate}` : `$${parsed.nightlyRate.toFixed(2)}`} / night
          </p>
        ) : null}
      </div>
    );
  };

  const renderPaymentDetailPanel = (row: DemoManagerPaymentLedgerRow) => {
    const roomLabel = formatLedgerRoomLabel(row.roomNumber);
    return (
      <div className="space-y-4 px-3 py-2 text-sm sm:px-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-xs font-medium text-muted">Property</p>
            <p className="text-foreground">{row.propertyName}</p>
          </div>
          {roomLabel ? (
            <div>
              <p className="text-xs font-medium text-muted">Room</p>
              <p className="text-foreground">{roomLabel}</p>
            </div>
          ) : null}
          <div>
            <p className="text-xs font-medium text-muted">Status</p>
            <p className="font-medium text-foreground">{row.statusLabel}</p>
          </div>
          <div className="sm:col-span-2">
            <p className="text-xs font-medium text-muted">Charge</p>
            {editingRowId === row.id && isStayTotalRow(row) ? (
              renderStayNightsCell(row)
            ) : (
              <p className="text-foreground">{row.chargeTitle}</p>
            )}
          </div>
          <div>
            <p className="text-xs font-medium text-muted">Due date</p>
            <div className="text-foreground">{renderDueDateCell(row)}</div>
          </div>
          <div>
            <p className="text-xs font-medium text-muted">Amount</p>
            <div className="text-foreground">{renderAmountOwedCell(row)}</div>
          </div>
          <div>
            <p className="text-xs font-medium text-muted">Balance due</p>
            <p className="font-semibold tabular-nums text-foreground">{row.balanceDue}</p>
          </div>
        </div>
        {/*
          Every reminder still queued for this charge, with its send time. The header badge says
          THAT something is coming; a manager on the detail page deciding whether to chase needs to
          know WHEN, and what kind.
        */}
        {(() => {
          // `householdChargeId` is optional on a ledger row; without it there is no charge to
          // match reminders against, so there is nothing to show rather than everything.
          if (!row.householdChargeId) return null;
          const reminders = manageableRemindersForCharge(displayScheduledMessages, row.householdChargeId)
            .filter((message) => message.status === "scheduled")
            .filter((message) => Date.parse(message.sendAt) > Date.now());
          if (reminders.length === 0) return null;
          return (
            <div data-attr="payment-detail-scheduled-reminders">
              <p className="text-xs font-medium text-muted">
                {reminders.length === 1 ? "Scheduled reminder" : "Scheduled reminders"}
              </p>
              <ul className="mt-1 space-y-1">
                {reminders.map((message) => {
                  const bundledCount = message.bundledChargeIds?.length ?? 0;
                  return (
                    <li key={message.id} className="text-foreground">
                      {formatScheduledSendAt(message.sendAt)}
                      <span className="text-muted"> · {message.typeLabel}</span>
                      {bundledCount > 1 ? (
                        <span className="text-muted"> · {bundledCount} charges in one email</span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })()}
        {row.notes ? (
          <div>
            <p className="text-xs font-medium text-muted">Details</p>
            <p className="leading-relaxed text-foreground/90">{row.notes}</p>
          </div>
        ) : null}
        {(row.residentChargeMessages?.length ?? 0) > 0 ? (
          <div className="rounded-xl border border-amber-300/60 bg-amber-50 px-4 py-3 dark:bg-amber-950/20">
            <p className="text-xs font-semibold text-foreground">Resident message</p>
            <ul className="mt-2 space-y-3">
              {row.residentChargeMessages!.map((entry) => (
                <li key={entry.id}>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{entry.body}</p>
                  <p className="mt-1 text-xs text-muted">{formatPacificDateTime(entry.sentAt)}</p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    );
  };

  const doSendBulkReminders = async () => {
    if (!bulkReminderPreview?.length) return;
    // One send per PREVIEW CARD, not per charge: a combined card is one message
    // that already names every charge it covers, so sending its rows
    // individually would put the resident back where they started.
    const items = bulkReminderPreview;
    const byId = new Map(remindableSelectedRows.map((row) => [row.id, row]));
    const sends = items
      .map((item) => {
        const row = byId.get(item.id);
        return row ? { row, subject: item.subject, body: item.body } : null;
      })
      .filter((entry): entry is { row: DemoManagerPaymentLedgerRow; subject: string; body: string } =>
        Boolean(entry),
      );
    setBulkReminderPreview(null);
    await sendBulkReminders(sends);
  };

  const recordPaid = async (row: DemoManagerPaymentLedgerRow, toastMessage: string) => {
    if (row.householdChargeId) {
      if (markHouseholdChargePaid(row.householdChargeId, managerUserId)) {
        await cancelFutureRemindersForPaidCharge(row.householdChargeId, scheduledMessages).catch(() => undefined);
        showToast(toastMessage);
        navigateToList();
        onRowsChanged?.();
        onScheduleChanged?.();
        return;
      }
      showToast("Could not update this line.");
      return;
    }
    markManagerPaymentLedgerPaid(row.id);
    showToast(toastMessage);
    navigateToList();
    onRowsChanged?.();
  };

  const removePayment = (row: DemoManagerPaymentLedgerRow) => {
    if (!window.confirm(`Delete "${row.chargeTitle}" for ${row.residentName}?`)) return;
    if (row.householdChargeId) {
      if (deleteHouseholdCharge(row.householdChargeId, managerUserId)) {
        showToast("Payment removed.");
        navigateToList();
        onRowsChanged?.();
        return;
      }
      showToast("Could not remove this line.");
      return;
    }
    if (deleteManagerPaymentLedgerEntry(row.id)) {
      showToast("Payment removed.");
      navigateToList();
      onRowsChanged?.();
      return;
    }
    showToast("Could not remove this line.");
  };

  const moveToPending = async (row: DemoManagerPaymentLedgerRow) => {
    if (row.householdChargeId) {
      if (markHouseholdChargePending(row.householdChargeId, managerUserId)) {
        onRowsChanged?.();
        onScheduleChanged?.();
        await restoreFutureRemindersForPendingCharge(row.householdChargeId).catch(() => undefined);
        onScheduleChanged?.();
        showToast("Moved to pending.");
        navigateToList();
        return;
      }
      showToast("Could not update this line.");
      return;
    }
    markManagerPaymentLedgerPending(row.id);
    showToast("Moved to pending.");
    navigateToList();
    onRowsChanged?.();
  };

  const renderDetailActions = (row: DemoManagerPaymentLedgerRow) => {
    const canEdit = Boolean(row.householdChargeId && !isPaidRow(row));
    const editing = canEdit && editingRowId === row.id;
    const showSendReminder = !isPaidRow(row);
    const showMoveToPending = activeBucket === "paid";
    const btnClass = RESIDENT_DETAIL_HEADER_ACTION_BTN;

    const markPaidButton =
      !editing && row.statusLabel !== "Paid" && row.balanceDue !== "$0.00" ? (
        <Button type="button" variant="outline" className={btnClass} onClick={() => recordPaid(row, "Marked as paid.")}>
          Mark as paid
        </Button>
      ) : null;

    const editButtons = canEdit ? (
      editing ? (
        <>
          <Button type="button" variant="outline" className={btnClass} onClick={() => saveEdit(row)}>
            Save
          </Button>
          <Button type="button" variant="outline" className={btnClass} onClick={() => cancelEdit()}>
            Cancel
          </Button>
        </>
      ) : (
        <Button type="button" variant="outline" className={btnClass} onClick={() => startEdit(row)}>
          Edit
        </Button>
      )
    ) : null;

    const sendReminderButton = showSendReminder ? (
      <Button
        type="button"
        variant="outline"
        className={btnClass}
        disabled={sendingReminderId === row.id}
        data-attr="payments-send-reminder"
        onClick={() => openReminderPreview(row)}
      >
        {sendingReminderId === row.id ? "Sending…" : "Send reminder"}
      </Button>
    ) : null;

    const moveToPendingButton = showMoveToPending ? (
      <Button
        type="button"
        variant="outline"
        className={btnClass}
        data-attr="payments-move-pending"
        onClick={() => moveToPending(row)}
      >
        Move to pending
      </Button>
    ) : null;

    const mobileOverflowMenu =
      !editing ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              className={`${btnClass} max-md:px-2.5 max-md:text-base`}
              data-attr="payment-more-actions"
              aria-label="More payment actions"
            >
              …
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" backdrop>
            {showSendReminder ? (
              <DropdownMenuItem
                data-attr="payments-send-reminder"
                disabled={sendingReminderId === row.id}
                onSelect={() => openReminderPreview(row)}
              >
                {sendingReminderId === row.id ? "Sending…" : "Send reminder"}
              </DropdownMenuItem>
            ) : null}
            {showMoveToPending ? (
              <DropdownMenuItem data-attr="payments-move-pending" onSelect={() => void moveToPending(row)}>
                Move to pending
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null;

    return (
      <>
        <div className="flex max-w-full flex-nowrap items-center gap-1 md:hidden">
          {markPaidButton}
          {editButtons}
          {mobileOverflowMenu}
        </div>
        <div className="hidden max-w-full flex-nowrap items-center gap-1 md:flex">
          {markPaidButton}
          {editButtons}
          {sendReminderButton}
          {moveToPendingButton}
        </div>
      </>
    );
  };

  useEffect(() => {
    if (!embeddedInResident || !onEmbeddedDetailActions) return;
    if (!paymentIdProp || !detailRow) {
      onEmbeddedDetailActions(null);
      return;
    }
    onEmbeddedDetailActions(renderDetailActions(detailRow));
  }, [
    embeddedInResident,
    onEmbeddedDetailActions,
    paymentIdProp,
    detailRow,
    editingRowId,
    sendingReminderId,
    activeBucket,
  ]);

  const bulkActionsSignature = useMemo(() => {
    if (selectedIds.size === 0) return "";
    const selectedIdList = [...selectedIds].sort().join(",");
    const meta = [
      activeBucket,
      editingRowId ?? "",
      sendingReminderId ?? "",
      singleSelectedRow?.id ?? "",
      singleSelectedRow?.householdChargeId ?? "",
      remindableSelectedRows.length,
      selectedRows.some(isMarkableAsPaid) ? "1" : "0",
      selectedRows.some((row) => !isPaidRow(row)) ? "1" : "0",
      activeBucket === "paid" && selectedRows.length > 0 ? "1" : "0",
      singleSelectedRow && !isPaidRow(singleSelectedRow) ? "1" : "0",
      editingRowId === singleSelectedRow?.id ? "1" : "0",
    ].join("|");
    return `${selectedIdList}|${meta}`;
  }, [
    selectedIds,
    activeBucket,
    editingRowId,
    sendingReminderId,
    singleSelectedRow,
    remindableSelectedRows.length,
    selectedRows,
  ]);

  const bulkSelectionActions = useMemo(() => {
    if (selectedIds.size === 0) return null;

    const actions: PortalAdaptiveAction[] = [];

    if (selectedRows.some(isMarkableAsPaid)) {
      actions.push({
        id: "mark-paid",
        keepPriority: 5,
        node: (
          <Button
            type="button"
            variant="outline"
            className={PAYMENTS_BULK_BAR_BTN}
            data-attr="payments-mark-selected-paid"
            onClick={markSelectedAsPaid}
          >
            Mark as paid
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem data-attr="payments-mark-selected-paid" onSelect={markSelectedAsPaid}>
            Mark as paid
          </DropdownMenuItem>
        ),
      });
    }

    const returnableDeposits = selectedRows.filter(isReturnableDepositRow);
    if (returnableDeposits.length === 1) {
      const row = returnableDeposits[0]!;
      const returnDeposit = async () => {
        // One deposit at a time and confirmed first: this sends real money and Stripe will not
        // un-refund it. A bulk version would make a mis-click expensive in a way no undo covers.
        if (!window.confirm(`Return the security deposit to ${row.residentName}? This cannot be undone.`)) {
          return;
        }
        setReturningDepositId(row.householdChargeId ?? row.id);
        try {
          const res = await fetch("/api/portal/deposit-return", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // Only the id — the server re-reads the amount, what was already returned, and the
            // payment to refund against, because each of those decides how much money moves.
            body: JSON.stringify({ chargeId: row.householdChargeId }),
          });
          const data = (await res.json().catch(() => ({}))) as { error?: string; remainingCents?: number };
          if (!res.ok) {
            showToast(data.error || "Could not return the deposit.");
            return;
          }
          showToast(
            data.remainingCents
              ? "Deposit partially returned."
              : `Deposit returned to ${row.residentName}.`,
          );
          setSelectedIds(new Set());
          onRowsChanged?.();
        } catch {
          showToast("Could not return the deposit.");
        } finally {
          setReturningDepositId(null);
        }
      };
      actions.push({
        id: "return-deposit",
        keepPriority: 5,
        node: (
          <Button
            type="button"
            variant="outline"
            className={PAYMENTS_BULK_BAR_BTN}
            disabled={Boolean(returningDepositId)}
            data-attr="payments-return-deposit"
            onClick={() => returnDeposit()}
          >
            {returningDepositId ? "Returning…" : "Return deposit"}
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem data-attr="payments-return-deposit" onSelect={() => void returnDeposit()}>
            Return deposit
          </DropdownMenuItem>
        ),
      });
    }

    if (selectedRows.some((row) => !isPaidRow(row))) {
      const sendReminder = () => {
        if (remindableSelectedRows.length === 1) {
          openReminderPreview(remindableSelectedRows[0]!);
          return;
        }
        openBulkReminderPreview();
      };
      actions.push({
        id: "send-reminder",
        keepPriority: 4,
        node: (
          <Button
            type="button"
            variant="outline"
            className={PAYMENTS_BULK_BAR_BTN}
            disabled={Boolean(sendingReminderId) || remindableSelectedRows.length === 0}
            data-attr="payments-send-reminder"
            title={
              remindableSelectedRows.length === 0
                ? "Select at least one unpaid charge."
                : undefined
            }
            onClick={sendReminder}
          >
            {sendingReminderId ? "Sending…" : "Send reminder"}
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem
            data-attr="payments-send-reminder"
            disabled={Boolean(sendingReminderId) || remindableSelectedRows.length === 0}
            onSelect={sendReminder}
          >
            {sendingReminderId ? "Sending…" : "Send reminder"}
          </DropdownMenuItem>
        ),
      });
    }

    if (activeBucket === "paid" && selectedRows.length > 0) {
      actions.push({
        id: "move-pending",
        keepPriority: 3,
        node: (
          <Button
            type="button"
            variant="outline"
            className={PAYMENTS_BULK_BAR_BTN}
            onClick={moveSelectedToPending}
          >
            Move to pending
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem onSelect={moveSelectedToPending}>Move to pending</DropdownMenuItem>
        ),
      });
    }

    if (singleSelectedRow?.householdChargeId && !isPaidRow(singleSelectedRow)) {
      if (editingRowId === singleSelectedRow.id) {
        actions.push({
          id: "save-edit",
          keepPriority: 3,
          node: (
            <Button
              type="button"
              variant="outline"
              className={PAYMENTS_BULK_BAR_BTN}
              onClick={saveBulkEditAmount}
            >
              Save
            </Button>
          ),
          menuItem: (
            <DropdownMenuItem onSelect={saveBulkEditAmount}>Save</DropdownMenuItem>
          ),
        });
      } else {
        actions.push({
          id: "edit",
          keepPriority: 2,
          node: (
            <Button
              type="button"
              variant="outline"
              className={PAYMENTS_BULK_BAR_BTN}
              onClick={() => startEdit(singleSelectedRow)}
            >
              Edit
            </Button>
          ),
          menuItem: <DropdownMenuItem onSelect={() => startEdit(singleSelectedRow)}>Edit</DropdownMenuItem>,
        });
      }
    }

    actions.push({
      id: "delete",
      keepPriority: 0,
      node: (
        <Button
          type="button"
          variant="outline"
          className={PAYMENTS_BULK_BAR_BTN}
          onClick={deleteSelected}
        >
          Delete
        </Button>
      ),
      menuItem: <DropdownMenuItem onSelect={deleteSelected}>Delete</DropdownMenuItem>,
    });

    return (
      <PortalAdaptiveActionRow
        actions={actions}
        moreAriaLabel="More bulk actions"
        moreDataAttr="payments-bulk-more-actions"
        moreButtonClassName={PAYMENTS_BULK_MORE_BTN}
        gapPx={4}
      />
    );
  }, [
    activeBucket,
    deleteSelected,
    editingRowId,
    markSelectedAsPaid,
    moveSelectedToPending,
    openBulkReminderPreview,
    openReminderPreview,
    remindableSelectedRows,
    saveBulkEditAmount,
    selectedIds.size,
    selectedRows,
    sendingReminderId,
    singleSelectedRow,
    startEdit,
  ]);

  // Assigned in a LAYOUT effect, not during render: a render-phase ref write is unsafe under
  // concurrent rendering. It has to be `useLayoutEffect` rather than `useEffect` because the
  // consumer below is one too, and layout effects run in declaration order — a plain effect
  // here would land after the consumer and feed it the previous render's values.
  const bulkSelectionActionsRef = useRef<ReactNode>(null);
  const publishedBulkSignatureRef = useRef<string | null>(null);
  const onEmbeddedBulkActionsRef = useRef(onEmbeddedBulkActions);
  useLayoutEffect(() => {
    bulkSelectionActionsRef.current = bulkSelectionActions;
    onEmbeddedBulkActionsRef.current = onEmbeddedBulkActions;
  });

  useLayoutEffect(() => {
    const notify = onEmbeddedBulkActionsRef.current;
    if (!embeddedInResident || !notify) return;

    const signature = bulkActionsSignature || "__empty__";
    if (publishedBulkSignatureRef.current === signature) return;
    publishedBulkSignatureRef.current = signature;

    notify(bulkActionsSignature ? bulkSelectionActionsRef.current : null);
  }, [bulkActionsSignature, embeddedInResident]);

  useEffect(() => {
    if (!embeddedInResident) {
      publishedBulkSignatureRef.current = null;
      onEmbeddedBulkActionsRef.current?.(null);
    }
    return () => {
      publishedBulkSignatureRef.current = null;
      onEmbeddedBulkActionsRef.current?.(null);
    };
  }, [embeddedInResident]);

  const renderInlineEditForm = (row: DemoManagerPaymentLedgerRow) => (
    <div
      className="border-b border-border/50 bg-accent/15 px-3 py-3 max-md:px-2.5"
      onClick={(e) => e.stopPropagation()}
    >
      <p className="text-sm font-semibold text-foreground">{row.residentName}</p>
      <p className="text-xs text-muted">
        {isStayTotalRow(row) && editingRowId === row.id
          ? shortTermStayChargeTitle(
              parseInt(editNightsDraft, 10) || parseShortTermStayChargeTitle(row.chargeTitle)?.nights || 0,
              parseShortTermStayChargeTitle(row.chargeTitle)?.nightlyRate ?? 0,
            )
          : row.chargeTitle}
      </p>
      <p className="mt-0.5 text-xs text-muted">
        {[row.propertyName, formatLedgerRoomLabel(row.roomNumber)].filter(Boolean).join(" · ")}
      </p>
      <div className="mt-3 grid grid-cols-2 gap-3">
        {isStayTotalRow(row) ? (
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted">
              Nights
            </label>
            <Input
              className="h-9 w-full rounded-lg px-2 py-1 text-sm tabular-nums"
              inputMode="numeric"
              value={editNightsDraft}
              onChange={(e) => {
                const next = e.target.value.replace(/[^\d]/g, "");
                setEditNightsDraft(next);
                const parsed = parseShortTermStayChargeTitle(row.chargeTitle);
                if (parsed && next) {
                  const nights = parseInt(next, 10);
                  if (Number.isFinite(nights) && nights >= 1) {
                    setEditAmountDraft(shortTermStayTotalAmount(parsed.nightlyRate, nights).toFixed(2));
                  }
                }
              }}
              aria-label="Number of nights"
            />
          </div>
        ) : (
          <div>
            <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted">
              Amount
            </label>
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted">$</span>
              <Input
                className="h-9 w-full rounded-lg px-2 py-1 text-sm tabular-nums"
                inputMode="decimal"
                value={editAmountDraft}
                onChange={(e) => setEditAmountDraft(e.target.value)}
                aria-label="Amount owed"
              />
            </div>
          </div>
        )}
        <div>
          <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted">
            Due date
          </label>
          <Input
            type="date"
            className="h-9 w-full rounded-lg px-2 py-1 text-sm"
            value={editDueDateDraft}
            onChange={(e) => setEditDueDateDraft(e.target.value)}
            aria-label="Due date"
          />
        </div>
      </div>
    </div>
  );

  const chargeListColumns = [
    { id: "charge", header: "Charge", cell: (row: DemoManagerPaymentLedgerRow) => ledgerRowPrimaryLabel(row) },
    { id: "property", header: "Property", cell: (row: DemoManagerPaymentLedgerRow) => ledgerRowPropertyLine(row) },
    { id: "due", header: "Due", cell: (row: DemoManagerPaymentLedgerRow) => row.dueDate || "—" },
    {
      id: "amount",
      header: "Amount",
      cell: (row: DemoManagerPaymentLedgerRow) => row.lineAmount,
      headerClassName: "text-right",
      cellClassName: "text-right tabular-nums",
    },
  ] as const;

  const renderChargeDataList = (
    listRows: DemoManagerPaymentLedgerRow[],
    options?: { omitPropertyInMeta?: boolean },
  ) => (
    <DataList
      hideColumnHeaders
      selectable={showSelection}
      rows={listRows.map((row) => {
        const isEditing = editingRowId === row.id && Boolean(row.householdChargeId);
        return {
          id: row.id,
          data: row,
          primary: ledgerRowPrimaryLabel(row),
          meta: ledgerRowMetaLine(row, displayScheduledMessages, {
            includeProperty: !options?.omitPropertyInMeta,
            includeReminder: false,
          }),
          leading: (
            <PaymentScheduledMessagesLead
              row={row}
              scheduledMessages={displayScheduledMessages}
              onOpenReminders={openChargeRemindersModal}
            />
          ),
          trailing: (
            <span className="text-sm font-semibold tabular-nums text-foreground">{row.lineAmount}</span>
          ),
          selected: showSelection ? selectedIds.has(row.id) : undefined,
          onSelectedChange:
            showSelection ? () => toggleSelected(row.id) : undefined,
          onClick: isEditing ? undefined : () => openPaymentDetail(row),
          expanded: isEditing,
          expandedContent: isEditing ? renderInlineEditForm(row) : undefined,
        };
      })}
      columns={[...chargeListColumns]}
    />
  );

  const renderResidentStatusSections = () => {
    // One section only (or none) reads better as the plain list it already was.
    if (residentStatusSections.length <= 1) return renderChargeDataList(rows);
    return (
      <div className="space-y-4" data-attr="payments-resident-status-sections">
        {residentStatusSections.map((section) => (
          <div key={section.bucket} data-attr={`payments-status-section-${section.bucket}`}>
            <div className="mb-1.5 flex items-baseline gap-2 px-1">
              <span
                className={`text-xs font-semibold uppercase tracking-wide ${
                  section.bucket === "overdue" ? "text-danger" : "text-muted"
                }`}
              >
                {section.label}
              </span>
              <span className="text-xs text-muted tabular-nums">{section.rows.length}</span>
            </div>
            {renderChargeDataList(section.rows)}
          </div>
        ))}
      </div>
    );
  };

  const renderManagerGroupedLedger = () => (
    <div
      className="space-y-3"
      data-attr={groupMode === "house" ? "payments-house-groups" : "payments-resident-groups"}
    >
      {isPropertyClusterList(groupMode, ledgerClusters)
        ? (ledgerClusters as ManagerPaymentPropertyCluster[]).map((cluster) => (
            <ApplicationHouseholdCluster
              key={cluster.key}
              headerLeading={
                showSelection ? (
                  <PortalListClusterSelectCheckbox
                    ids={cluster.rows.map((row) => row.id)}
                    selectedIds={selectedIds}
                    onToggleCluster={toggleClusterSelection}
                    ariaLabel={`Select all charges for ${cluster.propertyLabel}`}
                  />
                ) : null
              }
              header={
                <>
                  <span className="truncate text-xs font-semibold text-foreground">
                    {cluster.propertyLabel}
                  </span>
                  <Badge tone="info">
                    {cluster.rows.length === 1 ? "1 charge" : `${cluster.rows.length} charges`}
                  </Badge>
                  {(() => {
                    const chargeIds = new Set(
                      cluster.rows
                        .map((row) => row.householdChargeId)
                        .filter((id): id is string => Boolean(id)),
                    );
                    const label = clusterScheduledBadgeLabel(chargeIds);
                    return label ? (
                      <Badge tone="pending">
                        <span data-attr="payments-cluster-scheduled">{label}</span>
                      </Badge>
                    ) : null;
                  })()}
                </>
              }
            >
              {renderChargeDataList(cluster.rows, { omitPropertyInMeta: true })}
            </ApplicationHouseholdCluster>
          ))
        : (ledgerClusters as ManagerPaymentResidentCluster[]).map((cluster) => (
            <ApplicationHouseholdCluster
              key={cluster.key}
              headerLeading={
                showSelection ? (
                  <PortalListClusterSelectCheckbox
                    ids={cluster.rows.map((row) => row.id)}
                    selectedIds={selectedIds}
                    onToggleCluster={toggleClusterSelection}
                    ariaLabel={`Select all charges for ${cluster.residentLabel}`}
                  />
                ) : null
              }
              header={
                <>
                  <span className="truncate text-xs font-semibold text-foreground">{cluster.residentLabel}</span>
                  {cluster.residentEmail &&
                  cluster.residentEmail.toLowerCase() !== cluster.residentLabel.trim().toLowerCase() ? (
                    <span className="truncate text-xs text-muted">{cluster.residentEmail}</span>
                  ) : null}
                  {cluster.propertyLabel ? (
                    <span className="truncate text-xs text-muted">{cluster.propertyLabel}</span>
                  ) : null}
                  <Badge tone="info">
                    {cluster.rows.length === 1 ? "1 charge" : `${cluster.rows.length} charges`}
                  </Badge>
                  {(() => {
                    const chargeIds = new Set(
                      cluster.rows
                        .map((row) => row.householdChargeId)
                        .filter((id): id is string => Boolean(id)),
                    );
                    const label = clusterScheduledBadgeLabel(chargeIds);
                    return label ? (
                      <Badge tone="pending">
                        <span data-attr="payments-cluster-scheduled">{label}</span>
                      </Badge>
                    ) : null;
                  })()}
                </>
              }
            >
              {renderChargeDataList(cluster.rows, { omitPropertyInMeta: true })}
            </ApplicationHouseholdCluster>
          ))}
    </div>
  );

  return (
    <>
    {reminderPreview && (
      <PortalNotificationPreviewModal
        open
        title="Send payment reminder"
        onClose={() => setReminderPreview(null)}
        recipient={paymentReminderRecipientLabel(reminderPreview.row)}
        subject={reminderPreview.subject}
        body={reminderPreview.body}
        showSkipMessage={false}
        showChannelPicker
        emailAvailable={Boolean(reminderPreview.row.residentEmail?.includes("@"))}
        smsAvailable
        deliverViaKind="payment_reminder"
        confirmLabel="Send reminder"
        confirmBusy={sendingReminderId === reminderPreview.row.id}
        confirmBusyLabel="Sending…"
        onConfirm={(skipMessage, channels, draft) => void doSendReminder(skipMessage, channels, draft)}
      />
    )}
    {bulkReminderPreview && bulkReminderPreview.length > 0 ? (
      <PortalBulkMessageReadonlyCarouselModal
        open
        title={
          bulkReminderPreview.length === 1
            ? "Send payment reminder"
            : `Send ${bulkReminderPreview.length} payment reminders`
        }
        intro="Review each message below. Reminders are saved to PropLane inbox and sent by email when an address is on file."
        items={bulkReminderPreview.map((item) => ({
          id: item.id,
          label: item.chargeLabel,
          recipient: item.recipient,
          subject: item.subject,
          body: item.body,
        }))}
        confirmLabel={
          bulkReminderPreview.length === 1
            ? "Send reminder"
            : `Send ${bulkReminderPreview.length} reminders`
        }
        onClose={() => setBulkReminderPreview(null)}
        confirmBusy={sendingReminderId === "bulk"}
        onConfirm={() => void doSendBulkReminders()}
      />
    ) : null}
    {chargeRemindersRow ? (
      <ChargeRemindersModal
        open
        onClose={() => setChargeRemindersRow(null)}
        residentName={chargeRemindersRow.residentName}
        chargeTitle={chargeRemindersRow.chargeTitle}
        dueDate={chargeRemindersRow.dueDate ?? "—"}
        messages={manageableRemindersForCharge(
          scheduledMessages,
          chargeRemindersRow.householdChargeId ?? "",
          24,
        )}
        scheduleSummary={reminderScheduleSummary}
        onMessageSaved={() => {
          onScheduleChanged?.();
        }}
        onToggleCancel={async (message, cancelled) => {
          await patchScheduledMessage(message.id, { cancelled });
        }}
        onOpenSettings={onOpenReminderSettings}
      />
    ) : null}
    {paymentIdProp && detailRow ? (
      embeddedInResident ? (
        renderPaymentDetailPanel(detailRow)
      ) : (
      <PortalRecordDetailPage
        pageTitle="Payments"
        title={detailRow.residentName}
        subtitle={detailRow.chargeTitle}
        avatarName={detailRow.residentName}
        backHref={listBasePath ? paymentListHref(listBasePath, direction, activeBucket) : "#"}
        backLabel="Back to payments"
        hideBackText
        bareHeader
        dataAttrBack="payment-detail-back"
        footerOmitSpacer
        footer={renderDetailActions(detailRow)}
      >
        {/*
          The actions dock at the bottom rather than sitting in the header.
          Every other detail page in the portal puts them there, and on a
          payment the manager reads the amount and the schedule first — the
          decision belongs after what it is based on, not above it.
        */}
        {renderPaymentDetailPanel(detailRow)}
      </PortalRecordDetailPage>
      )
    ) : !hasAnySource ? (
      onAddPayment ? (
        <PortalRecordListSurface
          isEmpty
          add={{
            label: embeddedInResident ? "Add payment" : addPaymentLabel,
            ariaLabel: addPaymentAriaLabel,
            icon: PORTAL_LIST_ADD_ICONS.payment,
            onClick: onAddPayment,
            dataAttr: "payments-list-add",
            ...(embeddedInResident ? { inline: false } : {}),
          }}
          className="pt-5 sm:pt-6"
          dataAttr="payments-list-empty"
        />
      ) : (
        <PortalDataTableEmpty message="No payments in this bucket yet." icon="payment" />
      )
    ) : (
      <PortalRecordListSurface
        add={
          onAddPayment
            ? {
                label: embeddedInResident ? "Add payment" : addPaymentLabel,
                ariaLabel: addPaymentAriaLabel,
                icon: PORTAL_LIST_ADD_ICONS.payment,
                onClick: onAddPayment,
                dataAttr: "payments-list-add",
                // Resident profile matches Services: full dashed ADD footer, not the
                // compact inline strip used on the main Payments ledger when rows exist.
                ...(embeddedInResident ? { inline: false } : {}),
              }
            : undefined
        }
        bulkCount={embeddedInResident ? 0 : selectedIds.size}
        bulkActions={embeddedInResident ? undefined : bulkSelectionActions}
        dataAttr="payments-ledger-list"
      >
        {embeddedInResident ? renderResidentStatusSections() : renderManagerGroupedLedger()}
      </PortalRecordListSurface>
    )}
    </>
  );
}
