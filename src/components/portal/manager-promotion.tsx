"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ManagerPortalPageShell,
  PORTAL_HEADER_PRIMARY_ACTION_BTN,
} from "@/components/portal/portal-metrics";
import { ApplicationHouseholdCluster } from "@/components/portal/application-household-list";
import { PortalListGroupFilterFields } from "@/components/portal/portal-list-group-filter-fields";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PORTAL_PROPERTY_FILTER_SHEET_CLASS } from "@/components/portal/portal-filter-shell";
import { PortalRecordDetailPage } from "@/components/portal/portal-record-detail-page";
import { ListSkeleton } from "@/components/ui/list-skeleton";
import {
  buildManagerPropertyFilterOptions,
  samePropertyId,
} from "@/lib/manager-portfolio-access";
import { Button } from "@/components/ui/button";
import { BulkActionBar } from "@/components/ui/bulk-action-bar";
import { Badge } from "@/components/ui/badge";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { usePortalRowSelection } from "@/hooks/use-portal-row-selection";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { track } from "@/lib/analytics/track-client";
import {
  DEMO_PROMOTION_AUTOFILL_EVENT,
  DEMO_PROMOTION_GENERATED_EVENT,
} from "@/lib/demo/demo-playback";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { PORTAL_LIST_PAGE_BODY } from "@/components/portal/portal-inbox-ui";
import { PromotionAssetStack, promotionAssetCanEdit } from "@/components/portal/promotion-asset-list";
import {
  PromotionFlyerAssetDetail,
  PromotionUploadAssetDetail,
} from "@/components/portal/promotion-asset-detail";
import { PromotionTextPreview } from "@/components/portal/promotion-text-preview";
import { PromotionAssetViewModal } from "@/components/portal/promotion-asset-view-modal";
import { PromotionNewModal } from "@/components/portal/promotion-new-modal";
import { PromotionTextGenerateModal } from "@/components/portal/promotion-text-generate-modal";
import { buildPromotionNewModalAssistantContext } from "@/lib/promotion-assistant-context";
import {
  CUSTOM_PROPERTY_KEY,
  EMPTY_DRAFT,
  PromotionForm,
  draftInputs,
  draftWithPropertyKey,
  promotionTextIdentityFromDraft,
  type PromotionDraft,
} from "@/components/portal/promotion-form";
import {
  flattenPromotionAssets,
  makePromotionAssetId,
  nextPromotionAssetDefaultTitle,
  sortPromotionAssets,
  promotionAssetListTitle,
  promotionAssetKindIndices,
  type PromotionAsset,
} from "@/lib/promotion-assets";
import {
  buildManagerPromotionPropertyOptions,
  type ManagerPromotionPropertyOption,
} from "@/lib/manager-property-links";
import {
  FLYER_IMAGE_LIMIT,
  normalizePromotionTemplate,
  PROMOTION_TEMPLATE_DEFAULT,
  PROMOTION_TONE_OPTIONS,
  readFlyerEntries,
  type FlyerEntry,
  type ManagerPromotionRow,
} from "@/lib/promotion-flyer";
import {
  buildFlyerEntryFromDraft,
  buildTextEntryFromCopy,
  appendUploadEntryToRow,
  removeFlyerEntryFromRow,
  removeTextEntryFromRow,
  removeUploadEntryFromRow,
  syncPromotionRowLegacy,
  updateFlyerEntryOnRow,
  updateTextEntryOnRow,
} from "@/lib/promotion-row-ops";
import {
  MANAGER_PROMOTIONS_EVENT,
  deleteManagerPromotionRow,
  generateFlyerCopy,
  generatePromotionTextCopy,
  makePromotionId,
  readManagerPromotionRows,
  syncManagerPromotionsFromServer,
  upsertManagerPromotion,
} from "@/lib/manager-promotions-storage";
import { promotionDetailHref, promotionListHref } from "@/lib/portal-detail-routes";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { readPromotionTextEntries, type PromotionTextEntry, type PromotionTextFormat } from "@/lib/promotion-text";
import {
  fileToPromotionUpload,
  makePromotionUploadId,
  type PromotionUploadEntry,
} from "@/lib/promotion-upload";
import {
  PROPERTY_PIPELINE_EVENT,
  syncPropertyPipelineFromServer,
} from "@/lib/demo-property-pipeline";
import { AGENT_PENDING_ACTIONS_EVENT } from "@/lib/axis-assistant/pending-actions-events";
import {
  clusterRowsByProperty,
  type PropertyCluster,
} from "@/lib/resident-row-clustering";
import {
  DEFAULT_PORTAL_LIST_GROUP_MODE,
  type PortalListGroupMode,
} from "@/lib/portal-list-grouping";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";

