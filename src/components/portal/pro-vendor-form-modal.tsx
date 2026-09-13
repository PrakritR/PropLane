"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import { Modal, MODAL_FIELD_LABEL_CLASS, PORTAL_MODAL_FORM_FIELD_CLASS, PORTAL_MODAL_FORM_FULL_ROW_CLASS, PORTAL_MODAL_FORM_GRID_CLASS } from "@/components/ui/modal";
import { ManagerInviteLinkModal } from "@/components/portal/manager-invite-link-modal";
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
  type ManagerVendorRemovalPreview,
  type ManagerVendorInvitePreview,
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

function vendorEmailLooksValid(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  return Boolean(normalized && /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(normalized));
}

export function ManagerVendorEssentialFields({
  draft,
  onPatch,
  idPrefix = "vendor",
}: {
  draft: ManagerVendorFormDraft;
  onPatch: (patch: Partial<ManagerVendorFormDraft>) => void;
  idPrefix?: string;
}) {
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="text-xs font-semibold text-muted">Vendor name</span>
        <Input
          id={`${idPrefix}-name`}
          value={draft.name}
          onChange={(e) => onPatch({ name: e.target.value })}
          placeholder="e.g. Apex Plumbing"
          autoFocus
          className="mt-1"
          data-attr="vendor-essential-name"
        />
      </label>
      <label className="block">
        <span className="text-xs font-semibold text-muted">Email</span>
        <Input
          id={`${idPrefix}-email`}
          type="email"
          value={draft.email}
          onChange={(e) => onPatch({ email: e.target.value })}
          placeholder="vendor@company.com"
          autoComplete="email"
          className="mt-1"
          data-attr="vendor-essential-email"
        />
      </label>
      <label className="block">
        <span className="text-xs font-semibold text-muted">Trade</span>
        <Select
          id={`${idPrefix}-trade`}
          value={draft.trade}
          onChange={(e) => onPatch({ trade: e.target.value })}
          className="mt-1"
          data-attr="vendor-essential-trade"
        >
          {VENDOR_TRADE_OPTIONS.map((trade) => (
            <option key={trade} value={trade}>
              {trade}
            </option>
          ))}
        </Select>
      </label>
    </div>
  );
}

