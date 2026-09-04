"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Modal, ModalFooter, MODAL_FIELD_LABEL_CLASS, PORTAL_MODAL_FORM_FIELD_CLASS, PORTAL_MODAL_FORM_FULL_ROW_CLASS, PORTAL_MODAL_FORM_GRID_CLASS } from "@/components/ui/modal";
import {
  PortalNotificationPreviewModal,
  type NotificationConfirmDraft,
  type NotificationDeliveryChannels,
} from "@/components/portal/portal-notification-preview-modal";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import {
  deliverManagerDirectoryMessage,
  deliverManagerVendorInvite,
  fetchManagerVendorInviteDraft,
  fetchManagerVendorRemovalDraft,
  type ManagerVendorInvitePreview,
  type ManagerVendorRemovalPreview,
} from "@/lib/manager-vendor-invite-client";
import {
  deleteManagerVendorRow,
  makeVendorId,
  persistManagerVendorToServer,
  setManagerVendorPriority,
  upsertManagerVendor,
  type ManagerVendorRow,
} from "@/lib/manager-vendors-storage";
import { VENDOR_TRADE_OPTIONS } from "@/lib/work-order-taxonomy";

type VendorInvitePreview = ManagerVendorInvitePreview;

export type ManagerVendorFormDraft = {
  name: string;
  trade: string;
  phone: string;
  email: string;
  notes: string;
  active: boolean;
  sharedWithManagers: boolean;
  vendorPriority: "" | "primary" | "secondary";
};

export const EMPTY_MANAGER_VENDOR_FORM_DRAFT: ManagerVendorFormDraft = {
  name: "",
  trade: VENDOR_TRADE_OPTIONS[0]!,
  phone: "",
  email: "",
  notes: "",
  active: true,
  sharedWithManagers: false,
  vendorPriority: "",
};

function draftFromVendor(row: ManagerVendorRow): ManagerVendorFormDraft {
  return {
    name: row.name,
    trade: row.trade || VENDOR_TRADE_OPTIONS[0]!,
    phone: row.phone,
    email: row.email,
    notes: row.notes,
    active: row.active !== false,
    sharedWithManagers: row.sharedWithManagers === true,
    vendorPriority: row.vendorPriority ?? "",
  };
}

