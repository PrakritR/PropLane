"use client";

import { Copy } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import {
  readPendingManagerPropertiesForUser,
  readScopedExtraListings,
} from "@/lib/demo-property-pipeline";
import {
  filterVendorsForIssue,
  zipsForSelectedProperties,
  type VendorIssueSearchHit,
} from "@/lib/vendor-issue-search";
import { Button } from "@/components/ui/button";
import { CheckboxMultiSelect, FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input, Select, Textarea } from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import { MODAL_FIELD_LABEL_CLASS, PORTAL_MODAL_FORM_FIELD_CLASS, PORTAL_MODAL_FORM_FULL_ROW_CLASS, PORTAL_MODAL_FORM_GRID_CLASS } from "@/components/ui/modal";
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
  readOwnManagerVendorRows,
  setManagerVendorPriority,
  upsertManagerVendor,
  type ManagerVendorRow,
  type ManagerVendorTypicalRate,
} from "@/lib/manager-vendors-storage";
import { type AxisCatalogVendor } from "@/lib/axis-vendor-catalog";
import {
  centsFromDollarsInput,
  dollarsInputFromCents,
  expandTypicalRateCells,
  findRosterCatalogMatch,
  normalizeTypicalRates,
} from "@/lib/manager-vendor-typical-rates";
import { VENDOR_TRADE_OPTIONS } from "@/lib/work-order-taxonomy";


export type ManagerVendorFormDraft = {
  name: string;
  trade: string;
  trades: string[];
  phone: string;
  email: string;
  notes: string;
  active: boolean;
  sharedWithManagers: boolean;
  shareOnProplane: boolean;
  vendorPriority: "" | "primary" | "secondary";
  propertyIds: string[];
  catalogId?: string;
  typicalRates: ManagerVendorTypicalRate[];
};

export const EMPTY_MANAGER_VENDOR_FORM_DRAFT: ManagerVendorFormDraft = {
  name: "",
  trade: VENDOR_TRADE_OPTIONS[0]!,
  trades: [VENDOR_TRADE_OPTIONS[0]!],
  phone: "",
  email: "",
  notes: "",
  active: true,
  sharedWithManagers: false,
  shareOnProplane: false,
  vendorPriority: "",
  propertyIds: [],
  catalogId: undefined,
  typicalRates: [],
};

function draftFromVendor(row: ManagerVendorRow): ManagerVendorFormDraft {
  const trades = row.trades?.length ? row.trades : row.trade ? [row.trade] : [VENDOR_TRADE_OPTIONS[0]!];
  return {
    name: row.name,
    trade: row.trade || trades[0] || VENDOR_TRADE_OPTIONS[0]!,
    trades,
    phone: row.phone,
    email: row.email,
    notes: row.notes,
    active: row.active !== false,
    sharedWithManagers: row.sharedWithManagers === true,
    shareOnProplane: row.shareOnProplane === true,
    vendorPriority: row.vendorPriority ?? "",
    propertyIds: row.propertyIds ?? [],
    catalogId: row.catalogId,
    typicalRates: normalizeTypicalRates(row.typicalRates),
  };
}

function vendorEmailLooksValid(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  return Boolean(normalized && /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(normalized));
}

