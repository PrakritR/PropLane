"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, CheckCircle2, Pencil, Trash2, XCircle } from "lucide-react";
import { Input, Textarea } from "@/components/ui/input";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  PortalTableDetailActions,
} from "@/components/portal/portal-data-table";
import {
  PortalNotificationPreviewModal,
  type NotificationConfirmDraft,
  type NotificationDeliveryChannels,
} from "@/components/portal/portal-notification-preview-modal";
import { ConfirmDeleteModal } from "@/components/portal/confirm-delete-modal";
import { sanitizeMoneyInput } from "@/lib/listing-form-inputs";
import { deliverPortalInboxMessage } from "@/lib/portal-message-delivery";
import {
  buildServiceRequestApprovedNotice,
  buildServiceRequestDeniedNotice,
} from "@/lib/resident-service-notices";
import {
  approveServiceRequest,
  attachProposedVisitToServiceRequest,
  deleteServiceRequest,
  denyServiceRequest,
  updateServiceRequest,
  type ServiceRequest,
} from "@/lib/service-requests-storage";
import { useWorkAssignmentDirectory } from "@/hooks/use-work-assignment-directory";
import {
  createScheduledWorkTask,
  scheduledTaskTitleForService,
} from "@/lib/manager-scheduled-work-tasks";

export type ManagerServiceRequestBucket = "pending" | "approved" | "denied";

export function managerServiceRequestBucket(status: ServiceRequest["status"]): ManagerServiceRequestBucket {
  if (status === "pending") return "pending";
  if (status === "denied") return "denied";
  return "approved";
}

export function serviceRequestHasDeposit(dep: string): boolean {
  return dep.trim() !== "" && dep.trim() !== "0" && dep.trim() !== "$0";
}

export function managerServiceRequestPricingSummary(req: ServiceRequest): string {
  if (req.price?.trim()) return req.price.trim();
  if (req.priceLimit?.trim()) return `Limit ${req.priceLimit.trim()}`;
  return "—";
}

function moneyFieldValue(raw: string): string {
  return sanitizeMoneyInput(raw.replace(/^\$/, ""));
}

type DecisionKind = "approve" | "deny";

