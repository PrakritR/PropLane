"use client";
import { useListingContactWorkEmail } from "@/hooks/use-listing-contact-work-email";
import { useListingContactSmsPhone } from "@/hooks/use-listing-contact-sms-phone";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import {
  PortalPropertyDetailSection,
} from "@/components/portal/portal-property-detail-section";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { ManagerPortalStatusPills } from "@/components/portal/portal-metrics";
import { ZillowRentalNetworkRow } from "@/components/portal/zillow-rental-network-row";
import { Settings } from "lucide-react";
import { PortalPropertySectionSettingsModal } from "@/components/portal/portal-property-section-settings-modal";
import { PortalSettingsToggle } from "@/components/portal/portal-settings-ui";
import { updateRequestChangeProperty } from "@/lib/demo-admin-property-inventory";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { PromotionAssetStack, promotionAssetCanEdit } from "@/components/portal/promotion-asset-list";
import { PromotionAssetViewModal } from "@/components/portal/promotion-asset-view-modal";
import {
  EMPTY_DRAFT,
  PromotionForm,
  draftInputs,
  draftWithPropertyKey,
  promotionTextIdentityFromDraft,
  CUSTOM_PROPERTY_KEY,
  type PromotionDraft,
} from "@/components/portal/promotion-form";
import { PromotionNewModal } from "@/components/portal/promotion-new-modal";
import { PromotionTextGenerateModal } from "@/components/portal/promotion-text-generate-modal";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { track } from "@/lib/analytics/track-client";
import {
  syncPropertyPipelineFromServer,
  PROPERTY_PIPELINE_EVENT,
  updatePendingManagerProperty,
  updateExtraListingFromSubmission,
} from "@/lib/demo-property-pipeline";
import { buildManagerPromotionPropertyOptions } from "@/lib/manager-property-links";
import {
  MANAGER_PROMOTIONS_EVENT,
  generateFlyerCopy,
  generatePromotionTextCopy,
  makePromotionId,
  readManagerPromotionRows,
  syncManagerPromotionsFromServer,
  upsertManagerPromotion,
  deleteManagerPromotionRow,
} from "@/lib/manager-promotions-storage";
import {
  flattenPromotionAssets,
  nextPromotionAssetDefaultTitle,
  promotionAssetMatchesQuery,
  sortPromotionAssets,
  type PromotionAsset,
  type PromotionAssetKind,
} from "@/lib/promotion-assets";
import {
  FLYER_IMAGE_LIMIT,
  PROMOTION_TEMPLATE_DEFAULT,
  normalizePromotionTemplate,
  PROMOTION_TONE_OPTIONS,
  readFlyerEntries,
  type FlyerEntry,
  type ManagerPromotionRow,
} from "@/lib/promotion-flyer";
import {
  buildFlyerEntryFromDraft,
  buildTextEntryFromCopy,
  removeFlyerEntryFromRow,
  removeTextEntryFromRow,
  removeUploadEntryFromRow,
  appendUploadEntryToRow,
  syncPromotionRowLegacy,
  updateFlyerEntryOnRow,
  updateTextEntryOnRow,
} from "@/lib/promotion-row-ops";
import { type PromotionTextFormat } from "@/lib/promotion-text";
import {
  fileToPromotionUpload,
  makePromotionUploadId,
  type PromotionUploadEntry,
} from "@/lib/promotion-upload";
import { PropertyPromotionBuiltinModal } from "@/components/portal/property-promotion-builtin-modal";
import { PropertyPromotionBuiltinFacts, PropertyPromotionBuiltinRow } from "@/components/portal/property-promotion-builtin-row";
import {
  BUILTIN_PROMOTION_DEFS,
  filterCustomPromotionAssets,
  resolveBuiltinFlyerEntry,
  resolveBuiltinTextPromotion,
  type PropertyPromotionBuiltinKey,
  readPromotionBuiltins,
  builtinEnabled,
  type PropertyPromotionBuiltinsState,
} from "@/lib/property-promotion-builtin";
import type { MockProperty } from "@/data/types";
import { usePortalRowSelection } from "@/hooks/use-portal-row-selection";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { useConfirm } from "@/components/providers/app-ui-provider";

function promotionEntryId(asset: PromotionAsset): string | null {
  if (asset.kind === "flyer") return asset.flyerEntry?.id ?? null;
  if (asset.kind === "text") return asset.textEntry?.id ?? null;
  if (asset.kind === "upload") return asset.uploadEntry?.id ?? null;
  return null;
}