function TypicalPriceFields({
  houses,
  trades,
  rates,
  fallback,
  onChange,
}: {
  houses: readonly { id: string; label: string }[];
  trades: readonly string[];
  rates: readonly ManagerVendorTypicalRate[];
  fallback?: { hourlyCents: number; serviceCents: number };
  onChange: (next: ManagerVendorTypicalRate[]) => void;
}) {
  const cells = expandTypicalRateCells({
    propertyIds: houses.map((house) => house.id),
    trades,
    existing: rates,
    fallback,
  });
  const patchCell = (propertyId: string, trade: string, key: "hourlyCents" | "serviceCents", raw: string) => {
    const cents = centsFromDollarsInput(raw);
    onChange(
      cells.map((cell) =>
        cell.propertyId === propertyId && cell.trade === trade ? { ...cell, [key]: cents } : cell,
      ),
    );
  };
  if (houses.length === 0 || trades.length === 0) {
    return <p className="text-sm font-semibold">Pick a property and a trade first.</p>;
  }
  return (
    <div className="space-y-5" data-attr="vendor-form-typical-rates">
      {houses.map((house) => (
        <fieldset key={house.id} className="space-y-3">
          <legend className="text-sm font-semibold">{house.label}</legend>
          {trades.map((trade) => {
            const cell = cells.find((row) => row.propertyId === house.id && row.trade === trade);
            if (!cell) return null;
            return (
              <div key={`${house.id}-${trade}`} className="grid gap-3 sm:grid-cols-2">
                <p className="text-sm font-semibold sm:col-span-2">{trade}</p>
                <label className="block space-y-1">
                  <span className="text-sm font-semibold">Hourly</span>
                  <Input
                    inputMode="decimal"
                    value={dollarsInputFromCents(cell.hourlyCents)}
                    onChange={(e) => patchCell(house.id, trade, "hourlyCents", e.target.value)}
                    data-attr={`vendor-rate-hourly-${house.id}-${trade}`}
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-sm font-semibold">Typical service</span>
                  <Input
                    inputMode="decimal"
                    value={dollarsInputFromCents(cell.serviceCents)}
                    onChange={(e) => patchCell(house.id, trade, "serviceCents", e.target.value)}
                    data-attr={`vendor-rate-service-${house.id}-${trade}`}
                  />
                </label>
              </div>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
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
      </div>
    </div>
  );
}

export function ManagerVendorFormModal({
  open,
  mode,
  vendor,
  initialTrade,
  catalogVendor,
  onBrowseCatalog,
  onOpenExisting,
  onClose,
  onSaved,
  onDeleted,
  showToast,
}: {
  open: boolean;
  mode: "add" | "edit";
  vendor?: ManagerVendorRow | null;
  initialTrade?: string;
  catalogVendor?: AxisCatalogVendor | null;
  onBrowseCatalog?: () => void;
  onOpenExisting?: (vendorId: string) => void;
  onClose: () => void;
  onSaved?: () => void;
  onDeleted?: () => void;
  showToast: (message: string) => void;
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
  const [stepIdx, setStepIdx] = useState(0);
  const [issueQuery, setIssueQuery] = useState("");
  const [onlineHits, setOnlineHits] = useState<VendorIssueSearchHit[]>([]);
  const [checkedCatalogIds, setCheckedCatalogIds] = useState<string[]>([]);

  const propertyOptions = useMemo(
    () => buildManagerPropertyFilterOptions(userId).map((o) => ({ id: o.id, label: o.label })),
    [userId],
  );

  const propertyZips = useMemo(() => {
    const houses = [
      ...readScopedExtraListings(userId).map((row) => ({ id: row.id, zip: row.zip })),
      ...readPendingManagerPropertiesForUser(userId).map((row) => ({ id: row.id, zip: row.zip })),
    ];
    return zipsForSelectedProperties(houses, draft.propertyIds);
  }, [userId, draft.propertyIds]);

  const inPropLaneHits = useMemo(() => {
    const roster = readOwnManagerVendorRows(userId).map((row) => ({
      id: row.id,
      name: row.name,
      trade: row.trade,
      phone: row.phone,
      email: row.email,
      notes: row.notes,
    }));
    const { roster: own, catalog } = filterVendorsForIssue({
      issue: issueQuery,
      propertyZips,
      roster,
    });
    return [...own, ...catalog];
  }, [issueQuery, propertyZips, userId]);

  useEffect(() => {
    requestGeneration.current += 1;
    if (!open) return;
    if (mode === "edit" && vendor) {
      setDraft(draftFromVendor(vendor));
    } else {
      const trade = catalogVendor?.trade.trim() || initialTrade?.trim() || VENDOR_TRADE_OPTIONS[0]!;
      setDraft({
        ...EMPTY_MANAGER_VENDOR_FORM_DRAFT,
        name: catalogVendor?.name ?? "",
        trade,
        trades: [trade],
        phone: catalogVendor?.phone ?? "",
        email: catalogVendor?.email ?? "",
        notes: catalogVendor?.description ?? "",
        catalogId: catalogVendor?.catalogId,
        typicalRates: [],
      });
    }
    setError(null);
    setSaving(false);
    setInvitePath(catalogVendor?.phone?.trim() ? "message" : "link");
    setMintedVendorUrl(null);
    setInviteSendPreview(null);
    setAxisInput("");
    setDraftAxisId(null);
    setDraftAxisName(null);
    setRemovePreview(null);
    setCreatedVendorId(null);
    setStepIdx(0);
    setIssueQuery("");
    setOnlineHits([]);
    setCheckedCatalogIds([]);
  }, [open, mode, vendor, initialTrade, catalogVendor, userId]);

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
      trade: draft.trade.trim() || draft.trades[0] || VENDOR_TRADE_OPTIONS[0]!,
      trades: draft.trades.length ? draft.trades : undefined,
      phone: draft.phone.trim(),
      email: draft.email.trim(),
      notes: draft.notes.trim(),
      active: draft.active,
      sharedWithManagers: draft.sharedWithManagers,
      shareOnProplane: draft.shareOnProplane,
      vendorPriority: draft.vendorPriority || undefined,
      propertyIds: draft.propertyIds.length ? draft.propertyIds : undefined,
      catalogId: draft.catalogId || existing?.catalogId,
      typicalRates: expandTypicalRateCells({
        propertyIds: (draft.propertyIds.length ? draft.propertyIds : propertyOptions.map((row) => row.id)),
        trades: draft.trades,
        existing: draft.typicalRates,
        fallback: catalogVendor?.hourlyCents != null && catalogVendor.serviceCents != null
          ? { hourlyCents: catalogVendor.hourlyCents, serviceCents: catalogVendor.serviceCents }
          : undefined,
      }),
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
    const match = findRosterCatalogMatch(
      readOwnManagerVendorRows(userId).filter((item) => item.id !== row.id),
      {
      catalogId: row.catalogId,
      phone: row.phone,
      name: row.name,
      trade: row.trade,
    });
    if (match) {
      showToast("That vendor is already on Your vendors.");
      onOpenExisting?.(match.id);
      return;
    }
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
          assignedPropertyIds: draft.propertyIds,
        });
        if (!minted.ok) {
          if (current()) setError(minted.error);
          return;
        }
        url = minted.url;
        setMintedVendorUrl(url);
        if (invitePath === "link" && !catalogVendor) {
          setStepIdx(0);
          return;
        }
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

  useEffect(() => {
    if (!open || !issueQuery.trim()) {
      setOnlineHits([]);
      return;
    }
    const controller = new AbortController();
    const params = new URLSearchParams({ q: issueQuery.trim() });
    for (const zip of propertyZips) params.append("zip", zip);
    void fetch(`/api/portal-vendors/online-search?${params}`, { credentials: "include", signal: controller.signal })
      .then((res) => (res.ok ? res.json() : { rows: [] }))
      .then((body: { rows?: Array<{ id: string; name: string; trade: string; phone: string; city: string }> }) => {
        setOnlineHits(
          (body.rows ?? []).map((row) => ({
            source: "online" as const,
            id: row.id,
            name: row.name,
            trade: row.trade,
            phone: row.phone,
            city: row.city,
            zip: "",
            alreadyOwned: false,
          })),
        );
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [issueQuery, open, propertyZips]);

  const applyDirectoryHit = (hit: VendorIssueSearchHit) => {
    if (hit.alreadyOwned) return;
    const on = checkedCatalogIds.includes(hit.id);
    setCheckedCatalogIds((prev) => (on ? prev.filter((id) => id !== hit.id) : [...prev, hit.id]));
    if (!on) {
      patch({
        name: hit.name,
        trade: hit.trade,
        trades: [hit.trade],
        phone: hit.phone,
        email: hit.email ?? draft.email,
        catalogId: hit.source === "catalog" ? hit.id : draft.catalogId,
        typicalRates: expandTypicalRateCells({
          propertyIds: (draft.propertyIds.length ? draft.propertyIds : propertyOptions.map((row) => row.id)),
          trades: [hit.trade],
          existing: draft.typicalRates,
          fallback:
            hit.hourlyCents != null && hit.serviceCents != null
              ? { hourlyCents: hit.hourlyCents, serviceCents: hit.serviceCents }
              : undefined,
        }),
      });
    }
  };

  const isCatalogAdd = mode === "add" && Boolean(catalogVendor);
  const title = mode === "edit" ? "Edit vendor" : isCatalogAdd ? "Invite vendor" : "Add vendor";
  const steps: AddWorkspaceStep[] =
    mode === "edit"
      ? [
          { id: "vendor", label: "Vendor", incomplete: !draft.name.trim(), summary: draft.name.trim() || "Who they are" },
          { id: "properties", label: "Properties", summary: draft.propertyIds.length ? `${draft.propertyIds.length} houses` : "Every property" },
          { id: "trades", label: "Who can handle", incomplete: draft.trades.length === 0, summary: draft.trades.join(", ") || "No trades yet" },
          { id: "rates", label: "Typical price", summary: draft.typicalRates.length ? "Per house" : "Set rates" },
          { id: "review", label: "Review", incomplete: !draft.name.trim(), summary: "Save changes" },
        ]
      : isCatalogAdd
        ? [
            {
              id: "properties",
              label: "Properties",
              summary: draft.propertyIds.length ? `${draft.propertyIds.length} houses` : "Every property",
            },
          ]
        : [
          {
            id: "invite",
            label: "Invite by",
            summary: invitePath === "link" ? "Link" : invitePath === "message" ? "Message" : "PropLane code",
          },
          { id: "contact", label: "Contact", incomplete: !draft.name.trim(), summary: draft.name.trim() || "Name and phone" },
          { id: "properties", label: "Properties", summary: draft.propertyIds.length ? `${draft.propertyIds.length} houses` : "Every property" },
          { id: "trades", label: "What they do", incomplete: draft.trades.length === 0, summary: draft.trades.join(", ") || "No trades yet" },
          { id: "rates", label: "Typical price", summary: draft.typicalRates.length ? "Per house" : "Set rates" },
          { id: "review", label: "Review", incomplete: !draft.name.trim(), summary: "Invite vendor" },
        ];
  const current = Math.min(stepIdx, steps.length - 1);
  const stepId = steps[current]!.id;
  const onlineOnlyHits = onlineHits.filter((hit) => !inPropLaneHits.some((row) => row.id === hit.id));
  const rateHouses = draft.propertyIds.length
    ? propertyOptions.filter((row) => draft.propertyIds.includes(row.id))
    : propertyOptions;
  const rateFallback = catalogVendor?.hourlyCents != null && catalogVendor.serviceCents != null
    ? { hourlyCents: catalogVendor.hourlyCents, serviceCents: catalogVendor.serviceCents }
    : undefined;

  if (!open) return null;

  return (
    <>
      {removePreview === null && inviteSendPreview === null ? (
        <AddWorkspace
          title={title}
          steps={steps}
          current={current}
          onJump={setStepIdx}
          onClose={() => { if (!submitRef.current) onClose(); }}
          dirty={Boolean(draft.name.trim() || draft.email.trim() || draft.phone.trim())}
          discardTitle={mode === "edit" ? "Discard these edits?" : "Discard this vendor?"}
          assistantContext={title}
          assistantScopeKey={mode === "add" ? "invite-vendor" : "edit-vendor"}
          lastLabel={mode === "edit" ? "Save vendor" : isCatalogAdd ? "Invite" : "Invite vendor"}
          lastDisabled={saving || !draft.name.trim()}
          nextDisabled={false}
          onBeforeNext={() => {
            if (stepId === "trades" && draft.trades.length === 0) {
              setError("Pick what they do.");
              return false;
            }
            if (stepId === "contact" || stepId === "vendor") {
              if (!draft.name.trim()) {
                setError("Vendor name is required.");
                return false;
              }
              if (draft.email && !vendorEmailLooksValid(draft.email)) {
                setError("Enter a valid email address.");
                return false;
              }
            }
            setError(null);
            return true;
          }}
          busy={saving}
          onFinish={() => {
            if (mode === "edit") void saveEdit();
            else void continueVendorInvite();
          }}
          dataAttrPrefix="vendor-form"
          finishDataAttr={mode === "edit" ? "vendor-form-save" : "vendor-form-continue"}
          dangerAction={
            mode === "edit" && vendor ? (
              <Button
                type="button"
                variant="outline"
                className="rounded-full border-red-200 text-red-700 hover:bg-red-50"
                onClick={remove}
                data-attr="vendor-form-delete"
              >
                Delete
              </Button>
            ) : undefined
          }
        >
          {stepId === "invite" ? (
            <div className="space-y-4" data-attr="vendor-form-invite-by">
              <PortalInvitePaths value={invitePath} onChange={setInvitePath} disabled={saving} />
              {invitePath === "code" ? (
                <label className="block space-y-1">
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
                <div className="flex items-center gap-2">
                  <Input readOnly value={mintedVendorUrl} className="font-mono text-xs" data-attr="vendor-invite-url" />
                  <Button type="button" variant="outline" className="shrink-0" data-attr="vendor-invite-copy" onClick={() => { void navigator.clipboard.writeText(mintedVendorUrl).then(() => showToast("Invite link copied."), () => showToast("Could not copy.")); }}>
                    <Copy className="h-4 w-4" />
                    <span className="ml-1.5">Copy</span>
                  </Button>
                </div>
              ) : null}
              {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
            </div>
          ) : null}
          {stepId === "vendor" ? (
            <div className="space-y-4">
              <label className="block space-y-1">
                <span className="text-sm font-semibold">Vendor name</span>
                <Input value={draft.name} onChange={(e) => patch({ name: e.target.value })} required autoFocus data-attr="vendor-essential-name" />
              </label>
              <label className="block space-y-1">
                <span className="text-sm font-semibold">Email</span>
                <Input type="email" value={draft.email} onChange={(e) => patch({ email: e.target.value })} autoComplete="email" data-attr="vendor-essential-email" />
              </label>
              <div className="space-y-1">
                <label htmlFor="vendor-invite-phone" className="text-sm font-semibold">Phone</label>
                <PhoneNumberField id="vendor-invite-phone" value={draft.phone} onChange={(phone) => patch({ phone })} dataAttr="vendor-optional-phone" />
              </div>
              {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
            </div>
          ) : null}
          {stepId === "properties" ? (
            <div className="space-y-4">
              {isCatalogAdd && catalogVendor ? (
                <div className="rounded-2xl border border-border bg-card px-4 py-3 text-[13.5px]" data-attr="vendor-catalog-invite-facts">
                  <p className="font-semibold">{catalogVendor.name}</p>
                  <p className="mt-1">{[catalogVendor.trade, catalogVendor.phone, catalogVendor.email].filter(Boolean).join(" · ")}</p>
                </div>
              ) : null}
              <CheckboxMultiSelect
                label="Properties"
                dataAttr="vendor-form-properties"
                emptyLabel="Every property"
                selectionTriggerLabel={draft.propertyIds.length === 0 ? "Every property" : undefined}
                options={[
                  { value: "__all__", label: "Every property" },
                  ...propertyOptions.map((option) => ({ value: option.id, label: option.label })),
                ]}
                selected={draft.propertyIds.length === 0 ? ["__all__"] : draft.propertyIds}
                onChange={(next) => {
                  const houses = next.filter((id) => id !== "__all__");
                  const pickedAll = next.includes("__all__");
                  const wasAll = draft.propertyIds.length === 0;
                  if (pickedAll && !wasAll) {
                    patch({ propertyIds: [] });
                    return;
                  }
                  if (pickedAll && wasAll && houses.length > 0) {
                    patch({ propertyIds: houses });
                    return;
                  }
                  patch({ propertyIds: houses });
                }}
              />
              {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
            </div>
          ) : null}
          {stepId === "trades" ? (
            <div className="space-y-4" data-attr="vendor-form-trades">
              <fieldset className="space-y-2">
                <legend className="text-sm font-semibold">{mode === "add" ? "What they do" : "Who can handle"}</legend>
                {VENDOR_TRADE_OPTIONS.map((trade) => {
                  const on = draft.trades.includes(trade);
                  return (
                    <label key={trade} className="flex min-h-11 items-center gap-3 rounded-xl border border-border bg-card px-3 text-[13.5px]">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => {
                          const trades = on ? draft.trades.filter((item) => item !== trade) : [...draft.trades, trade];
                          patch({ trades, trade: trades[0] ?? trade });
                        }}
                        data-attr={`vendor-trade-${trade}`}
                      />
                      {trade}
                    </label>
                  );
                })}
              </fieldset>
              {mode === "add" && onBrowseCatalog ? (
                <Button type="button" variant="outline" onClick={onBrowseCatalog} data-attr="vendor-use-proplane">
                  Use a PropLane vendor
                </Button>
              ) : null}
              {mode === "edit" ? (
                <>
              <label className="block space-y-1">
                <span className="text-sm font-semibold">Look up nearby</span>
                <Input value={issueQuery} onChange={(e) => setIssueQuery(e.target.value)} placeholder="Trade, name, or city" data-attr="vendor-online-search" />
              </label>
              {inPropLaneHits.length ? (
                <fieldset className="space-y-2" data-attr="vendor-in-proplane-hits">
                  <legend className="text-sm font-semibold">In PropLane</legend>
                  {inPropLaneHits.map((hit) => (
                    <label key={hit.id} className="flex min-h-11 items-center gap-3 rounded-xl border border-border bg-card px-3 text-[13.5px]">
                      <input
                        type="checkbox"
                        checked={hit.alreadyOwned || checkedCatalogIds.includes(hit.id)}
                        disabled={hit.alreadyOwned}
                        onChange={() => applyDirectoryHit(hit)}
                        data-attr={`vendor-directory-${hit.id}`}
                      />
                      <span className="min-w-0">
                        <span className="block font-medium">{hit.name}</span>
                        <span className="block text-[12px] text-foreground">{[hit.trade, hit.phone, hit.city].filter(Boolean).join(" · ")}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
              ) : null}
              {onlineOnlyHits.length ? (
                <fieldset className="space-y-2" data-attr="vendor-online-hits">
                  <legend className="text-sm font-semibold">Online</legend>
                  {onlineOnlyHits.map((hit) => (
                    <label key={hit.id} className="flex min-h-11 items-center gap-3 rounded-xl border border-border bg-card px-3 text-[13.5px]">
                      <input
                        type="checkbox"
                        checked={checkedCatalogIds.includes(hit.id)}
                        onChange={() => applyDirectoryHit(hit)}
                        data-attr={`vendor-online-${hit.id}`}
                      />
                      <span className="min-w-0">
                        <span className="block font-medium">{hit.name}</span>
                        <span className="block text-[12px] text-foreground">{[hit.trade, hit.phone, hit.city].filter(Boolean).join(" · ")}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
              ) : null}
                </>
              ) : null}
              {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
            </div>
          ) : null}
          {stepId === "rates" ? (
            <TypicalPriceFields
              houses={rateHouses}
              trades={draft.trades}
              rates={draft.typicalRates}
              fallback={rateFallback}
              onChange={(typicalRates) => patch({ typicalRates })}
            />
          ) : null}
          {stepId === "contact" ? (
            <div className="space-y-4">
              <label className="block space-y-1">
                <span className="text-sm font-semibold">Invite by first name</span>
                <Input value={draft.name} onChange={(e) => patch({ name: e.target.value })} required autoFocus data-attr="vendor-essential-name" />
              </label>
              <label className="block space-y-1">
                <span className="text-sm font-semibold">Email</span>
                <Input type="email" value={draft.email} onChange={(e) => patch({ email: e.target.value })} autoComplete="email" data-attr="vendor-essential-email" />
              </label>
              <div className="space-y-1">
                <label htmlFor="vendor-invite-phone" className="text-sm font-semibold">Phone</label>
                <PhoneNumberField id="vendor-invite-phone" value={draft.phone} onChange={(phone) => patch({ phone })} dataAttr="vendor-optional-phone" />
              </div>
              {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
            </div>
          ) : null}
          {stepId === "review" ? (
            <div className="space-y-4">
              <p className="text-[13.5px]">{[draft.name, draft.trade, draft.email, draft.phone].filter(Boolean).join(" · ")}</p>
              <FieldSingleSelect
                label="Share on PropLane"
                dataAttr="vendor-share-on-proplane"
                value={draft.shareOnProplane ? "on" : "off"}
                onChange={(next) => patch({ shareOnProplane: next === "on" })}
                options={[
                  { value: "off", label: "Off — only on Your vendors" },
                  { value: "on", label: "On — show on PropLane vendors" },
                ]}
              />
              {mode === "edit" ? <ManagerVendorFormFields draft={draft} onPatch={patch} /> : null}
              {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
            </div>
          ) : null}
        </AddWorkspace>
      ) : null}

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