export function ManagerServiceRequestDetail({
  req,
  propertyLabel,
  onUpdated,
  onApproved,
  onFooterActionsChange,
  onDenied,
  onCollapsed,
  allowDelete = true,
}: {
  req: ServiceRequest;
  propertyLabel?: string;
  onUpdated: () => void;
  onApproved?: () => void;
  onDenied?: () => void;
  onCollapsed?: () => void;
  allowDelete?: boolean;
  /**
   * Publish the action row to a parent that renders a pinned footer, instead of
   * laying it out inline under the detail. Without a subscriber the inline row
   * stays, which is what the resident tab still uses.
   */
  onFooterActionsChange?: (actions: ReactNode | null) => void;
}) {
  const { showToast } = useAppUi();
  const { teamMembers, vendors } = useWorkAssignmentDirectory({ managerUserId: req.managerUserId });
  const needsReturn = serviceRequestHasDeposit(req.deposit);
  const description = req.offerDescription?.trim() ?? "";
  const showDescription =
    description.length > 0 && description !== "Add-on service booked through the resident portal.";
  const [editingCharges, setEditingCharges] = useState(false);
  const [editPrice, setEditPrice] = useState(() => moneyFieldValue(req.price ?? ""));
  const [editDeposit, setEditDeposit] = useState(() => moneyFieldValue(req.deposit ?? ""));
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [decisionKind, setDecisionKind] = useState<DecisionKind | null>(null);
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [decisionDraft, setDecisionDraft] = useState<{ subject: string; body: string } | null>(null);
  // C273: a decline needs a reason — collected in its own required step before the
  // notification preview opens, and stored on the row regardless of whether the
  // resident message is actually sent.
  const [denyReasonOpen, setDenyReasonOpen] = useState(false);
  const [denyReason, setDenyReason] = useState("");

  useEffect(() => {
    setEditPrice(moneyFieldValue(req.price ?? ""));
    setEditDeposit(moneyFieldValue(req.deposit ?? ""));
    setEditingCharges(false);
  }, [req.id, req.price, req.deposit]);

  useEffect(() => {
    if (!editingCharges) return;
    const el = document.getElementById(`service-request-price-${req.id}`) as HTMLInputElement | null;
    el?.focus();
    el?.select();
  }, [editingCharges, req.id]);

  const chargesSummary = managerServiceRequestPricingSummary(req);
  const depositSummary = needsReturn && req.deposit?.trim() ? req.deposit.trim() : null;

  const cancelEditing = () => {
    setEditPrice(moneyFieldValue(req.price ?? ""));
    setEditDeposit(moneyFieldValue(req.deposit ?? ""));
    setEditingCharges(false);
  };

  const saveCharges = () => {
    updateServiceRequest(req.id, {
      price: editPrice.trim(),
      deposit: editDeposit.trim(),
    });
    onUpdated();
    setEditingCharges(false);
    showToast("Charges updated.");
  };

  const openApprovePreview = () => {
    const price = (editPrice.trim() || moneyFieldValue(req.price ?? "")) ?? "";
    if (!price) {
      showToast("Set a service fee before approving.");
      return;
    }
    const priceLabel = price.startsWith("$") ? price : `$${price}`;
    const depositRaw = editDeposit.trim();
    setDecisionDraft(
      buildServiceRequestApprovedNotice({
        residentName: req.residentName,
        offerName: req.offerName,
        price: priceLabel,
        deposit: depositRaw,
        propertyLabel,
      }),
    );
    setDecisionKind("approve");
  };

  const openDenyReasonStep = () => {
    setDenyReason("");
    setDenyReasonOpen(true);
  };

  const confirmDenyReason = () => {
    const reason = denyReason.trim();
    if (!reason) return;
    setDecisionDraft(
      buildServiceRequestDeniedNotice({
        residentName: req.residentName,
        offerName: req.offerName,
        propertyLabel,
        reason,
      }),
    );
    setDenyReasonOpen(false);
    setDecisionKind("deny");
  };

  const applyDecision = async (
    skipMessage: boolean,
    channels?: NotificationDeliveryChannels,
    draft?: NotificationConfirmDraft,
  ) => {
    if (!decisionKind) return;
    const kind = decisionKind;
    setDecisionBusy(true);
    try {
      if (kind === "approve") {
        const price = (editPrice.trim() || moneyFieldValue(req.price ?? "")) ?? "";
        if (!price) {
          showToast("Set a service fee before approving.");
          return;
        }
        if (price !== moneyFieldValue(req.price ?? "") || editDeposit.trim() !== moneyFieldValue(req.deposit ?? "")) {
          updateServiceRequest(req.id, {
            price,
            deposit: editDeposit.trim(),
          });
        }
        approveServiceRequest(req.id, draft?.body, draft?.assignee);
        onUpdated();
        // Approval is the add-on's "arrival": propose a visit time from the manager's
        // service availability (or a PropLane pick) so the row carries a time to confirm.
        void attachProposedVisitToServiceRequest(req.id).then(() => onUpdated());
        onApproved?.();
        if (req.managerUserId) {
          void createScheduledWorkTask(req.managerUserId, {
            title: scheduledTaskTitleForService(req.offerName, req.residentName),
            propertyId: req.propertyId,
            propertyTitle: propertyLabel,
            assignee: draft?.assignee ?? undefined,
            notes: req.notes?.trim() || undefined,
          });
        }
      } else {
        // Store the manager's actual reason (not the full formatted notice) so it stays
        // legible if the record is reopened later, whether or not a message ever sent.
        denyServiceRequest(req.id, denyReason.trim() || draft?.body);
        onUpdated();
        onDenied?.();
      }

      const email = req.residentEmail?.trim() ?? "";
      if (!skipMessage && email.includes("@") && draft?.subject && draft.body) {
        const notify = await deliverPortalInboxMessage({
          eventCategory: "messages",
          fromName: "Property Manager",
          toEmails: [email],
          subject: draft.subject,
          text: draft.body,
          deliverViaEmail: channels?.viaEmail !== false,
          deliverViaSms: channels?.viaSms !== false,
        });
        if (!notify.ok) {
          showToast(
            kind === "approve"
              ? `Approved "${req.offerName}", but the resident message could not be sent.`
              : "Request denied, but the resident message could not be sent.",
          );
        } else {
          showToast(
            kind === "approve"
              ? `Approved "${req.offerName}" and messaged the resident.`
              : "Request denied and resident notified.",
          );
        }
      } else {
        showToast(kind === "approve" ? `Approved "${req.offerName}".` : "Request denied.");
      }
      setDecisionKind(null);
      setDecisionDraft(null);
    } finally {
      setDecisionBusy(false);
    }
  };

  const recipientLabel =
    [req.residentName?.trim(), req.residentEmail?.trim()].filter(Boolean).join(" · ") ||
    req.residentEmail ||
    "Resident";

  // A record page's header actions are icons only (docs/agents/record-page.md
  // § Known gap) — this used to be a labelled-button toolbar footer.
  const detailActions = (
    <>
        {req.status === "pending" ? (
          <>
            <PortalIconAction
              icon={CheckCircle2}
              label="Approve"
              tone="primary"
              data-attr="service-request-approve"
              onClick={openApprovePreview}
            />
            <PortalIconAction
              icon={XCircle}
              label="Deny"
              tone="danger"
              data-attr="service-request-deny"
              onClick={openDenyReasonStep}
            />
            {editingCharges ? (
              <PortalIconAction icon={Check} label="Save" tone="primary" onClick={saveCharges} />
            ) : (
              <PortalIconAction
                icon={Pencil}
                label="Edit"
                data-attr="service-request-edit-charges"
                onClick={() => setEditingCharges(true)}
              />
            )}
          </>
        ) : null}
        {allowDelete ? (
          <PortalIconAction
            icon={Trash2}
            label="Delete"
            tone="danger"
            onClick={() => setDeleteOpen(true)}
          />
        ) : null}
    </>
  );

  // Keyed on WHAT the row offers, not the node: the JSX is rebuilt every render,
  // so publishing on identity would loop the parent's state forever.
  const detailActionsSignature = [req.status, allowDelete, editingCharges].join("|");
  const onFooterActionsChangeRef = useRef(onFooterActionsChange);
  const detailActionsRef = useRef(detailActions);
  useLayoutEffect(() => {
    onFooterActionsChangeRef.current = onFooterActionsChange;
    detailActionsRef.current = detailActions;
  });
  useEffect(() => {
    const publish = onFooterActionsChangeRef.current;
    if (!publish) return;
    publish(detailActionsRef.current);
    return () => publish(null);
  }, [detailActionsSignature]);

  return (
    <>
      <div className="space-y-1 text-sm text-muted">
        {propertyLabel ? (
          <p>
            Property: <span className="text-foreground">{propertyLabel}</span>
          </p>
        ) : null}
        <p>
          Service: <span className="text-foreground">{req.offerName}</span>
        </p>
        {req.status === "pending" && editingCharges ? (
          <div className="grid gap-3 pt-1 sm:max-w-md sm:grid-cols-2">
            <div>
              <label
                htmlFor={`service-request-price-${req.id}`}
                className="mb-1 block text-xs font-medium text-muted"
              >
                Charges
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-sm font-medium text-muted">
                  $
                </span>
                <Input
                  id={`service-request-price-${req.id}`}
                  value={editPrice}
                  onChange={(e) => setEditPrice(sanitizeMoneyInput(e.target.value))}
                  placeholder={req.priceLimit?.trim() ? moneyFieldValue(req.priceLimit) : "0"}
                  inputMode="decimal"
                  className="pl-8 tabular-nums"
                  aria-label="Service fee"
                />
              </div>
            </div>
            {needsReturn || editDeposit.trim() ? (
              <div>
                <label
                  htmlFor={`service-request-deposit-${req.id}`}
                  className="mb-1 block text-xs font-medium text-muted"
                >
                  Deposit
                </label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-sm font-medium text-muted">
                    $
                  </span>
                  <Input
                    id={`service-request-deposit-${req.id}`}
                    value={editDeposit}
                    onChange={(e) => setEditDeposit(sanitizeMoneyInput(e.target.value))}
                    placeholder="0"
                    inputMode="decimal"
                    className="pl-8 tabular-nums"
                    aria-label="Deposit"
                  />
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <p>
            Charges:{" "}
            <span className="tabular-nums text-foreground">
              {chargesSummary}
              {depositSummary ? (
                <>
                  {" "}
                  · Deposit: {depositSummary}
                </>
              ) : null}
            </span>
          </p>
        )}
        {showDescription ? <p className="pt-1">{description}</p> : null}
        {req.priceLimit?.trim() && !req.price?.trim() ? (
          <p>
            Resident price limit: <span className="font-semibold text-foreground">{req.priceLimit.trim()}</span>
          </p>
        ) : null}
        {req.notes ? <p className="italic">&ldquo;{req.notes}&rdquo;</p> : null}
      </div>

      {onFooterActionsChange ? null : <PortalTableDetailActions>{detailActions}</PortalTableDetailActions>}

      <PortalDialog
        open={denyReasonOpen}
        onClose={() => setDenyReasonOpen(false)}
        title="Decline request"
        primaryAction={{
          label: "Continue",
          onClick: confirmDenyReason,
          disabled: !denyReason.trim(),
        }}
      >
        <div>
          <p className="mb-1 text-[11px] font-medium text-muted">
            Reason <span className="text-rose-500">*</span>
          </p>
          <Textarea
            value={denyReason}
            onChange={(e) => setDenyReason(e.target.value)}
            placeholder="Why can't this request be approved?"
            rows={3}
            className="bg-card"
            data-attr="service-request-deny-reason"
          />
        </div>
      </PortalDialog>

      <PortalNotificationPreviewModal
        open={decisionKind !== null && decisionDraft !== null}
        title={decisionKind === "deny" ? "Deny request" : "Approve request"}
        onClose={() => {
          if (decisionBusy) return;
          setDecisionKind(null);
          setDecisionDraft(null);
        }}
        recipient={recipientLabel}
        subject={decisionDraft?.subject ?? ""}
        body={decisionDraft?.body ?? ""}
        showChannelPicker
        emailAvailable={Boolean(req.residentEmail?.includes("@"))}
        smsAvailable
        confirmLabel={decisionKind === "deny" ? "Deny & notify" : "Approve & notify"}
        confirmLabelWithoutMessage={decisionKind === "deny" ? "Deny only" : "Approve only"}
        confirmBusy={decisionBusy}
        confirmBusyLabel={decisionKind === "deny" ? "Denying…" : "Approving…"}
        assigneeKind={decisionKind === "approve" ? "service" : undefined}
        assigneeTeamMembers={decisionKind === "approve" ? teamMembers : undefined}
        assigneeVendors={decisionKind === "approve" ? vendors : undefined}
        onConfirm={(skip, channels, draft) => void applyDecision(skip, channels, draft)}
      />

      <ConfirmDeleteModal
        open={deleteOpen}
        title="Delete request"
        description={`Delete “${req.offerName}”?`}
        confirmLabel="Delete request"
        dataAttr="service-request-delete-confirm"
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => {
          deleteServiceRequest(req.id);
          setDeleteOpen(false);
          onUpdated();
          onCollapsed?.();
          showToast("Request deleted.");
        }}
      />
    </>
  );
}