function flyerEntryToDraft(
  row: ManagerPromotionRow,
  entry: FlyerEntry,
  listings: ReturnType<typeof buildManagerPromotionPropertyOptions>,
): PromotionDraft {
  return {
    propertyKey:
      row.propertyId && listings.some((l) => l.id === row.propertyId)
        ? row.propertyId
        : CUSTOM_PROPERTY_KEY,
    propertyLabel: row.propertyLabel,
    address: entry.inputs.address ?? "",
    title: entry.title,
    headline: entry.inputs.headline,
    sellingPoints: entry.inputs.sellingPoints,
    customDetails: entry.inputs.customDetails,
    price: entry.inputs.price,
    promo: entry.inputs.promo,
    cta: entry.inputs.cta,
    contact: entry.inputs.contact,
    schedulingUrl: entry.inputs.schedulingUrl ?? "",
    includeSchedulingLink: entry.inputs.includeSchedulingLink ?? true,
    theme: entry.theme,
    flyerSize: entry.flyerSize,
    template: normalizePromotionTemplate(entry.template),
    tone: entry.inputs.tone || PROMOTION_TONE_OPTIONS[0]!,
    aiPrompt: "",
    images: entry.inputs.images ?? [],
  };
}

type PromotionSaveTarget =
  | { mode: "pending"; saveId: string }
  | { mode: "listing"; saveId: string }
  | { mode: "requestChange"; saveId: string }
  | null;