function promotionEntryId(asset: PromotionAsset): string | null {
  if (asset.kind === "flyer") return asset.flyerEntry?.id ?? null;
  if (asset.kind === "text") return asset.textEntry?.id ?? null;
  if (asset.kind === "upload") return asset.uploadEntry?.id ?? null;
  return null;
}

function flyerEntryToDraft(
  row: ManagerPromotionRow,
  entry: FlyerEntry,
  listings: ManagerPromotionPropertyOption[],
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


export function ManagerPromotion({
  basePath = "/portal",
  assetId: assetIdProp,
}: {
  basePath?: string;
  assetId?: string;
} = {}) {
  const { showToast } = useAppUi();
  const navigate = usePortalNavigate();
  const { userId, email: managerEmail, ready: authReady } = useManagerUserId();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const handledFlyerDeepLink = useRef(false);
  // Aborts the copy request owned by whichever compose modal is open.
  const generateAbortRef = useRef<AbortController | null>(null);
  const [tick, setTick] = useState(0);
  const [propertyTick, setPropertyTick] = useState(0);
  // Unified "New promotion" modal (type dropdown + inline flyer/text form).
  const [showNewModal, setShowNewModal] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  // Edit-flyer modal (create-new now lives in the unified modal above).
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<PromotionDraft>(EMPTY_DRAFT);
  const [generating, setGenerating] = useState(false);
  const [generatingTextId, setGeneratingTextId] = useState<string | null>(null);
  const [textModalAssetId, setTextModalAssetId] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewAssetId, setPreviewAssetId] = useState<string | null>(null);
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [demoPromotionGeneratePending, setDemoPromotionGeneratePending] = useState(false);
  const [propertyFilters, setPropertyFilters] = useState<string[]>([]);
  const [groupMode, setGroupMode] = useState<PortalListGroupMode>(DEFAULT_PORTAL_LIST_GROUP_MODE);

  useEffect(() => {
    if (!authReady) return;
    void syncManagerPromotionsFromServer({ force: true });
    void syncPropertyPipelineFromServer({ force: true });
  }, [authReady, userId]);

  useEffect(() => {
    const onPromos = () => setTick((n) => n + 1);
    const onProps = () => setPropertyTick((n) => n + 1);
    const onAgentActions = () => {
      void syncManagerPromotionsFromServer({ force: true }).then(() => setTick((n) => n + 1));
    };
    window.addEventListener(MANAGER_PROMOTIONS_EVENT, onPromos);
    window.addEventListener(PROPERTY_PIPELINE_EVENT, onProps);
    window.addEventListener(AGENT_PENDING_ACTIONS_EVENT, onAgentActions);
    return () => {
      window.removeEventListener(MANAGER_PROMOTIONS_EVENT, onPromos);
      window.removeEventListener(PROPERTY_PIPELINE_EVENT, onProps);
      window.removeEventListener(AGENT_PENDING_ACTIONS_EVENT, onAgentActions);
    };
  }, []);

  const promotions = useMemo(() => {
    void tick;
    return readManagerPromotionRows();
  }, [tick]);

  const assets = useMemo(
    () => sortPromotionAssets(flattenPromotionAssets(promotions), "newest"),
    [promotions],
  );

  // Property filter drives both the visible list and the content-type counts,
  // mirroring the Services page (counts reflect the current property scope).
  const propertyScopedAssets = useMemo(() => {
    if (propertyFilters.length === 0) return assets;
    return assets.filter((a) => propertyFilters.some((id) => samePropertyId(a.row.propertyId, id)));
  }, [assets, propertyFilters]);

  const { selectedIds, toggleSelected, clearSelection } = usePortalRowSelection(
    `${propertyFilters.join(",")}:${groupMode}`,
  );
  const selectedAssets = useMemo(
    () => propertyScopedAssets.filter((asset) => selectedIds.has(asset.id)),
    [propertyScopedAssets, selectedIds],
  );

  const promotionPropertyClusters = useMemo((): PropertyCluster<PromotionAsset>[] => {
    return clusterRowsByProperty(
      propertyScopedAssets.map((asset) => ({
        ...asset,
        propertyId: asset.row.propertyId,
        propertyLabel: asset.propertyLabel,
      })),
    );
  }, [propertyScopedAssets]);

  const listings = useMemo<ManagerPromotionPropertyOption[]>(() => {
    void propertyTick;
    return buildManagerPromotionPropertyOptions(userId);
  }, [userId, propertyTick]);

  // "All your properties" filter options: portfolio properties merged with any
  // property a promotion is already attached to (same pattern as Services).
  const filterPropertyOptions = useMemo(() => {
    void propertyTick;
    const opts = buildManagerPropertyFilterOptions(userId ?? null);
    for (const row of promotions) {
      const pid = row.propertyId?.trim();
      if (!pid || opts.some((p) => samePropertyId(p.id, pid))) continue;
      opts.push({ id: pid, label: row.propertyLabel || pid });
    }
    return opts.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  }, [userId, propertyTick, promotions]);

  const autofillOpts = useMemo(
    () => ({
      managerContact: managerEmail ?? "",
      appOrigin: typeof window !== "undefined" ? window.location.origin : "",
    }),
    [managerEmail],
  );

  // Seed the flyer draft (optionally from a property) and open the unified
  // "New promotion" modal. It opens on the flyer form; the in-modal type
  // dropdown swaps to the text composer without a separate "Continue" step.
  const openNewPromotion = useCallback(
    (propertyId?: string) => {
      setEditingRowId(null);
      setEditingEntryId(null);
      if (propertyId && listings.some((l) => l.id === propertyId)) {
        setDraft(draftWithPropertyKey(EMPTY_DRAFT, propertyId, listings, autofillOpts));
      } else {
        setDraft(EMPTY_DRAFT);
      }
      setShowNewModal(true);
    },
    [listings, autofillOpts],
  );

  useEffect(() => {
    if (!isDemoModeActive()) return;
    const onAutofill = (e: Event) => {
      const detail = (e as CustomEvent<{ propertyId?: string; generateAfter?: boolean }>).detail;
      const pid = detail?.propertyId?.trim() || listings[0]?.id;
      if (!pid) return;
      setDraft(draftWithPropertyKey(EMPTY_DRAFT, pid, listings, autofillOpts));
      setEditingRowId(null);
      setEditingEntryId(null);
      setShowNewModal(true);
      if (detail?.generateAfter) setDemoPromotionGeneratePending(true);
    };
    window.addEventListener(DEMO_PROMOTION_AUTOFILL_EVENT, onAutofill as EventListener);
    return () => window.removeEventListener(DEMO_PROMOTION_AUTOFILL_EVENT, onAutofill as EventListener);
  }, [listings, autofillOpts]);

  useEffect(() => {
    if (handledFlyerDeepLink.current || searchParams.get("new") !== "1") return;
    if (!authReady) return;
    const propertyId = searchParams.get("propertyId")?.trim() || "";
    if (propertyId && listings.length === 0 && userId) return;

    handledFlyerDeepLink.current = true;
    openNewPromotion(propertyId || undefined);

    const next = new URLSearchParams(searchParams.toString());
    next.delete("new");
    next.delete("propertyId");
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [authReady, listings, userId, searchParams, pathname, router, openNewPromotion]);

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
    setDraft(EMPTY_DRAFT);
  }, []);

  const revealAsset = useCallback((assetId: string, rowPropertyId: string | null | undefined) => {
    const pid = rowPropertyId?.trim();
    if (pid) {
      setPropertyFilters((cur) =>
        cur.length === 0 || cur.some((id) => samePropertyId(id, pid)) ? cur : [pid],
      );
    }
    setPreviewAssetId(assetId);
    setPreviewOpen(true);
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

  const openViewAsset = useCallback((asset: PromotionAsset) => {
    setPreviewAssetId(asset.id);
    setPreviewOpen(true);
  }, []);

  const closePreview = useCallback(() => {
    setPreviewOpen(false);
    setPreviewAssetId(null);
  }, []);

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

  function onSelectProperty(key: string) {
    setDraft((d) => draftWithPropertyKey(d, key, listings, autofillOpts));
  }

  async function generate() {
    const label = draft.propertyLabel.trim();
    const entryTitle =
      draft.title.trim() || nextPromotionAssetDefaultTitle(assets, "flyer");
    if (!label && !draft.headline.trim()) {
      showToast("Add a property/listing or a headline first.");
      return;
    }
    const propertyId = draft.propertyKey === CUSTOM_PROPERTY_KEY ? null : draft.propertyKey;
    const editingRow = editingRowId ? promotions.find((p) => p.id === editingRowId) ?? null : null;
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
      const assetId = makePromotionAssetId(savedRow.id, "flyer", entryId);
      revealAsset(assetId, savedRow.propertyId);
      if (isDemoModeActive()) {
        window.dispatchEvent(new CustomEvent(DEMO_PROMOTION_GENERATED_EVENT, { detail: { assetId } }));
      }
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

  async function regenerateText(
    row: ManagerPromotionRow,
    entryId: string,
    opts: { format: PromotionTextFormat; tone: string; extraInstructions: string; images: string[] },
  ) {
    const entry = readPromotionTextEntries(row).find((e) => e.id === entryId);
    if (!entry) return;
    const abort = new AbortController();
    generateAbortRef.current = abort;
    setGeneratingTextId(entryId);
    try {
      const inputs = {
        ...row.inputs,
        tone: opts.tone.trim() || row.inputs.tone,
        images: opts.images.slice(0, FLYER_IMAGE_LIMIT),
      };
      const { copy, source } = await generatePromotionTextCopy(inputs, row.propertyLabel, opts.format, {
        propertyId: row.propertyId,
        extraInstructions: opts.extraInstructions,
        signal: abort.signal,
      });
      if (source === "cancelled") return;
      if (source === "forbidden") {
        showToast("You can only create promotions for your own properties.");
        return;
      }
      upsertManagerPromotion(
        updateTextEntryOnRow({ ...row, inputs }, entryId, {
          copy,
          updatedAt: new Date().toISOString(),
        }),
      );
      setTextModalAssetId(null);
      showToast(source === "ai" ? "Promotion text generated." : "Promotion text generated (offline copy).");
    } catch {
      showToast("Could not generate promotion text.");
    } finally {
      if (generateAbortRef.current === abort) generateAbortRef.current = null;
      setGeneratingTextId(null);
    }
  }

  async function createTextFromModal(opts: {
    format: PromotionTextFormat;
    tone: string;
    extraInstructions: string;
    images: string[];
  }) {
    // The unified new-promotion modal shares one `draft` for property context;
    // the text composer contributes format/tone/notes/images via `opts`.
    const base = draft;
    const { propertyId, propertyLabel: label } = promotionTextIdentityFromDraft(base);
    const entryTitle = nextPromotionAssetDefaultTitle(assets, "text");
    const abort = new AbortController();
    generateAbortRef.current = abort;
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
      revealAsset(makePromotionAssetId(row.id, "text", entry.id), row.propertyId);
      showToast(source === "ai" ? "Promotion text created." : "Promotion text created (offline copy).");
    } catch {
      showToast("Could not generate promotion text.");
    } finally {
      if (generateAbortRef.current === abort) generateAbortRef.current = null;
      setGeneratingTextId(null);
    }
  }

  async function uploadPromotion(file: File) {
    if (!userId) return;
    const { propertyId, propertyLabel: label } = promotionTextIdentityFromDraft(draft);
    if (!propertyId) {
      showToast("Select a property for this promotion.");
      return;
    }
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
      const row =
        existing ??
        syncPromotionRowLegacy({
          id: makePromotionId(),
          managerUserId: userId,
          propertyId,
          propertyLabel: label,
          title: "Promotion",
          theme: "cobalt",
          flyerSize: "letter",
          status: "generated",
          inputs: draftInputs(draft),
          copy: null,
          createdAt: now,
          updatedAt: now,
        });
      upsertManagerPromotion(appendUploadEntryToRow(row, entry));
      closeForm();
      revealAsset(makePromotionAssetId(row.id, "upload", entry.id), propertyId);
      showToast("Promotion uploaded.");
    } finally {
      setUploadBusy(false);
    }
  }

  useEffect(() => {
    if (!demoPromotionGeneratePending || !isDemoModeActive()) return;
    setDemoPromotionGeneratePending(false);
    void generate();
  }, [demoPromotionGeneratePending, draft]);

  // The standalone text modal is edit-only now — creating lives in PromotionNewModal.
  const textModalAsset = textModalAssetId
    ? assets.find((a) => a.id === textModalAssetId) ?? null
    : null;

  const previewAsset = previewAssetId ? assets.find((a) => a.id === previewAssetId) ?? null : null;

  const detailAsset = useMemo(() => {
    if (!assetIdProp) return null;
    return assets.find((a) => a.id === assetIdProp) ?? null;
  }, [assetIdProp, assets]);

  const detailTitle = useMemo(() => {
    if (!detailAsset) return "Promotion";
    const indices = promotionAssetKindIndices(assets);
    const indexWithinKind = indices.get(detailAsset.id) ?? 0;
    const stored =
      detailAsset.kind === "flyer"
        ? (detailAsset.flyerEntry?.title ?? "")
        : detailAsset.kind === "upload"
          ? (detailAsset.uploadEntry?.title ?? "")
          : (detailAsset.textEntry?.title ?? "");
    return stored.trim() || promotionAssetListTitle(detailAsset, indexWithinKind);
  }, [detailAsset, assets]);

  function deleteAsset(asset: PromotionAsset) {
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
    showToast("Promotion deleted.");
  }

  function handleDeleteAsset(asset: PromotionAsset) {
    const title = asset.flyerEntry?.title ?? asset.textEntry?.title ?? asset.uploadEntry?.title ?? "Promotion";
    if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) return;
    if (previewAssetId === asset.id) closePreview();
    if (textModalAssetId === asset.id) closeForm();
    if (editingEntryId && promotionEntryId(asset) === editingEntryId) closeForm();
    deleteAsset(asset);
  }

  function handleDeleteFromFlyerModal() {
    if (!editingRowId || !editingEntryId) return;
    const asset = assets.find(
      (a) => a.row.id === editingRowId && promotionEntryId(a) === editingEntryId,
    );
    if (!asset) return;
    handleDeleteAsset(asset);
  }

  const promotionModals = (
    <>
      <PromotionNewModal
        open={showNewModal}
        onClose={closeForm}
        draft={draft}
        setDraft={setDraft}
        listings={listings}
        onSelectProperty={onSelectProperty}
        onGenerateFlyer={() => void generate()}
        flyerBusy={generating}
        onGenerateText={(opts) => void createTextFromModal(opts)}
        textBusy={generatingTextId !== null}
        onUploadPromotion={(file) => void uploadPromotion(file)}
        uploadBusy={uploadBusy}
      />

      <Modal
        open={showForm}
        title="Edit flyer"
        onClose={closeForm}
        panelClassName="max-w-2xl"
        assistantContext={buildPromotionNewModalAssistantContext(draft, "flyer")}
        assistantStorageScopeKey="Edit promotion flyer"
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
        <div className="pr-1">
          <PromotionForm
            draft={draft}
            setDraft={setDraft}
            listings={listings}
            onSelectProperty={onSelectProperty}
          />
        </div>
      </Modal>

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
          if (!textModalAsset?.textEntry) return;
          void regenerateText(textModalAsset.row, textModalAsset.textEntry.id, opts);
        }}
        busy={generatingTextId === textModalAsset?.textEntry?.id}
      />

      <PromotionAssetViewModal
        asset={previewAsset}
        open={previewOpen}
        onClose={closePreview}
        allAssets={assets}
        dataAttr="promotion-preview"
        showToast={showToast}
      />
    </>
  );

  if (assetIdProp) {
    if (!detailAsset) {
      return (
        <>
          {promotionModals}
          <PortalRecordDetailPage
            pageTitle="Promotion"
            title="Promotion"
            backHref={promotionListHref(basePath)}
            hideBackText
            bareHeader
            dataAttrBack="promotion-detail-back"
            pinScrollBody
          >
            <div className="px-3 py-6">
              {authReady ? (
                <p className="text-center text-sm text-muted">Promotion not found.</p>
              ) : (
                <ListSkeleton rows={4} showLeading={false} />
              )}
            </div>
          </PortalRecordDetailPage>
        </>
      );
    }

    return (
      <>
        {promotionModals}
        <PortalRecordDetailPage
          pageTitle="Promotion"
          title={detailTitle}
          subtitle={detailAsset.propertyLabel}
          backHref={promotionListHref(basePath)}
          hideBackText
          bareHeader
          dataAttrBack="promotion-detail-back"
          pinScrollBody
          actions={
            detailAsset.kind === "flyer" || detailAsset.kind === "text" ? (
              <Button
                type="button"
                variant="outline"
                className={PORTAL_HEADER_PRIMARY_ACTION_BTN}
                data-attr="promotion-detail-edit"
                onClick={() => openEditAsset(detailAsset)}
              >
                Edit
              </Button>
            ) : null
          }
        >
          <div className="px-3 py-4 sm:px-4">
            {detailAsset.kind === "flyer" ? (
              <PromotionFlyerAssetDetail asset={detailAsset} />
            ) : detailAsset.kind === "upload" ? (
              <PromotionUploadAssetDetail asset={detailAsset} />
            ) : detailAsset.textEntry ? (
              <PromotionTextPreview copy={detailAsset.textEntry.copy} variant="plain" />
            ) : null}
          </div>
        </PortalRecordDetailPage>
      </>
    );
  }

  const promotionFilterSheet = (
    <PortalFilterSortSheet
      activeCount={portalFilterActiveCount([propertyFilters])}
      compactPanel
      filterFieldCount={filterPropertyOptions.length > 1 ? 2 : 1}
      constrainDropdownToTitleBand
      mobileFlushBody
      className={PORTAL_PROPERTY_FILTER_SHEET_CLASS}
      onReset={() => {
        setPropertyFilters([]);
        setGroupMode(DEFAULT_PORTAL_LIST_GROUP_MODE);
      }}
      dataAttr="promotion-filter-sheet-open"
    >
      <PortalListGroupFilterFields
        groupMode={groupMode}
        onGroupModeChange={setGroupMode}
        propertyOptions={filterPropertyOptions}
        propertyFilters={propertyFilters}
        onPropertyFiltersChange={setPropertyFilters}
        propertyDataAttr="promotion-filter-property"
        groupModeDataAttr="promotion-filter-group-mode"
      />
    </PortalFilterSortSheet>
  );

  const promotionNewButton = (
    <Button
      type="button"
      variant="primary"
      className={`shrink-0 ${PORTAL_HEADER_PRIMARY_ACTION_BTN}`}
      onClick={() => openNewPromotion()}
      data-attr="promotion-new"
    >
      + New promotion
    </Button>
  );

  return (
    <ManagerPortalPageShell
      title="Promotion"
      titleInlineFilter={promotionFilterSheet}
      titleAside={promotionNewButton}
      hideTitleOnMobileNav
      compactFilterRow
    >
      <div data-attr="promotion-content-direct">
        {propertyScopedAssets.length === 0 ? (
          assets.length > 0 ? (
            <PortalDataTableEmpty icon="data" message="No promotions match these filters." />
          ) : null
        ) : (
          <div className={PORTAL_LIST_PAGE_BODY}>
            {groupMode === "house" ? (
              <div className="space-y-3" data-attr="promotion-house-groups">
                {promotionPropertyClusters.map((cluster) => (
                  <ApplicationHouseholdCluster
                    key={cluster.key}
                    header={
                      <>
                        <span className="truncate text-xs font-semibold text-foreground">
                          {cluster.propertyLabel}
                        </span>
                        <Badge tone="info">
                          {cluster.rows.length === 1 ? "1 promotion" : `${cluster.rows.length} promotions`}
                        </Badge>
                      </>
                    }
                  >
                    <PromotionAssetStack
                      assets={cluster.rows}
                      onView={openViewAsset}
                      onEdit={openEditAsset}
                      selectedIds={selectedIds}
                      onToggleSelected={toggleSelected}
                    />
                  </ApplicationHouseholdCluster>
                ))}
              </div>
            ) : (
              <PromotionAssetStack
                assets={propertyScopedAssets}
                onView={openViewAsset}
                onEdit={openEditAsset}
                selectedIds={selectedIds}
                onToggleSelected={toggleSelected}
              />
            )}
          </div>
        )}
      </div>

      {selectedIds.size > 0 ? (
        <BulkActionBar count={selectedIds.size} hideCount variant="payments">
          <div className="flex min-w-0 flex-wrap items-center justify-start gap-2">
            {selectedIds.size === 1 &&
            selectedAssets[0] &&
            promotionAssetCanEdit(selectedAssets[0], openEditAsset) ? (
              <Button
                type="button"
                variant="outline"
                className={PORTAL_BULK_BAR_BTN}
                data-attr="promotion-bulk-edit"
                onClick={() => openEditAsset(selectedAssets[0]!)}
              >
                Edit
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              className={`${PORTAL_BULK_BAR_BTN} text-rose-800`}
              data-attr="promotion-bulk-delete"
              onClick={() => {
                if (selectedAssets.length === 0) return;
                const label =
                  selectedAssets.length === 1
                    ? selectedAssets[0]!.flyerEntry?.title ??
                      selectedAssets[0]!.textEntry?.title ??
                      "this promotion"
                    : `${selectedAssets.length} promotions`;
                if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
                for (const asset of selectedAssets) deleteAsset(asset);
                clearSelection();
                setTick((n) => n + 1);
                showToast(
                  selectedAssets.length === 1 ? "Promotion deleted." : `${selectedAssets.length} promotions deleted.`,
                );
              }}
            >
              Delete
            </Button>
          </div>
        </BulkActionBar>
      ) : null}

      {promotionModals}
    </ManagerPortalPageShell>
  );
}

