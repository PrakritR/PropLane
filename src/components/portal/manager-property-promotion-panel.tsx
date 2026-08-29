"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { BulkActionBar } from "@/components/ui/bulk-action-bar";
import { Modal, ModalFooter } from "@/components/ui/modal";
import {
  PORTAL_LIST_ADD_ICONS,
  PORTAL_LIST_ADD_ROW_WRAP_CLASS,
  PortalListAddRow,
} from "@/components/portal/portal-list-add-row";
import {
  PortalPropertyDetailSection,
} from "@/components/portal/portal-property-detail-section";
import { PromotionAssetStack } from "@/components/portal/promotion-asset-list";
import { PromotionAssetViewModal } from "@/components/portal/promotion-asset-view-modal";
import {
  EMPTY_DRAFT,
  PromotionForm,
  draftInputs,
  draftWithPropertyKey,
  promotionTextIdentityFromDraft,
  type PromotionDraft,
} from "@/components/portal/promotion-form";
import { PromotionNewModal } from "@/components/portal/promotion-new-modal";
import { PromotionTextGenerateModal } from "@/components/portal/promotion-text-generate-modal";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { track } from "@/lib/analytics/track-client";
import { syncPropertyPipelineFromServer, PROPERTY_PIPELINE_EVENT } from "@/lib/demo-property-pipeline";
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
  sortPromotionAssets,
  type PromotionAsset,
} from "@/lib/promotion-assets";
import {
  FLYER_IMAGE_LIMIT,
  PROMOTION_TEMPLATE_DEFAULT,
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
import { PromotionDefaultSuggestions } from "@/components/portal/promotion-default-suggestions";
import { addDefaultPromotionPreset, type PromotionPresetKind } from "@/lib/promotion-default-sync";
import { usePortalRowSelection } from "@/hooks/use-portal-row-selection";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";

function promotionEntryId(asset: PromotionAsset): string | null {
  if (asset.kind === "flyer") return asset.flyerEntry?.id ?? null;
  if (asset.kind === "text") return asset.textEntry?.id ?? null;
  if (asset.kind === "upload") return asset.uploadEntry?.id ?? null;
  return null;
}

export function ManagerPropertyPromotionPanel({
  listingId,
  showToast,
  onUpdated,
  headerActionsExtra,
  onRegisterNewPromotion,
}: {
  listingId: string;
  showToast: (m: string) => void;
  onUpdated?: () => void;
  headerActionsExtra?: ReactNode;
  /** Parent header "New promotion" — same handler as the former section footer button. */
  onRegisterNewPromotion?: (openNewPromotion: (() => void) | null) => void;
}) {
  const { userId, email: managerEmail, ready: authReady } = useManagerUserId();
  // Aborts the copy request owned by whichever compose modal is open.
  const generateAbortRef = useRef<AbortController | null>(null);
  const [tick, setTick] = useState(0);
  const [propertyTick, setPropertyTick] = useState(0);
  const [showNewModal, setShowNewModal] = useState(false);
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

  const autofillOpts = useMemo(
    () => ({
      managerContact: managerEmail ?? "",
      appOrigin: typeof window !== "undefined" ? window.location.origin : "",
    }),
    [managerEmail],
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

  const { selectedIds, toggleSelected, clearSelection } = usePortalRowSelection(assets.length);

  const addPromotionPreset = useCallback(
    (preset: PromotionPresetKind) => {
      if (!userId || !propertyId) return;
      const listing = listings.find((l) => l.id === propertyId);
      if (!listing?.property) {
        showToast("Listing details are not available yet.");
        return;
      }
      const existingRow = readManagerPromotionRows().find((row) => row.propertyId === propertyId) ?? null;
      const next = addDefaultPromotionPreset({
        propertyId,
        property: listing.property,
        managerUserId: userId,
        managerContact: autofillOpts.managerContact,
        appOrigin: autofillOpts.appOrigin,
        existingRow,
        preset,
      });
      if (!next) {
        showToast("That promotion is already on this property.");
        return;
      }
      upsertManagerPromotion(next);
      setTick((n) => n + 1);
      onUpdated?.();
      showToast("Promotion added from listing.");
    },
    [userId, propertyId, listings, autofillOpts, showToast, onUpdated],
  );

  // Open the unified "New promotion" modal (type dropdown + inline form, no
  // separate "Continue" step) seeded to this property.
  const openNewPromotion = useCallback(() => {
    setEditingRowId(null);
    setEditingEntryId(null);
    setDraft(draftWithPropertyKey(EMPTY_DRAFT, propertyId, listings, autofillOpts));
    setShowNewModal(true);
  }, [listings, propertyId, autofillOpts]);

  useEffect(() => {
    onRegisterNewPromotion?.(openNewPromotion);
    return () => onRegisterNewPromotion?.(null);
  }, [onRegisterNewPromotion, openNewPromotion]);

  const openViewAsset = useCallback((asset: PromotionAsset) => {
    setPreviewAssetId(asset.id);
    setPreviewOpen(true);
  }, []);

  const closePreview = useCallback(() => {
    setPreviewOpen(false);
    setPreviewAssetId(null);
  }, []);

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

    const base = draftWithPropertyKey(EMPTY_DRAFT, propertyId, listings, autofillOpts);
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

  function handleDeleteAsset(asset: PromotionAsset) {
    const title = asset.flyerEntry?.title ?? asset.textEntry?.title ?? asset.uploadEntry?.title ?? "Promotion";
    if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) return;
    if (previewAssetId === asset.id) closePreview();
    if (textModalAssetId === asset.id) closeForm();
    if (editingEntryId && promotionEntryId(asset) === editingEntryId) closeForm();
    deleteAsset(asset);
  }

  const selectedAssets = useMemo(
    () => assets.filter((asset) => selectedIds.has(asset.id)),
    [assets, selectedIds],
  );

  const bulkDeleteAssets = () => {
    if (selectedAssets.length === 0) return;
    if (
      !window.confirm(
        `Delete ${selectedAssets.length} promotion${selectedAssets.length === 1 ? "" : "s"}? This cannot be undone.`,
      )
    ) {
      return;
    }
    for (const asset of selectedAssets) {
      if (previewAssetId === asset.id) closePreview();
      if (textModalAssetId === asset.id) closeForm();
      if (editingEntryId && promotionEntryId(asset) === editingEntryId) closeForm();
      deleteAsset(asset, { quiet: true });
    }
    clearSelection();
    showToast(
      selectedAssets.length === 1 ? "Promotion deleted." : `${selectedAssets.length} promotions deleted.`,
    );
  };

  function handleDeleteFromFlyerModal() {
    if (!editingRowId || !editingEntryId) return;
    const asset = assets.find(
      (a) => a.row.id === editingRowId && promotionEntryId(a) === editingEntryId,
    );
    if (!asset) return;
    handleDeleteAsset(asset);
  }

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
      <PortalPropertyDetailSection contentClassName="space-y-0">
        {headerActionsExtra ? <div className="mb-3">{headerActionsExtra}</div> : null}
        {assets.length === 0 ? (
          <p className="px-1 py-2 text-sm text-muted">No promotions yet. Add a suggested default below or tap Add.</p>
        ) : (
          <PromotionAssetStack
            assets={assets}
            variant="plain"
            showPropertyLabel={false}
            emptyMessage=""
            selectedIds={selectedIds}
            onToggleSelected={toggleSelected}
            onView={openViewAsset}
          />
        )}
      </PortalPropertyDetailSection>

      <div className="mt-4">
        <PromotionDefaultSuggestions
          propertyId={propertyId}
          promotionRow={promotionRow}
          onAddPreset={addPromotionPreset}
        />
      </div>

      <div className={PORTAL_LIST_ADD_ROW_WRAP_CLASS}>
        <PortalListAddRow
          label="Add"
          icon={PORTAL_LIST_ADD_ICONS.promotion}
          onClick={openNewPromotion}
          dataAttr="manager-property-new-promotion"
        />
      </div>

      <PromotionNewModal
        open={showNewModal}
        onClose={closeForm}
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

      {selectedIds.size > 0 ? (
        <BulkActionBar count={selectedIds.size} hideCount variant="payments">
          <div className="flex min-w-0 flex-wrap items-center justify-start gap-2">
            <Button
              type="button"
              variant="outline"
              className={`${PORTAL_BULK_BAR_BTN} text-rose-800`}
              data-attr="property-promotion-bulk-delete"
              onClick={bulkDeleteAssets}
            >
              Delete
            </Button>
          </div>
        </BulkActionBar>
      ) : null}
    </>
  );
}