export function ManagerPropertyPromotionPanel({
  listingId,
  property,
  showToast,
  onUpdated,
  headerActionsExtra,
  sub,
  saveTarget,
  propertyLabel,
}: {
  listingId: string;
  property?: MockProperty | null;
  showToast: (m: string) => void;
  onUpdated?: () => void;
  headerActionsExtra?: ReactNode;
  /** For the Settings gear's Zillow Rental Network toggle (S016). */
  sub?: ManagerListingSubmissionV1 | null;
  saveTarget?: PromotionSaveTarget;
  propertyLabel?: string;
}) {
  const { userId, ready: authReady } = useManagerUserId();
  // Aborts the copy request owned by whichever compose modal is open.
  const generateAbortRef = useRef<AbortController | null>(null);
  const [tick, setTick] = useState(0);
  const [propertyTick, setPropertyTick] = useState(0);
  const [showNewModal, setShowNewModal] = useState(false);
  const [newPromotionKind, setNewPromotionKind] = useState<PromotionAssetKind>("flyer");
  const [newPromotionStepId, setNewPromotionStepId] = useState<"kind" | "content">("kind");
  const [uploadBusy, setUploadBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<PromotionDraft>(EMPTY_DRAFT);
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generatingTextId, setGeneratingTextId] = useState<string | null>(null);
  const [textModalAssetId, setTextModalAssetId] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewAssetId, setPreviewAssetId] = useState<string | null>(null);
  const [promoTab, setPromoTab] = useState<"flyers" | "social" | "sites" | "yours">("flyers");
  const [promoSearch, setPromoSearch] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [zillowSaving, setZillowSaving] = useState(false);
  const [builtinEditKey, setBuiltinEditKey] = useState<PropertyPromotionBuiltinKey | null>(null);
  const [builtinDraft, setBuiltinDraft] = useState<PromotionDraft>(EMPTY_DRAFT);
  const [builtinTextBody, setBuiltinTextBody] = useState("");
  const [builtinSaving, setBuiltinSaving] = useState(false);

  const promotionBuiltins = useMemo(() => readPromotionBuiltins(sub), [sub]);

  useEffect(() => {
    if (!authReady) return;
    void syncManagerPromotionsFromServer({ force: true });
    void syncPropertyPipelineFromServer({ force: true });
  }, [authReady, userId]);

  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    const bumpProps = () => setPropertyTick((n) => n + 1);
    window.addEventListener(MANAGER_PROMOTIONS_EVENT, bump);
    window.addEventListener(PROPERTY_PIPELINE_EVENT, bumpProps);
    return () => {
      window.removeEventListener(MANAGER_PROMOTIONS_EVENT, bump);
      window.removeEventListener(PROPERTY_PIPELINE_EVENT, bumpProps);
    };
  }, []);

  const listings = useMemo(() => {
    void propertyTick;
    return buildManagerPromotionPropertyOptions(userId);
  }, [userId, propertyTick]);

  const workEmail = useListingContactWorkEmail({ listingId, viewerManagerUserId: userId });
  const workPhone = useListingContactSmsPhone({ listingId, viewerManagerUserId: userId });
  const autofillOpts = useMemo(
    () => ({
      managerContact: [workPhone, workEmail].filter(Boolean).join(" · "),
      appOrigin: typeof window !== "undefined" ? window.location.origin : "",
    }),
    [workPhone, workEmail],
  );

  const propertyId = listingId.trim();

  const promotionRow = useMemo(() => {
    void tick;
    if (!propertyId) return null;
    return readManagerPromotionRows().find((row) => row.propertyId === propertyId) ?? null;
  }, [propertyId, tick]);

  const assets = useMemo(() => {
    void tick;
    if (!propertyId) return [];
    const rows = readManagerPromotionRows().filter((row) => row.propertyId === propertyId);
    return sortPromotionAssets(flattenPromotionAssets(rows), "newest");
  }, [propertyId, tick]);

  const customAssets = useMemo(() => filterCustomPromotionAssets(assets), [assets]);

  const visibleBuiltins = useMemo(() => {
    if (!property || promoTab === "sites" || promoTab === "yours") return [];
    const q = promoSearch.trim().toLowerCase();
    return BUILTIN_PROMOTION_DEFS.filter(
      (def) => def.tab === promoTab && (!q || def.name.toLowerCase().includes(q)),
    );
  }, [property, promoTab, promoSearch]);

  const visibleAssets = useMemo(() => {
    const q = promoSearch.trim().toLowerCase();
    if (promoTab === "sites") return [];
    if (promoTab === "yours") {
      const tabbed = customAssets;
      if (!q) return tabbed;
      return tabbed.filter((asset) => promotionAssetMatchesQuery(asset, q));
    }
    const kind = promoTab === "flyers" ? "flyer" : "text";
    const tabbed = filterCustomPromotionAssets(assets.filter((a) => a.kind === kind));
    if (!q) return tabbed;
    return tabbed.filter((asset) => promotionAssetMatchesQuery(asset, q));
  }, [assets, customAssets, promoTab, promoSearch]);

  const { selectedIds, toggleSelected, clearSelection } = usePortalRowSelection(visibleAssets.length);

  const zillow = sub?.syndication?.zillow;
  const zillowEnabled = zillow?.enabled ?? false;

  const persistZillowToggle = useCallback(
    (nextEnabled: boolean) => {
      if (!sub || !saveTarget) return;
      setZillowSaving(true);
      const nextSub: ManagerListingSubmissionV1 = {
        ...sub,
        syndication: { ...sub.syndication, zillow: { ...zillow, enabled: nextEnabled } },
      };
      let ok = false;
      if (saveTarget.mode === "pending") {
        ok = updatePendingManagerProperty(saveTarget.saveId, nextSub, userId ?? "");
      } else if (saveTarget.mode === "listing") {
        ok = updateExtraListingFromSubmission(saveTarget.saveId, userId ?? "", nextSub);
      } else if (saveTarget.mode === "requestChange") {
        ok = updateRequestChangeProperty(saveTarget.saveId, userId ?? "", nextSub);
      }
      setZillowSaving(false);
      if (!ok) {
        showToast("Could not save promotion settings.");
        return;
      }
      showToast(nextEnabled ? "Listed on the Zillow Rental Network." : "Removed from the Zillow Rental Network.");
      onUpdated?.();
    },
    [sub, saveTarget, zillow, userId, showToast, onUpdated],
  );

  const persistPromotionBuiltins = useCallback(
    (nextBuiltins: PropertyPromotionBuiltinsState) => {
      if (!sub || !saveTarget) return false;
      const nextSub: ManagerListingSubmissionV1 = { ...sub, promotionBuiltins: nextBuiltins };
      let ok = false;
      if (saveTarget.mode === "pending") {
        ok = updatePendingManagerProperty(saveTarget.saveId, nextSub, userId ?? "");
      } else if (saveTarget.mode === "listing") {
        ok = updateExtraListingFromSubmission(saveTarget.saveId, userId ?? "", nextSub);
      } else if (saveTarget.mode === "requestChange") {
        ok = updateRequestChangeProperty(saveTarget.saveId, userId ?? "", nextSub);
      }
      if (!ok) {
        showToast("Could not save promotion settings.");
        return false;
      }
      onUpdated?.();
      return true;
    },
    [sub, saveTarget, userId, showToast, onUpdated],
  );

  const toggleBuiltin = useCallback(
    (key: PropertyPromotionBuiltinKey) => {
      const enabled = builtinEnabled(promotionBuiltins, key);
      const next: PropertyPromotionBuiltinsState = {
        ...promotionBuiltins,
        [key]: { ...promotionBuiltins[key], enabled: !enabled },
      };
      if (persistPromotionBuiltins(next)) {
        showToast(enabled ? "Default promotion turned off." : "Default promotion turned on.");
      }
    },
    [promotionBuiltins, persistPromotionBuiltins, showToast],
  );

  const openBuiltinEditor = useCallback(
    (key: PropertyPromotionBuiltinKey) => {
      if (!property) return;
      const def = BUILTIN_PROMOTION_DEFS.find((d) => d.key === key);
      if (!def) return;
      setBuiltinEditKey(key);
      if (def.kind === "flyer") {
        const entry = resolveBuiltinFlyerEntry(
          propertyId,
          property,
          promotionRow,
          promotionBuiltins.flyer,
          autofillOpts,
        );
        if (entry && promotionRow) {
          setBuiltinDraft(flyerEntryToDraft(promotionRow, entry, listings));
        } else if (entry) {
          setBuiltinDraft({
            ...draftWithPropertyKey(EMPTY_DRAFT, propertyId, listings, autofillOpts),
            ...flyerEntryToDraft(
              {
                id: "preview",
                managerUserId: userId,
                propertyId,
                propertyLabel: listings.find((l) => l.id === propertyId)?.label ?? property.title,
                title: def.name,
                theme: entry.theme,
                flyerSize: entry.flyerSize,
                template: entry.template,
                status: "generated",
                inputs: entry.inputs,
                copy: entry.copy,
                createdAt: entry.createdAt,
                updatedAt: entry.updatedAt,
              },
              entry,
              listings,
            ),
          });
        }
      } else if (def.kind === "text" && def.textFormat) {
        const { plain } = resolveBuiltinTextPromotion(
          property,
          def.textFormat,
          promotionRow,
          promotionBuiltins,
          key === "social" ? "social" : "blurb",
          autofillOpts,
        );
        setBuiltinTextBody(plain);
        setBuiltinDraft(draftWithPropertyKey(EMPTY_DRAFT, propertyId, listings, autofillOpts));
      } else {
        setBuiltinDraft(draftWithPropertyKey(EMPTY_DRAFT, propertyId, listings, autofillOpts));
      }
    },
    [property, propertyId, promotionRow, promotionBuiltins, autofillOpts, listings, userId],
  );

  const saveBuiltinEditor = useCallback(() => {
    if (!builtinEditKey || !sub || !saveTarget) return;
    setBuiltinSaving(true);
    const key = builtinEditKey;
    const def = BUILTIN_PROMOTION_DEFS.find((d) => d.key === key);
    const nextBuiltins: PropertyPromotionBuiltinsState = { ...promotionBuiltins };
    if (def?.kind === "flyer") {
      nextBuiltins.flyer = {
        ...nextBuiltins.flyer,
        enabled: nextBuiltins.flyer?.enabled !== false,
        flyer: {
          headline: builtinDraft.headline,
          sellingPoints: builtinDraft.sellingPoints,
          price: builtinDraft.price,
          promo: builtinDraft.promo,
          cta: builtinDraft.cta,
          contact: builtinDraft.contact,
        },
      };
    } else if (def?.kind === "text") {
      const textKey = key === "social" ? "social" : "blurb";
      nextBuiltins[textKey] = {
        ...nextBuiltins[textKey],
        enabled: nextBuiltins[textKey]?.enabled !== false,
        text: { body: builtinTextBody, tone: builtinDraft.tone },
      };
    }
    persistPromotionBuiltins(nextBuiltins);
    setBuiltinSaving(false);
    setBuiltinEditKey(null);
    showToast("Default promotion saved.");
  }, [
    builtinEditKey,
    sub,
    saveTarget,
    promotionBuiltins,
    builtinDraft,
    builtinTextBody,
    persistPromotionBuiltins,
    showToast,
  ]);

  // Open the unified new-promotion workspace on Kind.
  const openNewPromotion = useCallback(() => {
    setEditingRowId(null);
    setEditingEntryId(null);
    setNewPromotionKind("flyer");
    setNewPromotionStepId("kind");
    setDraft(draftWithPropertyKey(EMPTY_DRAFT, propertyId, listings, autofillOpts));
    setShowNewModal(true);
  }, [listings, propertyId, autofillOpts]);

  const openViewAsset = useCallback((asset: PromotionAsset) => {
    setPreviewAssetId(asset.id);
    setPreviewOpen(true);
  }, []);

  const closePreview = useCallback(() => {
    setPreviewOpen(false);
    setPreviewAssetId(null);
  }, []);

  const openEditFlyer = useCallback(
    (row: ManagerPromotionRow, entryId: string) => {
      const entry = readFlyerEntries(row).find((e) => e.id === entryId) ?? null;
      if (!entry) return;
      setDraft(flyerEntryToDraft(row, entry, listings));
      setEditingRowId(row.id);
      setEditingEntryId(entryId);
      setShowForm(true);
    },
    [listings],
  );

  const openEditAsset = useCallback(
    (asset: PromotionAsset) => {
      closePreview();
      if (asset.kind === "flyer" && asset.flyerEntry) {
        openEditFlyer(asset.row, asset.flyerEntry.id);
        return;
      }
      if (asset.kind === "text" && asset.textEntry) {
        setTextModalAssetId(asset.id);
      }
    },
    [closePreview, openEditFlyer],
  );

  // Closes every promotion compose surface — the unified new modal, the
  // edit-flyer modal and the standalone text modal — so no caller can leave one
  // of them open after a write. Dismissing also aborts an in-flight generate, so
  // a cancelled request can never land a row behind the closed modal.
  const closeForm = useCallback(() => {
    generateAbortRef.current?.abort();
    setShowForm(false);
    setShowNewModal(false);
    setTextModalAssetId(null);
    setEditingRowId(null);
    setEditingEntryId(null);
    setNewPromotionKind("flyer");
    setNewPromotionStepId("kind");
    setDraft(EMPTY_DRAFT);
    // The bar exists to reach these editors; leaving the row ticked afterwards
    // just parks a floating bar over a row the manager is done with.
    clearSelection();
  }, [clearSelection]);

  async function generate() {
    const label = draft.propertyLabel.trim();
    const entryTitle = draft.title.trim() || nextPromotionAssetDefaultTitle(assets, "flyer");
    if (!label && !draft.headline.trim()) {
      showToast("Add a property/listing or a headline first.");
      return;
    }
    const editingRow = editingRowId ? readManagerPromotionRows().find((p) => p.id === editingRowId) ?? null : null;
    const abort = new AbortController();
    generateAbortRef.current = abort;
    setGenerating(true);
    if (editingRow) {
      track("promotion_regenerated", { theme: draft.theme, template: draft.template });
    } else {
      track("promotion_generation_started", {
        theme: draft.theme,
        flyer_size: draft.flyerSize,
        template: draft.template,
        photo_count: draft.images.length,
      });
    }
    try {
      const inputs = draftInputs(draft);
      const { copy, source } = await generateFlyerCopy(inputs, label, {
        propertyId,
        extraInstructions: draft.aiPrompt,
        signal: abort.signal,
      });
      if (source === "cancelled") return;
      if (source === "forbidden") {
        showToast("You can only create flyers for your own properties.");
        return;
      }
      const now = new Date().toISOString();
      let savedRow: ManagerPromotionRow;
      let entryId: string;

      if (editingRow && editingEntryId) {
        entryId = editingEntryId;
        savedRow = updateFlyerEntryOnRow(editingRow, editingEntryId, {
          title: entryTitle,
          copy,
          inputs,
          theme: draft.theme,
          flyerSize: draft.flyerSize,
          template: draft.template,
        });
      } else {
        const entry = buildFlyerEntryFromDraft({
          title: entryTitle,
          copy,
          inputs,
          theme: draft.theme,
          flyerSize: draft.flyerSize,
          template: draft.template,
          now,
        });
        entryId = entry.id;
        savedRow = syncPromotionRowLegacy({
          id: makePromotionId(),
          managerUserId: userId ?? null,
          propertyId,
          propertyLabel: label,
          title: entryTitle,
          theme: draft.theme,
          flyerSize: draft.flyerSize,
          template: draft.template,
          status: "generated",
          inputs,
          copy,
          textCopy: null,
          flyerCopies: [entry],
          createdAt: now,
          updatedAt: now,
        });
      }

      upsertManagerPromotion({ ...savedRow, updatedAt: now });
      closeForm();
      setTick((n) => n + 1);
      onUpdated?.();
      showToast(
        editingRow
          ? "Flyer updated."
          : source === "ai"
            ? "Flyer generated."
            : "Flyer generated (offline copy).",
      );
    } catch {
      showToast(editingRow ? "Could not update the flyer. Try again." : "Could not generate the flyer. Try again.");
    } finally {
      if (generateAbortRef.current === abort) generateAbortRef.current = null;
      setGenerating(false);
    }
  }

  async function createOrRegenerateText(
    opts: { format: PromotionTextFormat; tone: string; extraInstructions: string; images: string[] },
    asset: PromotionAsset | null,
  ) {
    const abort = new AbortController();
    generateAbortRef.current = abort;
    if (asset?.textEntry) {
      setGeneratingTextId(asset.textEntry.id);
      try {
        const inputs = {
          ...asset.row.inputs,
          tone: opts.tone.trim() || asset.row.inputs.tone,
          images: opts.images.slice(0, FLYER_IMAGE_LIMIT),
        };
        const { copy, source } = await generatePromotionTextCopy(
          inputs,
          asset.row.propertyLabel,
          opts.format,
          {
            propertyId: asset.row.propertyId,
            extraInstructions: opts.extraInstructions,
            signal: abort.signal,
          },
        );
        if (source === "cancelled") return;
        if (source === "forbidden") {
          showToast("You can only create promotions for your own properties.");
          return;
        }
        upsertManagerPromotion(
          updateTextEntryOnRow({ ...asset.row, inputs }, asset.textEntry.id, {
            copy,
            updatedAt: new Date().toISOString(),
          }),
        );
        setTextModalAssetId(null);
        setTick((n) => n + 1);
        onUpdated?.();
        showToast(source === "ai" ? "Promotion text generated." : "Promotion text generated (offline copy).");
      } catch {
        showToast("Could not generate promotion text.");
      } finally {
        if (generateAbortRef.current === abort) generateAbortRef.current = null;
        setGeneratingTextId(null);
      }
      return;
    }

    const base = draft;
    const { propertyLabel: label } = promotionTextIdentityFromDraft(base);
    const entryTitle = nextPromotionAssetDefaultTitle(assets, "text");
    setGeneratingTextId("__new__");
    try {
      const inputs = draftInputs({
        ...base,
        tone: opts.tone.trim() || base.tone,
        images: opts.images,
      });
      const { copy, source } = await generatePromotionTextCopy(inputs, label, opts.format, {
        propertyId,
        extraInstructions: opts.extraInstructions,
        signal: abort.signal,
      });
      if (source === "cancelled") return;
      if (source === "forbidden") {
        showToast("You can only create promotions for your own properties.");
        return;
      }
      const now = new Date().toISOString();
      const entry = buildTextEntryFromCopy(copy, entryTitle, now);
      const row = syncPromotionRowLegacy({
        id: makePromotionId(),
        managerUserId: userId ?? null,
        propertyId,
        propertyLabel: label,
        title: entryTitle,
        theme: "cobalt",
        flyerSize: "letter",
        template: PROMOTION_TEMPLATE_DEFAULT,
        status: "generated",
        inputs,
        copy: null,
        textCopy: copy,
        textCopies: [entry],
        createdAt: now,
        updatedAt: now,
      });
      upsertManagerPromotion(row);
      closeForm();
      setTick((n) => n + 1);
      onUpdated?.();
      showToast(source === "ai" ? "Promotion text created." : "Promotion text created (offline copy).");
    } catch {
      showToast("Could not generate promotion text.");
    } finally {
      if (generateAbortRef.current === abort) generateAbortRef.current = null;
      setGeneratingTextId(null);
    }
  }

  function deleteAsset(asset: PromotionAsset, options?: { quiet?: boolean }) {
    if (asset.kind === "flyer" && asset.flyerEntry) {
      const next = removeFlyerEntryFromRow(asset.row, asset.flyerEntry.id);
      if (next) upsertManagerPromotion(next);
      else deleteManagerPromotionRow(asset.row.id);
    } else if (asset.kind === "text" && asset.textEntry) {
      const next = removeTextEntryFromRow(asset.row, asset.textEntry.id);
      if (next) upsertManagerPromotion(next);
      else deleteManagerPromotionRow(asset.row.id);
    } else if (asset.kind === "upload" && asset.uploadEntry) {
      const next = removeUploadEntryFromRow(asset.row, asset.uploadEntry.id);
      if (next) upsertManagerPromotion(next);
      else deleteManagerPromotionRow(asset.row.id);
    }
    setTick((n) => n + 1);
    onUpdated?.();
    if (!options?.quiet) showToast("Promotion deleted.");
  }

  const confirm = useConfirm();

  async function handleDeleteAsset(asset: PromotionAsset) {
    const title = asset.flyerEntry?.title ?? asset.textEntry?.title ?? asset.uploadEntry?.title ?? "Promotion";
    if (!(await confirm({ description: `Delete "${title}"?` }))) return;
    if (previewAssetId === asset.id) closePreview();
    if (textModalAssetId === asset.id) closeForm();
    if (editingEntryId && promotionEntryId(asset) === editingEntryId) closeForm();
    deleteAsset(asset);
  }

  const selectedAssets = useMemo(
    () => assets.filter((asset) => selectedIds.has(asset.id)),
    [assets, selectedIds],
  );

  function handleDeleteFromFlyerModal() {
    if (!editingRowId || !editingEntryId) return;
    const asset = assets.find(
      (a) => a.row.id === editingRowId && promotionEntryId(a) === editingEntryId,
    );
    if (!asset) return;
    handleDeleteAsset(asset);
  }

  const openNewForTab = useCallback(() => {
    if (promoTab === "social") {
      setNewPromotionKind("text");
    } else if (promoTab === "yours") {
      setNewPromotionKind("upload");
    } else {
      setNewPromotionKind("flyer");
    }
    openNewPromotion();
  }, [openNewPromotion, promoTab]);

  const promoTabs = useMemo(() => {
    const builtinFlyerCount = property ? BUILTIN_PROMOTION_DEFS.filter((d) => d.tab === "flyers").length : 0;
    const builtinSocialCount = property ? BUILTIN_PROMOTION_DEFS.filter((d) => d.tab === "social").length : 0;
    const customFlyers = filterCustomPromotionAssets(assets.filter((a) => a.kind === "flyer")).length;
    const customSocial = filterCustomPromotionAssets(assets.filter((a) => a.kind === "text")).length;
    const tabs: { id: "flyers" | "social" | "sites" | "yours"; label: string; count: number }[] = [
      { id: "flyers", label: "Flyers & printables", count: customFlyers + builtinFlyerCount },
      { id: "social", label: "Social", count: customSocial + builtinSocialCount },
      { id: "sites", label: "Listing sites", count: 1 },
    ];
    if (customAssets.length > 0) {
      tabs.push({ id: "yours", label: "Yours", count: customAssets.length });
    }
    return tabs;
  }, [assets, customAssets.length, property]);

  if (!propertyId) return null;

  // The standalone text modal is edit-only now — creating lives in PromotionNewModal.
  const textModalAsset = textModalAssetId
    ? assets.find((a) => a.id === textModalAssetId) ?? null
    : null;

  const previewAsset = previewAssetId ? assets.find((a) => a.id === previewAssetId) ?? null : null;

  async function uploadPromotion(file: File) {
    if (!userId || !propertyId) return;
    setUploadBusy(true);
    try {
      const parsed = await fileToPromotionUpload(file);
      if (!parsed) {
        showToast("Upload a JPG, PNG, or PDF up to 12 MB.");
        return;
      }
      const now = new Date().toISOString();
      const entry: PromotionUploadEntry = {
        id: makePromotionUploadId(),
        title: nextPromotionAssetDefaultTitle(assets, "upload"),
        kind: parsed.kind,
        fileUrl: parsed.fileUrl,
        fileName: file.name,
        mimeType: parsed.mimeType,
        createdAt: now,
        updatedAt: now,
      };
      const existing = readManagerPromotionRows().find((p) => p.propertyId === propertyId) ?? null;
      const seededDraft = draftWithPropertyKey(EMPTY_DRAFT, propertyId, listings, autofillOpts);
      const row =
        existing ??
        syncPromotionRowLegacy({
          id: makePromotionId(),
          managerUserId: userId,
          propertyId,
          propertyLabel: listings.find((l) => l.id === propertyId)?.label ?? "Property",
          title: "Promotion",
          theme: "cobalt",
          flyerSize: "letter",
          status: "generated",
          inputs: draftInputs(seededDraft),
          copy: null,
          createdAt: now,
          updatedAt: now,
        });
      upsertManagerPromotion(appendUploadEntryToRow(row, entry));
      setTick((n) => n + 1);
      onUpdated?.();
      closeForm();
      showToast("Promotion uploaded.");
    } finally {
      setUploadBusy(false);
    }
  }

  return (
    <>
      <PortalListControlStack
        className="mb-2 max-lg:mb-1.5"
        variant="command"
        stickyDestinations
        destinationAriaLabel="Promotion group"
        destinationRow={
          <ManagerPortalStatusPills
            activeId={promoTab}
            mobileSelect={false}
            onChange={(id) => setPromoTab(id as typeof promoTab)}
            tabs={promoTabs.map((t) => ({
              id: t.id,
              label: t.label,
              count: t.count,
              dataAttr: `property-promotion-tab-${t.id}`,
            }))}
          />
        }
        search={{
          value: promoSearch,
          onChange: setPromoSearch,
          placeholder: "Search promotions",
          dataAttr: "property-promotion-search",
        }}
        actions={
          sub && saveTarget ? (
            <PortalIconAction
              icon={Settings}
              label="Promotion settings"
              data-attr="property-promotion-settings-open"
              onClick={() => setSettingsOpen(true)}
            />
          ) : undefined
        }
        primary={<PortalPrimaryIconAction label="Add promotion" data-attr="property-promotion-add-top" onClick={openNewForTab} />}
      />
      {sub && saveTarget ? (
        <PortalPropertySectionSettingsModal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          title="Promotion settings"
          propertyLabel={propertyLabel ?? "This property"}
          dataAttr="property-promotion-settings"
        >
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-card px-3.5 py-3">
            <span className="text-sm font-semibold text-foreground">Zillow Rental Network</span>
            <PortalSettingsToggle
              checked={zillowEnabled}
              onChange={(next) => persistZillowToggle(next)}
              label="Zillow Rental Network"
              disabled={zillowSaving}
              dataAttr="property-promotion-zillow-toggle"
            />
          </div>
        </PortalPropertySectionSettingsModal>
      ) : null}
      <PortalRecordListSurface className="mt-0 pb-0 max-lg:pb-0" onBulkClear={clearSelection} bulkCount={selectedIds.size} bulkActions={selectedIds.size > 0 ? (
        <>
          <div className="flex min-w-0 flex-wrap items-center justify-start gap-2">
            {selectedIds.size === 1 && selectedAssets[0] && promotionAssetCanEdit(selectedAssets[0], openEditAsset) ? (
              <Button
                type="button"
                variant="outline"
                className={PORTAL_BULK_BAR_BTN}
                data-attr="property-promotion-bulk-edit"
                onClick={() => openEditAsset(selectedAssets[0]!)}
              >
                Edit promotion
              </Button>
            ) : null}
          </div>
        </>
      ) : null}><PortalPropertyDetailSection contentClassName="space-y-0">
        {headerActionsExtra ? <div className="mb-3">{headerActionsExtra}</div> : null}
        {promoTab === "sites" && sub && saveTarget ? (
          <div className="mb-3 px-1">
            <ZillowRentalNetworkRow
              propertyTitle={propertyLabel ?? "This property"}
              sub={sub}
              listingStatus="live"
              workEmail={workEmail}
              onToggle={(next) => persistZillowToggle(next)}
              onResend={() => {
                if (!zillow?.enabled) return;
                const nextSub: ManagerListingSubmissionV1 = {
                  ...sub,
                  syndication: {
                    ...sub.syndication,
                    zillow: { ...zillow, enabled: true, sentAt: new Date().toISOString(), status: "sent" },
                  },
                };
                if (saveTarget.mode === "pending") {
                  updatePendingManagerProperty(saveTarget.saveId, nextSub, userId ?? "");
                } else if (saveTarget.mode === "listing") {
                  updateExtraListingFromSubmission(saveTarget.saveId, userId ?? "", nextSub);
                } else if (saveTarget.mode === "requestChange") {
                  updateRequestChangeProperty(saveTarget.saveId, userId ?? "", nextSub);
                }
                onUpdated?.();
                showToast("Feed resent to Zillow Rental Network.");
              }}
              onStop={() => persistZillowToggle(false)}
              toggleDisabled={zillowSaving}
              dataAttrPrefix="property-promotion-zillow"
            />
          </div>
        ) : null}
        {promoTab !== "sites"
          ? visibleBuiltins.map((def) => {
              const enabled = builtinEnabled(promotionBuiltins, def.key);
              let detail = "From the listing";
              if (def.kind === "text" && property && def.textFormat) {
                const { plain } = resolveBuiltinTextPromotion(
                  property,
                  def.textFormat,
                  promotionRow,
                  promotionBuiltins,
                  def.key === "social" ? "social" : "blurb",
                  autofillOpts,
                );
                detail = `${plain.length} chars`;
              } else if (def.kind === "flyer") {
                detail = "Letter · Cobalt";
              } else if (def.kind === "print") {
                detail = "Door card";
              }
              return (
                <PropertyPromotionBuiltinRow
                  key={def.key}
                  def={def}
                  enabled={enabled}
                  facts={<PropertyPromotionBuiltinFacts kind={def.kind} detail={detail} />}
                  onOpen={() => openBuiltinEditor(def.key)}
                  onToggle={() => toggleBuiltin(def.key)}
                  dataAttr={`property-promotion-builtin-${def.key}`}
                />
              );
            })
          : null}
        {promoTab !== "sites" && visibleAssets.length > 0 ? (
          <PromotionAssetStack
            assets={visibleAssets}
            variant="plain"
            showPropertyLabel={false}
            emptyMessage=""
            selectedIds={selectedIds}
            onToggleSelected={toggleSelected}
            onView={openViewAsset}
            onEdit={openEditAsset}
          />
        ) : null}
      </PortalPropertyDetailSection></PortalRecordListSurface>

      <PropertyPromotionBuiltinModal
        open={builtinEditKey !== null}
        def={BUILTIN_PROMOTION_DEFS.find((d) => d.key === builtinEditKey) ?? null}
        draft={builtinDraft}
        setDraft={setBuiltinDraft}
        property={property ?? null}
        promotionRow={promotionRow}
        managerUserId={userId}
        textFormat={BUILTIN_PROMOTION_DEFS.find((d) => d.key === builtinEditKey)?.textFormat}
        textBody={builtinTextBody}
        onTextBodyChange={setBuiltinTextBody}
        onClose={() => setBuiltinEditKey(null)}
        onSave={saveBuiltinEditor}
        busy={builtinSaving}
      />

      <PromotionNewModal
        open={showNewModal}
        onClose={closeForm}
        initialKind={newPromotionKind}
        initialStepId={newPromotionStepId}
        draft={draft}
        setDraft={setDraft}
        listings={listings}
        onSelectProperty={() => {}}
        hidePropertyPicker
        onGenerateFlyer={() => void generate()}
        flyerBusy={generating}
        onGenerateText={(opts) => void createOrRegenerateText(opts, null)}
        textBusy={generatingTextId !== null}
        onUploadPromotion={(file) => void uploadPromotion(file)}
        uploadBusy={uploadBusy}
      />

      {/* Edit an existing text promotion (create-new lives in PromotionNewModal). */}
      <PromotionTextGenerateModal
        open={textModalAssetId !== null}
        onClose={closeForm}
        title="Edit promotion text"
        submitLabel="Save"
        submitBusyLabel="Saving…"
        initialFormat={textModalAsset?.textEntry?.copy.format}
        initialTone={textModalAsset?.row.inputs.tone}
        initialImages={textModalAsset?.row.inputs.images}
        canDelete={Boolean(textModalAsset)}
        onDelete={textModalAsset ? () => handleDeleteAsset(textModalAsset) : undefined}
        onGenerate={(opts) => {
          void createOrRegenerateText(opts, textModalAsset);
        }}
        busy={generatingTextId === textModalAsset?.textEntry?.id}
      />

      {/* Edit an existing flyer (create-new lives in PromotionNewModal above). */}
      <Modal
        open={showForm}
        title="Edit flyer"
        onClose={closeForm}
        panelClassName="max-w-2xl"
        footer={
          <ModalFooter className="w-full">
            {showForm && editingRowId && editingEntryId ? (
              <Button
                type="button"
                variant="outline"
                className="rounded-full border-red-200 text-red-700 hover:bg-red-50"
                onClick={handleDeleteFromFlyerModal}
                data-attr="promotion-flyer-delete"
              >
                Delete
              </Button>
            ) : null}
            <Button
              type="button"
              variant="primary"
              className="ml-auto rounded-full"
              onClick={() => generate()}
              disabled={generating}
              data-attr="promotion-generate"
            >
              {generating ? "Saving…" : "Save"}
            </Button>
          </ModalFooter>
        }
      >
        <PromotionForm
          draft={draft}
          setDraft={setDraft}
          listings={listings}
          onSelectProperty={() => {}}
          hidePropertyPicker
        />
      </Modal>

      <PromotionAssetViewModal
        asset={previewAsset}
        open={previewOpen}
        onClose={closePreview}
        allAssets={assets}
        dataAttr="property-promotion-preview"
        showToast={showToast}
      />

      {/*
        Edit is the only action out here. Both promotion editors already carry
        their own Delete, next to what it would destroy — a delete sitting in a
        floating bar, one click from a row you may have ticked by accident, is
        the wrong distance from a destructive action.
      */}

    </>
  );
}
