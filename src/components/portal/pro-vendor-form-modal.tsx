"use client";

import { Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import { Modal, MODAL_FIELD_LABEL_CLASS, PORTAL_MODAL_FORM_FIELD_CLASS, PORTAL_MODAL_FORM_FULL_ROW_CLASS, PORTAL_MODAL_FORM_GRID_CLASS } from "@/components/ui/modal";
import { PortalInvitePaths, type PortalInvitePath } from "@/components/portal/portal-invite-paths";
import { formatInviteMessageBody, formatInviteMessageSubject } from "@/lib/invite-message-body";
import { mintInviteLinkClient } from "@/lib/invite-links/mint-invite-link-client";
import { formatProplaneIdForDisplay } from "@/lib/manager-id";
import { AXIS_ID_LABEL } from "@/lib/pro-relationships";
import {
  PortalNotificationPreviewModal,
  type NotificationConfirmDraft,
  type NotificationDeliveryChannels,
} from "@/components/portal/portal-notification-preview-modal";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import {
  deliverManagerDirectoryMessage,
  deliverManagerVendorInvite,
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
          <span className="text-sm font-medium text-foreground">Active</span>
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
          <span className="text-sm leading-6 text-foreground">Share on PropLane</span>
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
          <span className="text-sm font-medium text-foreground">Active</span>
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
          <span className="text-sm leading-6 text-foreground">Share on PropLane</span>
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
  const [invitePath, setInvitePath] = useState<PortalInvitePath>("link");
  const [mintedVendorUrl, setMintedVendorUrl] = useState<string | null>(null);
  const [inviteSendPreview, setInviteSendPreview] = useState<ManagerVendorInvitePreview | null>(null);
  const [axisInput, setAxisInput] = useState("");
  const [draftAxisId, setDraftAxisId] = useState<string | null>(null);
  const [draftAxisName, setDraftAxisName] = useState<string | null>(null);
  const submitRef = useRef(false);
  const requestGeneration = useRef(0);
  useEffect(() => () => { requestGeneration.current += 1; }, []);
  const [removePreview, setRemovePreview] = useState<ManagerVendorRemovalPreview | null>(null);
  const [createdVendorId, setCreatedVendorId] = useState<string | null>(null);

  useEffect(() => {
    requestGeneration.current += 1;
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
    setInvitePath("link");
    setMintedVendorUrl(null);
    setInviteSendPreview(null);
    setAxisInput("");
    setDraftAxisId(null);
    setDraftAxisName(null);
    setRemovePreview(null);
    setCreatedVendorId(null);
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
      ...existing,
      id,
      managerUserId: existing?.managerUserId ?? userId,
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

  const lookupVendorAxis = async (): Promise<{ axisId: string; name: string; userId: string | null } | null> => {
    const raw = axisInput.trim();
    if (!raw) {
      setError(`Enter a ${AXIS_ID_LABEL}.`);
      return null;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/pro/lookup-axis-id?axisId=${encodeURIComponent(raw)}`, { credentials: "include" });
      const body = (await res.json()) as { ok?: boolean; error?: string; displayName?: string; userId?: string };
      if (!res.ok || !body.ok) {
        setError(body.error ?? "Lookup failed.");
        return null;
      }
      const name = body.displayName ?? raw;
      setDraftAxisId(raw);
      setDraftAxisName(name);
      return { axisId: raw, name, userId: body.userId ?? null };
    } catch {
      setError("Network error.");
      return null;
    } finally {
      setSaving(false);
    }
  };

  const continueVendorInvite = async () => {
    if (submitRef.current) return;
    const row = buildRow();
    if (!row) return;
    if (invitePath === "message" && !row.phone.trim()) {
      setError("Enter a phone number to invite via message.");
      return;
    }
    if (row.email && !vendorEmailLooksValid(row.email)) {
      setError("Enter a valid email address.");
      return;
    }
    let resolvedAxisId = draftAxisId;
    let resolvedAxisName = draftAxisName;
    if (invitePath === "code" && !resolvedAxisId) {
      const looked = await lookupVendorAxis();
      if (!looked) return;
      resolvedAxisId = looked.axisId;
      resolvedAxisName = looked.name;
    }
    const generation = requestGeneration.current;
    const current = () => requestGeneration.current === generation;
    submitRef.current = true;
    setSaving(true);
    setError(null);
    setCreatedVendorId(row.id);
    try {
      if (!await persistRow(row)) {
        if (current()) setError("Could not save the vendor. Please try again.");
        return;
      }
      if (!current()) return;
      let url = mintedVendorUrl;
      if (!url) {
        const minted = await mintInviteLinkClient({
          kind: "vendor",
          label: row.trade || row.name,
          assignedPropertyIds: [],
        });
        if (!minted.ok) {
          if (current()) setError(minted.error);
          return;
        }
        url = minted.url;
        setMintedVendorUrl(url);
        if (invitePath === "link") return;
      }
      const facts = {
        kind: "vendor" as const,
        inviterName: "A property manager",
        vendorName: row.name,
        trade: row.trade,
        phone: row.phone || undefined,
        email: row.email || undefined,
        proplaneCode: resolvedAxisId ?? undefined,
        inviteUrl: url,
      };
      setInviteSendPreview({
        vendorId: row.id,
        name: resolvedAxisName || row.name,
        email: row.email,
        phone: row.phone,
        linkUrl: url,
        subject: formatInviteMessageSubject(facts),
        body: formatInviteMessageBody(facts),
      });
    } catch {
      if (current()) setError("Could not complete the invitation. Your details are still here; please try again.");
    } finally {
      if (current()) setSaving(false);
      submitRef.current = false;
    }
  };

  const confirmVendorInvite = async (
    skipMessage: boolean,
    channels?: NotificationDeliveryChannels,
    messageDraft?: NotificationConfirmDraft,
  ) => {
    if (!inviteSendPreview || saving) return;
    setSaving(true);
    try {
      if (!skipMessage) {
        const sent = await deliverManagerVendorInvite(inviteSendPreview, false, channels, messageDraft);
        if (!sent.ok) {
          setError(sent.uncertain
            ? "Delivery could not be confirmed. Check Communication before sending again."
            : sent.message);
          return;
        }
        showToast(sent.message || "Vendor invitation sent.");
      } else {
        showToast("Vendor added.");
      }
      setInviteSendPreview(null);
      onClose();
      onSaved?.();
    } finally {
      setSaving(false);
    }
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

  return (
    <>
      <Modal
        open={open && removePreview === null && inviteSendPreview === null}
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
                onClick={() => void continueVendorInvite()} data-attr="vendor-form-continue">
                Continue
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
              <PortalInvitePaths value={invitePath} onChange={setInvitePath} disabled={saving} />
              <form id="vendor-invite-form" className="space-y-4" data-field-select-placement="below" onSubmit={(event) => { event.preventDefault(); void continueVendorInvite(); }}>
                <fieldset disabled={saving} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <label className="space-y-1"><span className="text-sm font-semibold">Vendor name</span><Input value={draft.name} onChange={(e) => patch({ name: e.target.value })} required autoFocus data-attr="vendor-essential-name" /></label>
                  <label className="space-y-1"><span className="text-sm font-semibold">Trade</span><Select value={draft.trade} onChange={(e) => patch({ trade: e.target.value })} data-attr="vendor-essential-trade">{VENDOR_TRADE_OPTIONS.map((trade) => <option key={trade} value={trade}>{trade}</option>)}</Select></label>
                  {invitePath === "message" || invitePath === "link" ? (
                    <>
                      <label className="space-y-1"><span className="text-sm font-semibold">Email</span><Input type="email" value={draft.email} onChange={(e) => patch({ email: e.target.value })} autoComplete="email" data-attr="vendor-essential-email" /></label>
                      <div className="space-y-1"><label htmlFor="vendor-invite-phone" className="text-sm font-semibold">Phone</label><PhoneNumberField id="vendor-invite-phone" value={draft.phone} onChange={(phone) => patch({ phone })} dataAttr="vendor-optional-phone" /></div>
                    </>
                  ) : null}
                  {invitePath === "code" ? (
                    <label className="space-y-1 sm:col-span-2">
                      <span className="text-sm font-semibold">{AXIS_ID_LABEL}</span>
                      {draftAxisId ? (
                        <div className="rounded-xl border border-primary/25 bg-primary/[0.05] px-4 py-3">
                          <p className="text-sm font-semibold text-foreground">{draftAxisName}</p>
                          <p className="mt-0.5 font-mono text-xs text-muted">{formatProplaneIdForDisplay(draftAxisId)}</p>
                        </div>
                      ) : (
                        <Input value={axisInput} onChange={(e) => setAxisInput(e.target.value)} className="font-mono" data-attr="vendor-proplane-id-input" />
                      )}
                    </label>
                  ) : null}
                  {invitePath === "link" && mintedVendorUrl ? (
                    <div className="flex items-center gap-2 sm:col-span-2">
                      <Input readOnly value={mintedVendorUrl} className="font-mono text-xs" data-attr="vendor-invite-url" />
                      <Button type="button" variant="outline" className="shrink-0" data-attr="vendor-invite-copy" onClick={() => { void navigator.clipboard.writeText(mintedVendorUrl).then(() => showToast("Invite link copied."), () => showToast("Could not copy.")); }}>
                        <Copy className="h-4 w-4" />
                        <span className="ml-1.5">Copy</span>
                      </Button>
                    </div>
                  ) : null}
                  <details className="sm:col-span-2"><summary className="cursor-pointer text-sm text-muted">Private notes</summary><Textarea aria-label="Private notes" value={draft.notes} onChange={(e) => patch({ notes: e.target.value })} rows={2} className="mt-2" data-attr="vendor-optional-notes" /></details>
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
      <PortalNotificationPreviewModal
        open={inviteSendPreview !== null}
        title="New message"
        onClose={() => setInviteSendPreview(null)}
        recipient={inviteSendPreview?.name ?? ""}
        recipientPhone={inviteSendPreview?.phone}
        subject={inviteSendPreview?.subject ?? ""}
        body={inviteSendPreview?.body ?? ""}
        showChannelPicker
        dynamicSendLabel
        emailAvailable={Boolean(inviteSendPreview?.email?.includes("@"))}
        smsAvailable={Boolean(inviteSendPreview?.phone?.trim())}
        defaultViaSms={Boolean(inviteSendPreview?.phone?.trim())}
        confirmLabel="Send invite"
        confirmLabelWithoutMessage="Add without sending"
        skipMessageLabel="Don't send a message"
        confirmBusy={saving}
        confirmBusyLabel="Sending…"
        cancelLabel="Back"
        onConfirm={(skipMessage, channels, messageDraft) => void confirmVendorInvite(skipMessage, channels, messageDraft)}
      />
    </>
  );
}