export function ManagerVendorOptionalFields({
  draft,
  onPatch,
  idPrefix = "vendor",
}: {
  draft: ManagerVendorFormDraft;
  onPatch: (patch: Partial<ManagerVendorFormDraft>) => void;
  idPrefix?: string;
}) {
  return (
    <div className="space-y-4">
      <div className={PORTAL_MODAL_FORM_GRID_CLASS}>
        <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
          <label className={MODAL_FIELD_LABEL_CLASS} htmlFor={`${idPrefix}-phone`}>
            Phone
          </label>
          <PhoneNumberField
            id={`${idPrefix}-phone`}
            value={draft.phone}
            onChange={(phone) => onPatch({ phone })}
            dataAttr="vendor-optional-phone"
          />
        </div>
      </div>
      <div>
        <label className={MODAL_FIELD_LABEL_CLASS} htmlFor={`${idPrefix}-notes`}>
          Notes <span className="font-normal normal-case tracking-normal text-muted">(optional)</span>
        </label>
        <Textarea
          id={`${idPrefix}-notes`}
          rows={3}
          className="mt-1 resize-y"
          value={draft.notes}
          onChange={(e) => onPatch({ notes: e.target.value })}
          placeholder="License, service area, after-hours contact, billing notes…"
          data-attr="vendor-optional-notes"
        />
      </div>
      <div className="space-y-3">
        <label className="flex cursor-pointer items-center gap-2.5">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-border text-primary"
            checked={draft.active}
            onChange={(e) => onPatch({ active: e.target.checked })}
            data-attr="vendor-optional-active"
          />
          <span className="text-sm font-medium text-foreground">Active — available for services and payments</span>
        </label>
        <fieldset className="space-y-2">
          <legend className={MODAL_FIELD_LABEL_CLASS}>Priority for this trade</legend>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <input
              type="radio"
              name={`${idPrefix}-priority`}
              checked={draft.vendorPriority === "primary"}
              onChange={() => onPatch({ vendorPriority: "primary" })}
              data-attr="vendor-priority-primary"
            />
            Primary — preferred when assigning this trade
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <input
              type="radio"
              name={`${idPrefix}-priority`}
              checked={draft.vendorPriority === "secondary"}
              onChange={() => onPatch({ vendorPriority: "secondary" })}
              data-attr="vendor-priority-secondary"
            />
            Secondary backup
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <input
              type="radio"
              name={`${idPrefix}-priority`}
              checked={draft.vendorPriority === ""}
              onChange={() => onPatch({ vendorPriority: "" })}
              data-attr="vendor-priority-standard"
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
            data-attr="vendor-optional-share"
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
        <PhoneNumberField
          id={`${idPrefix}-phone`}
          value={draft.phone}
          onChange={(phone) => onPatch({ phone })}
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
          <span className="text-sm font-medium text-foreground">Active — available for services and payments</span>
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
  const [invitationMessage, setInvitationMessage] = useState("Please join our vendor directory on PropLane so we can coordinate upcoming services.");
  const submitRef = useRef(false);
  const preparedInviteRef = useRef<{ key: string; preview: ManagerVendorInvitePreview } | null>(null);
  const requestGeneration = useRef(0);
  const [deliveryUncertain, setDeliveryUncertain] = useState(false);
  useEffect(() => () => { requestGeneration.current += 1; }, []);
  const [removePreview, setRemovePreview] = useState<ManagerVendorRemovalPreview | null>(null);
  const [createdVendorId, setCreatedVendorId] = useState<string | null>(null);
  const [inviteLinkOpen, setInviteLinkOpen] = useState(false);
  // Houses the vendor link can be scoped to — read when the link dialog opens
  // so a property added mid-session is offered.
  const inviteLinkPropertyOptions = useMemo(
    () => (inviteLinkOpen ? buildManagerPropertyFilterOptions(userId).map((o) => ({ value: o.id, label: o.label })) : []),
    [inviteLinkOpen, userId],
  );

  useEffect(() => {
    requestGeneration.current += 1;
    if (!open) return;
    preparedInviteRef.current = null;
    setDeliveryUncertain(false);
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
    setInvitationMessage("Please join our vendor directory on PropLane so we can coordinate upcoming services.");
    setRemovePreview(null);
    setCreatedVendorId(null);
    setInviteLinkOpen(false);
  }, [open, mode, vendor, initialTrade, userId]);

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
    const generation = requestGeneration.current;
    if (!await persistManagerVendorToServer(row) || generation !== requestGeneration.current) return false;
    upsertManagerVendor(row, userId, { persist: false });
    if (draft.vendorPriority === "primary" && vendor?.vendorPriority !== "primary") {
      setManagerVendorPriority(row.id, "primary", userId);
    }
    return true;
  };

  const saveEdit = async () => {
    if (submitRef.current) return;
    const row = buildRow();
    if (!row) return;
    const generation = requestGeneration.current;
    const current = () => requestGeneration.current === generation;
    submitRef.current = true;
    setSaving(true);
    try {
      if (!await persistRow(row)) { if (current()) setError("Could not save the vendor. Please try again."); return; }
      if (!current()) return;
      showToast("Vendor updated.");
      onClose();
      onSaved?.();
    } catch { if (current()) setError("Could not save the vendor. Your details are still here."); }
    finally { if (current()) setSaving(false); submitRef.current = false; }
  };

  const addOnly = async () => {
    if (submitRef.current) return;
    const row = buildRow();
    if (!row) return;
    const email = row.email.trim().toLowerCase();
    if (email && !vendorEmailLooksValid(email)) { setError("Enter a valid email address."); return; }
    if (email && !invitationMessage.trim()) { setError("Enter an invitation message."); return; }
    const generation = requestGeneration.current;
    const current = () => requestGeneration.current === generation;
    submitRef.current = true;
    setSaving(true);
    setError(null);
    // Keep the same record id on a retry, including an uncertain network response.
    setCreatedVendorId(row.id);
    try {
      if (!await persistRow(row)) { if (current()) setError("Could not save the vendor. Please try again."); return; }
      if (!current()) return;
      if (email) {
        const key = `${row.id}:${email}:${row.name}`;
        let preview = preparedInviteRef.current?.key === key ? preparedInviteRef.current.preview : null;
        if (!preview) {
          const result = await fetchManagerVendorInviteDraft({ vendorId: row.id, vendorName: row.name, vendorEmail: email });
          if (!current()) return;
          if (!result.ok) { setError(result.error); return; }
          preview = { ...result.preview, phone: row.phone };
          preparedInviteRef.current = { key, preview };
        }
        const body = preview.linkUrl
          ? `${invitationMessage.trim()}\n\nJoin PropLane: ${preview.linkUrl}`
          : `${invitationMessage.trim()}\n\n${preview.body}`;
        const sent = await deliverManagerVendorInvite(preview, false, { viaEmail: true, viaInbox: true, viaSms: false }, { subject: preview.subject, body });
        if (!current()) return;
        if (!sent.ok) {
          setDeliveryUncertain(sent.uncertain === true);
          setError(sent.uncertain ? "Delivery could not be confirmed. Check Communication before sending again. Your message is still here." : `Vendor saved, but ${sent.message} Your message is still here.`);
          return;
        }
        showToast(sent.message || "Vendor invitation sent.");
      } else showToast("Vendor added.");
      onClose();
      onSaved?.();
    } catch { if (current()) setError("Could not complete the invitation. Your details are still here; please try again."); }
    finally { if (current()) setSaving(false); submitRef.current = false; }
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

  const title = mode === "edit" ? "Edit vendor" : "Invite vendor";
  const addHasValidEmail = vendorEmailLooksValid(draft.email);

  return (
    <>
      <Modal
        open={open && !inviteLinkOpen && removePreview === null}
        title={title}
        assistantContext={mode === "add" ? "Invite vendor" : "Edit vendor"}
        assistantStorageScopeKey={mode === "add" ? "Invite vendor" : "Edit vendor"}
        onClose={() => { if (!submitRef.current) onClose(); }}
        panelClassName={mode === "add" ? "max-w-2xl" : "max-w-lg"}
        dense
        footer={
          <div className="flex w-full items-center justify-between gap-2">
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
            ) : (
              <span aria-hidden />
            )}
            {mode === "add" ? (
              <Button type="button" variant="primary" className="rounded-full" disabled={saving} loading={saving}
                onClick={() => addOnly()} data-attr={addHasValidEmail ? "vendor-form-send-invite" : "vendor-form-add-only"}>
                {addHasValidEmail ? deliveryUncertain ? "Send again" : "Send invite" : "Add vendor"}
              </Button>
            ) : (
              <Button
                type="button"
                variant="primary"
                className="ml-auto rounded-full"
                disabled={saving}
                onClick={() => saveEdit()}
                data-attr="vendor-form-save"
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            )}
          </div>
        }
      >
        <div className="space-y-5">
          {mode === "add" ? (
            <>
              {onBrowseCatalog ? (
                <p className="text-xs text-muted">
                  Prefer a curated vendor?{" "}
                  <button
                    type="button"
                    className="font-semibold text-primary hover:underline"
                    data-attr="vendor-form-browse-catalog"
                    disabled={saving}
                    onClick={() => {
                      if (submitRef.current) return;
                      onClose();
                      onBrowseCatalog();
                    }}
                  >
                    Browse PropLane catalog
                  </button>
                </p>
              ) : null}
              <div className="grid grid-cols-2 gap-1 rounded-xl bg-accent/50 p-1">
                <Button type="button" variant="ghost" className="rounded-lg bg-card shadow-sm text-primary" aria-current="page">Invite by email</Button>
                <Button type="button" variant="ghost" className="rounded-lg" disabled={saving} onClick={() => { if (!submitRef.current) setInviteLinkOpen(true); }} data-attr="vendor-create-invite-link">Create invite link</Button>
              </div>
              <form id="vendor-invite-form" className="space-y-4" data-field-select-placement="below" onSubmit={(event) => { event.preventDefault(); void addOnly(); }}>
                <fieldset disabled={saving} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <label className="space-y-1"><span className="text-sm font-semibold">Vendor name</span><Input value={draft.name} onChange={(e) => patch({ name: e.target.value })} required autoFocus data-attr="vendor-essential-name" /></label>
                  <label className="space-y-1"><span className="text-sm font-semibold">Email</span><Input type="email" value={draft.email} onChange={(e) => patch({ email: e.target.value })} autoComplete="email" data-attr="vendor-essential-email" /></label>
                  <label className="space-y-1"><span className="text-sm font-semibold">Trade</span><Select value={draft.trade} onChange={(e) => patch({ trade: e.target.value })} data-attr="vendor-essential-trade">{VENDOR_TRADE_OPTIONS.map((trade) => <option key={trade} value={trade}>{trade}</option>)}</Select></label>
                  <div className="space-y-1"><label htmlFor="vendor-invite-phone" className="text-sm font-semibold">Phone <span className="font-normal text-muted">(optional)</span></label><PhoneNumberField id="vendor-invite-phone" value={draft.phone} onChange={(phone) => patch({ phone })} dataAttr="vendor-optional-phone" /></div>
                  <label className="space-y-1 sm:col-span-2"><span className="text-sm font-semibold">Invitation message</span><Textarea aria-label="Invitation message" value={invitationMessage} onChange={(e) => setInvitationMessage(e.target.value)} rows={3} data-attr="vendor-invitation-message" /><span className="block text-xs text-muted">Included in the email with a secure signup link.</span></label>
                  <details className="sm:col-span-2"><summary className="cursor-pointer text-sm text-muted">Private notes (optional)</summary><Textarea aria-label="Private notes" value={draft.notes} onChange={(e) => patch({ notes: e.target.value })} rows={2} className="mt-2" data-attr="vendor-optional-notes" /><p className="mt-1 text-xs text-muted">Only your team sees these.</p></details>
                </fieldset>
              </form>
            </>
          ) : (
            <>
              {onBrowseCatalog ? (
                <p className="text-xs text-muted">
                  Prefer a curated vendor?{" "}
                  <button
                    type="button"
                    className="font-semibold text-primary hover:underline"
                    data-attr="vendor-form-browse-catalog"
                    disabled={saving}
                    onClick={() => {
                      if (submitRef.current) return;
                      onClose();
                      onBrowseCatalog();
                    }}
                  >
                    Browse PropLane catalog
                  </button>
                </p>
              ) : null}
              <ManagerVendorFormFields draft={draft} onPatch={patch} />
            </>
          )}
          {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
        </div>
      </Modal>

      <PortalNotificationPreviewModal
        open={removePreview !== null}
        title="Remove vendor — notification preview"
        onClose={() => setRemovePreview(null)}
        recipient={removePreview?.email ?? ""}
        recipientPhone={removePreview?.phone ?? ""}
        subject={removePreview?.subject ?? ""}
        body={removePreview?.body ?? ""}
        showChannelPicker
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
      <ManagerInviteLinkModal
        open={inviteLinkOpen}
        onClose={() => setInviteLinkOpen(false)}
        kind="vendor"
        propertyOptions={inviteLinkPropertyOptions}
      />
    </>
  );
}