export function ManagerVendorFormFields({
  draft,
  onPatch,
  idPrefix = "vendor",
}: {
  draft: ManagerVendorFormDraft;
  onPatch: (patch: Partial<ManagerVendorFormDraft>) => void;
  idPrefix?: string;
}) {
  return (
    <div className={PORTAL_MODAL_FORM_GRID_CLASS}>
      <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
        <label className={MODAL_FIELD_LABEL_CLASS} htmlFor={`${idPrefix}-name`}>
          Vendor name
        </label>
        <Input
          id={`${idPrefix}-name`}
          value={draft.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          placeholder="e.g. Apex Plumbing"
          autoFocus
        />
      </div>
      <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
        <label className={MODAL_FIELD_LABEL_CLASS} htmlFor={`${idPrefix}-trade`}>
          Trade
        </label>
        <Select
          id={`${idPrefix}-trade`}
          value={draft.trade}
          onChange={(e) => onPatch({ trade: e.target.value })}
        >
          {VENDOR_TRADE_OPTIONS.map((trade) => (
            <option key={trade} value={trade}>
              {trade}
            </option>
          ))}
        </Select>
      </div>
      <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
        <label className={MODAL_FIELD_LABEL_CLASS} htmlFor={`${idPrefix}-phone`}>
          Phone
        </label>
        <Input
          id={`${idPrefix}-phone`}
          type="tel"
          value={draft.phone}
          onChange={(e) => onPatch({ phone: e.target.value })}
          placeholder="(206) 555-0100"
          autoComplete="tel"
        />
      </div>
      <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
        <label className={MODAL_FIELD_LABEL_CLASS} htmlFor={`${idPrefix}-email`}>
          Email
        </label>
        <Input
          id={`${idPrefix}-email`}
          type="email"
          value={draft.email}
          onChange={(e) => onPatch({ email: e.target.value })}
          placeholder="vendor@company.com"
          autoComplete="email"
        />
      </div>
      <div className={`${PORTAL_MODAL_FORM_FIELD_CLASS} ${PORTAL_MODAL_FORM_FULL_ROW_CLASS}`}>
        <label className={MODAL_FIELD_LABEL_CLASS} htmlFor={`${idPrefix}-notes`}>
          Notes <span className="font-normal normal-case tracking-normal text-muted">(optional)</span>
        </label>
        <Textarea
          id={`${idPrefix}-notes`}
          rows={3}
          className="resize-y"
          value={draft.notes}
          onChange={(e) => onPatch({ notes: e.target.value })}
          placeholder="License, service area, after-hours contact, billing notes…"
        />
      </div>
      <div className={`${PORTAL_MODAL_FORM_FULL_ROW_CLASS} space-y-3`}>
        <label className="flex cursor-pointer items-center gap-2.5">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-border text-primary"
            checked={draft.active}
            onChange={(e) => onPatch({ active: e.target.checked })}
          />
          <span className="text-sm font-medium text-foreground">Active — available for work orders and payments</span>
        </label>
        <fieldset className="space-y-2">
          <legend className={MODAL_FIELD_LABEL_CLASS}>Priority for this trade</legend>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <input
              type="radio"
              name={`${idPrefix}-priority`}
              checked={draft.vendorPriority === "primary"}
              onChange={() => onPatch({ vendorPriority: "primary" })}
            />
            Primary — preferred when assigning this trade
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <input
              type="radio"
              name={`${idPrefix}-priority`}
              checked={draft.vendorPriority === "secondary"}
              onChange={() => onPatch({ vendorPriority: "secondary" })}
            />
            Secondary backup
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <input
              type="radio"
              name={`${idPrefix}-priority`}
              checked={draft.vendorPriority === ""}
              onChange={() => onPatch({ vendorPriority: "" })}
            />
            Standard — no priority
          </label>
        </fieldset>
        <label className="flex cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-border text-primary"
            checked={draft.sharedWithManagers}
            onChange={(e) => onPatch({ sharedWithManagers: e.target.checked })}
          />
          <span className="text-sm leading-6 text-foreground">
            Share on PropLane
            <span className="mt-0.5 block text-xs font-normal text-muted">
              Other managers can discover and assign this vendor. You can turn this off anytime.
            </span>
          </span>
        </label>
      </div>
    </div>
  );
}

export function ManagerVendorFormModal({
  open,
  mode,
  vendor,
  initialTrade,
  onClose,
  onSaved,
  onDeleted,
  showToast,
  onBrowseCatalog,
}: {
  open: boolean;
  mode: "add" | "edit";
  vendor?: ManagerVendorRow | null;
  initialTrade?: string;
  onClose: () => void;
  onSaved?: () => void;
  onDeleted?: () => void;
  showToast: (message: string) => void;
  /** Opens vendor settings (catalog / defaults) without losing context. */
  onBrowseCatalog?: () => void;
}) {
  const { userId } = useManagerUserId();
  const [draft, setDraft] = useState<ManagerVendorFormDraft>(EMPTY_MANAGER_VENDOR_FORM_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [invitePreview, setInvitePreview] = useState<VendorInvitePreview | null>(null);
  const [removePreview, setRemovePreview] = useState<ManagerVendorRemovalPreview | null>(null);
  const [createdVendorId, setCreatedVendorId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (mode === "edit" && vendor) {
      setDraft(draftFromVendor(vendor));
    } else {
      setDraft({
        ...EMPTY_MANAGER_VENDOR_FORM_DRAFT,
        trade: initialTrade?.trim() || VENDOR_TRADE_OPTIONS[0]!,
      });
    }
    setError(null);
    setSaving(false);
    setInvitePreview(null);
    setRemovePreview(null);
    setCreatedVendorId(null);
  }, [open, mode, vendor, initialTrade]);

  const patch = (next: Partial<ManagerVendorFormDraft>) => setDraft((prev) => ({ ...prev, ...next }));

  const buildRow = (): ManagerVendorRow | null => {
    const name = draft.name.trim();
    if (!name) {
      setError("Vendor name is required.");
      return null;
    }
    if (!userId) {
      showToast("Sign in to save vendors.");
      return null;
    }
    setError(null);
    const id = mode === "edit" && vendor ? vendor.id : createdVendorId ?? makeVendorId();
    const now = new Date().toISOString();
    const existing = mode === "edit" ? vendor : null;
    return {
      id,
      managerUserId: userId,
      name,
      trade: draft.trade.trim() || VENDOR_TRADE_OPTIONS[0]!,
      phone: draft.phone.trim(),
      email: draft.email.trim(),
      notes: draft.notes.trim(),
      active: draft.active,
      sharedWithManagers: draft.sharedWithManagers,
      vendorPriority: draft.vendorPriority || undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  };

  const persistRow = async (row: ManagerVendorRow): Promise<boolean> => {
    if (!userId) return false;
    upsertManagerVendor(row, userId);
    if (draft.vendorPriority === "primary") {
      setManagerVendorPriority(row.id, "primary", userId);
    }
    const persisted = await persistManagerVendorToServer(row);
    if (!persisted) {
      showToast("Vendor saved locally; syncing to the server failed. Try again before sending the invite.");
      return false;
    }
    if (mode === "add") setCreatedVendorId(row.id);
    return true;
  };

  const saveEdit = async () => {
    const row = buildRow();
    if (!row) return;
    setSaving(true);
    await persistRow(row);
    setSaving(false);
    showToast("Vendor updated.");
    onClose();
    onSaved?.();
  };

  const addOnly = async () => {
    const row = buildRow();
    if (!row) return;
    const email = row.email.trim().toLowerCase();
    const validEmail = email && /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email);
    if (validEmail) {
      await openInvitePreview();
      return;
    }
    setSaving(true);
    setError(null);
    const persisted = await persistRow(row);
    setSaving(false);
    if (!persisted) return;
    showToast("Vendor added.");
    onClose();
    onSaved?.();
  };

  const openRemovePreview = async () => {
    if (mode !== "edit" || !vendor) return;
    setSaving(true);
    setError(null);
    try {
      const result = await fetchManagerVendorRemovalDraft({
        vendorId: vendor.id,
        vendorName: vendor.name,
        vendorEmail: vendor.email,
        vendorPhone: vendor.phone,
      });
      if (!result.ok) {
        showToast(result.error);
        return;
      }
      setRemovePreview(result.preview);
    } finally {
      setSaving(false);
    }
  };

  const confirmVendorRemove = async (
    skipMessage: boolean,
    channels?: NotificationDeliveryChannels,
    messageDraft?: NotificationConfirmDraft,
  ) => {
    if (!removePreview || !vendor || saving) return;
    setSaving(true);
    try {
      if (!skipMessage) {
        const result = await deliverManagerDirectoryMessage(removePreview, false, channels, messageDraft);
        if (!result.ok) {
          showToast(result.message);
          return;
        }
      }
      if (!deleteManagerVendorRow(vendor.id, userId)) {
        showToast("Could not remove vendor.");
        return;
      }
      setRemovePreview(null);
      showToast(skipMessage ? "Vendor removed." : "Vendor removed and notified.");
      onClose();
      onDeleted?.();
    } finally {
      setSaving(false);
    }
  };

  const remove = () => {
    void openRemovePreview();
  };

  const openInvitePreview = async () => {
    const row = buildRow();
    if (!row) return;
    const email = row.email.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email)) {
      setError("A valid email is required to preview the vendor portal invite.");
      return;
    }
    setSaving(true);
    setError(null);
    const persisted = await persistRow(row);
    if (!persisted) {
      setSaving(false);
      return;
    }
    try {
      const result = await fetchManagerVendorInviteDraft({
        vendorId: row.id,
        vendorName: row.name,
        vendorEmail: email,
      });
      if (!result.ok) {
        showToast(result.error);
        setSaving(false);
        return;
      }
      setInvitePreview({
        ...result.preview,
        phone: row.phone,
      });
    } catch {
      showToast("Could not prepare the vendor onboarding message.");
    } finally {
      setSaving(false);
    }
  };

  const confirmVendorInvite = async (
    skipMessage: boolean,
    channels?: NotificationDeliveryChannels,
    messageDraft?: NotificationConfirmDraft,
  ) => {
    if (!invitePreview || saving) return;
    setSaving(true);
    try {
      if (!skipMessage) {
        const result = await deliverManagerVendorInvite(invitePreview, skipMessage, channels, messageDraft);
        if (!result.ok) {
          showToast(`Vendor added, but ${result.message}`);
          return;
        }
        showToast(result.message ? `Vendor added. ${result.message}` : "Vendor added.");
      } else {
        showToast("Vendor added.");
      }
      setInvitePreview(null);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const title = mode === "edit" ? "Edit vendor" : "Add vendor";

  return (
    <>
      <Modal
        open={open && invitePreview === null && removePreview === null}
        title={title}
        onClose={onClose}
        panelClassName="max-w-lg"
        dense
        footer={
          <ModalFooter className="w-full">
            {mode === "edit" && vendor ? (
              <Button
                type="button"
                variant="outline"
                className="rounded-full border-red-200 text-red-700 hover:bg-red-50"
                onClick={remove}
                data-attr="vendor-form-delete"
              >
                Delete
              </Button>
            ) : null}
            {mode === "add" ? (
              <Button
                type="button"
                variant="primary"
                className="ml-auto rounded-full"
                disabled={saving}
                onClick={() => void addOnly()}
                data-attr="vendor-form-preview-invite"
              >
                {saving ? "Saving…" : "Review & add vendor"}
              </Button>
            ) : (
              <Button
                type="button"
                variant="primary"
                className="ml-auto rounded-full"
                disabled={saving}
                onClick={() => void saveEdit()}
                data-attr="vendor-form-save"
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            )}
          </ModalFooter>
        }
      >
        <div className="space-y-4">
          {mode === "add" ? (
            <p className="text-xs text-muted">
              Add a vendor to your directory, then review the PropLane vendor portal signup message before it goes out.
            </p>
          ) : null}
          {onBrowseCatalog ? (
            <p className="text-xs text-muted">
              Prefer a curated vendor?{" "}
              <button
                type="button"
                className="font-semibold text-primary hover:underline"
                data-attr="vendor-form-browse-catalog"
                onClick={() => {
                  onClose();
                  onBrowseCatalog();
                }}
              >
                Browse PropLane catalog
              </button>
            </p>
          ) : null}
          <ManagerVendorFormFields draft={draft} onPatch={patch} />
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
        </div>
      </Modal>

      <PortalNotificationPreviewModal
        open={invitePreview !== null}
        title="Add vendor — notification preview"
        onClose={() => setInvitePreview(null)}
        recipient={invitePreview?.email ?? ""}
        recipientPhone={invitePreview?.phone ?? ""}
        subject={invitePreview?.subject ?? ""}
        body={invitePreview?.body ?? ""}
        intro="Review the vendor portal setup message. It explains how to sign up for PropLane, view services, and message you."
        showChannelPicker
        showSchedule
        emailAvailable={Boolean(invitePreview?.email?.includes("@"))}
        smsAvailable={Boolean(invitePreview?.phone?.trim())}
        defaultViaSms={false}
        confirmLabel="Add vendor & send invite"
        confirmLabelWithoutMessage="Add vendor only"
        skipMessageLabel="Don't message vendor"
        confirmBusy={saving}
        confirmBusyLabel="Adding…"
        cancelLabel="Back"
        onConfirm={(skipMessage, channels, messageDraft) => void confirmVendorInvite(skipMessage, channels, messageDraft)}
      />
      <PortalNotificationPreviewModal
        open={removePreview !== null}
        title="Remove vendor — notification preview"
        onClose={() => setRemovePreview(null)}
        recipient={removePreview?.email ?? ""}
        recipientPhone={removePreview?.phone ?? ""}
        subject={removePreview?.subject ?? ""}
        body={removePreview?.body ?? ""}
        intro="Review the message before removing this vendor from your roster."
        showChannelPicker
        showSchedule={false}
        emailAvailable={Boolean(removePreview?.email?.includes("@"))}
        smsAvailable={Boolean(removePreview?.email?.includes("@") && removePreview?.phone?.trim())}
        defaultViaSms={false}
        confirmLabel="Remove & send message"
        confirmLabelWithoutMessage="Remove only"
        skipMessageLabel="Don't message vendor"
        confirmBusy={saving}
        confirmBusyLabel="Removing…"
        cancelLabel="Cancel"
        onConfirm={(skipMessage, channels, messageDraft) => void confirmVendorRemove(skipMessage, channels, messageDraft)}
      />
    </>
  );
}
