"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { PreviewPanel, WizardSelect } from "@/components/portal/add-workspace/parts";
import { StepColumn, StepHeading } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import {
  CUSTOM_PROPERTY_KEY,
  PromotionForm,
  type PromotionDraft,
} from "@/components/portal/promotion-form";
import {
  PromotionTextComposer,
  type PromotionTextComposerHandle,
  type PromotionTextGenerateOptions,
} from "@/components/portal/promotion-text-generate-modal";
import type { ManagerPromotionPropertyOption } from "@/lib/manager-property-links";
import type { PromotionAssetKind } from "@/lib/promotion-assets";
import { buildPromotionNewModalAssistantContext } from "@/lib/promotion-assistant-context";
import type { PromotionTextFormat } from "@/lib/promotion-text";
import { PromotionUploadComposer } from "@/components/portal/promotion-upload-composer";
import { useConfirm } from "@/components/providers/app-ui-provider";

const PROMOTION_KIND_OPTIONS: { id: PromotionAssetKind; label: string }[] = [
  { id: "flyer", label: "Flyer" },
  { id: "text", label: "Text" },
  { id: "upload", label: "Upload your own" },
];

type FlyerContentField = Exclude<keyof PromotionDraft, "propertyKey" | "images">;

/** Flyer draft fields that count as manager-entered content for the discard
 *  warning. `propertyKey` is deliberately excluded: picking a property re-derives
 *  most of the draft from the listing, so it re-baselines instead (see below);
 *  `images` is compared separately. Typing the map as an exhaustive `Record`
 *  makes the compiler flag a new `PromotionDraft` field that isn't listed —
 *  otherwise it would be silently discardable without a confirm. */
const FLYER_CONTENT_FIELD_SET: Record<FlyerContentField, true> = {
  propertyLabel: true,
  address: true,
  title: true,
  headline: true,
  sellingPoints: true,
  customDetails: true,
  price: true,
  promo: true,
  cta: true,
  contact: true,
  schedulingUrl: true,
  includeSchedulingLink: true,
  theme: true,
  flyerSize: true,
  template: true,
  tone: true,
  aiPrompt: true,
};

const FLYER_CONTENT_FIELDS = Object.keys(FLYER_CONTENT_FIELD_SET) as FlyerContentField[];

/** Field-by-field compare — `images` holds base64 data URLs, so serializing the
 *  whole draft to compare it would cost megabytes on every type switch. */
function flyerContentChanged(next: PromotionDraft, base: PromotionDraft): boolean {
  for (const field of FLYER_CONTENT_FIELDS) {
    if (next[field] !== base[field]) return true;
  }
  if (next.images.length !== base.images.length) return true;
  return next.images.some((src, i) => src !== base.images[i]);
}

/**
 * The unified "New promotion" modal. Picking a type in the dropdown drops you
 * straight into that type's form in the SAME modal — there is no intermediate
 * "Continue" step. Switching type after entering content warns first so nothing
 * is silently discarded.
 *
 * `kind` "flyer" maps to the flyer builder (`PromotionForm`); "text" maps to the
 * promotion-text composer. Editing an existing flyer/text still uses the
 * type-locked modals in the parent panels — this is the create-new surface only.
 */
export function PromotionNewModal({
  open,
  onClose,
  initialKind = "flyer",
  initialStepId,
  draft,
  setDraft,
  listings,
  onSelectProperty,
  hidePropertyPicker = false,
  onGenerateFlyer,
  flyerBusy = false,
  onGenerateText,
  textBusy = false,
  textInitialFormat,
  textInitialTone,
  textInitialImages,
  onUploadPromotion,
  uploadBusy = false,
}: {
  open: boolean;
  onClose: () => void;
  initialKind?: PromotionAssetKind;
  /** Suggestion + lands on Content with Kind already chosen. */
  initialStepId?: "kind" | "content" | "preview";
  draft: PromotionDraft;
  setDraft: Dispatch<SetStateAction<PromotionDraft>>;
  listings: ManagerPromotionPropertyOption[];
  onSelectProperty: (key: string) => void;
  hidePropertyPicker?: boolean;
  onGenerateFlyer: () => void;
  flyerBusy?: boolean;
  onGenerateText: (opts: PromotionTextGenerateOptions) => void;
  textBusy?: boolean;
  textInitialFormat?: PromotionTextFormat;
  textInitialTone?: string;
  textInitialImages?: string[];
  onUploadPromotion?: (file: File) => void | Promise<void>;
  uploadBusy?: boolean;
}) {
  const [kind, setKind] = useState<PromotionAssetKind>(initialKind);
  const [stepIdx, setStepIdx] = useState(0);
  // Snapshot of the flyer draft as it was seeded. Anything the user changes from
  // this counts as "entered content" for the discard warn, and it's what we reset
  // back to when the flyer form is abandoned on a switch.
  const flyerBaseRef = useRef<PromotionDraft>(draft);
  const flyerBasePropertyRef = useRef<string>(draft.propertyKey);
  const textDirtyRef = useRef(false);
  const [flyerBase, setFlyerBase] = useState<PromotionDraft>(draft);
  const [textDirty, setTextDirty] = useState(false);
  const textComposerRef = useRef<PromotionTextComposerHandle>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadFileName, setUploadFileName] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setKind(initialKind);
    setStepIdx(initialStepId === "content" ? 1 : initialStepId === "preview" ? 2 : 0);
    flyerBaseRef.current = draft;
    flyerBasePropertyRef.current = draft.propertyKey;
    textDirtyRef.current = false;
    setFlyerBase(draft);
    setTextDirty(false);
    setUploadFile(null);
    setUploadFileName(null);
    setUploadError(null);
    // Intentionally only re-run on open — draft is captured as the opening seed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialKind, initialStepId]);

  // Selecting a property (here or in the text composer) re-derives most of the
  // draft from the listing, and a parent can re-seed the draft while the modal is
  // already open (the demo autofill does). Both are autofill, not typed content,
  // so they re-baseline rather than tripping the discard warning.
  useEffect(() => {
    if (!open || draft.propertyKey === flyerBasePropertyRef.current) return;
    flyerBaseRef.current = draft;
    flyerBasePropertyRef.current = draft.propertyKey;
    setFlyerBase(draft);
  }, [open, draft]);

  const handleTextDirty = useCallback((dirty: boolean) => {
    textDirtyRef.current = dirty;
    setTextDirty(dirty);
  }, []);

  const confirm = useConfirm();

  async function requestSwitch(next: PromotionAssetKind) {
    if (next === kind) return;
    if (flyerBusy || textBusy || uploadBusy) return;
    const leavingDirty =
      kind === "flyer"
        ? flyerContentChanged(draft, flyerBaseRef.current)
        : kind === "text"
          ? textDirtyRef.current
          : Boolean(uploadFile);
    if (
      leavingDirty &&
      !(await confirm({
        title: "Switch type",
        description: "Switch promotion type?",
        note: "The content you've entered will be discarded.",
        confirmLabel: "Switch",
      }))
    ) {
      return;
    }
    // Discard the form we're leaving: the flyer draft resets to its baseline
    // (seed + property autofill); the text composer unmounts when kind changes.
    if (kind === "flyer") setDraft(flyerBaseRef.current);
    textDirtyRef.current = false;
    setTextDirty(false);
    setUploadFile(null);
    setUploadFileName(null);
    setUploadError(null);
    setKind(next);
  }

  const saveUpload = () => {
    if (!hidePropertyPicker && draft.propertyKey === CUSTOM_PROPERTY_KEY) {
      setUploadError("Select a property for this promotion.");
      return;
    }
    if (!uploadFile) {
      setUploadError("Choose a promotion file to upload.");
      return;
    }
    void onUploadPromotion?.(uploadFile);
  };

  const assistantContext = buildPromotionNewModalAssistantContext(draft, kind);
  const kindLabel = PROMOTION_KIND_OPTIONS.find((opt) => opt.id === kind)?.label ?? "Promotion";
  const workspaceSteps: AddWorkspaceStep[] = [
    { id: "kind", label: "Kind", summary: kindLabel },
    { id: "content", label: "Content", summary: kind === "upload" ? uploadFileName || "Choose a file" : draft.title || draft.headline || "Listing facts" },
    { id: "preview", label: "Preview", summary: kindLabel },
  ];
  const current = Math.min(stepIdx, workspaceSteps.length - 1);
  const stepId = workspaceSteps[current]!.id;
  const lastLabel = kind === "flyer" ? "Generate flyer" : kind === "upload" ? "Save promotion" : "Generate promotion text";
  const lastDisabled = flyerBusy || textBusy || uploadBusy || (kind === "upload" && !uploadFile);
  const finish = () => {
    if (kind === "flyer") onGenerateFlyer();
    else if (kind === "upload") saveUpload();
    else textComposerRef.current?.generate();
  };
  const leavingDirty =
    kind === "flyer"
      ? flyerContentChanged(draft, flyerBase)
      : kind === "text"
        ? textDirty
        : Boolean(uploadFile);

  if (!open) return null;

  return (
    <AddWorkspace
      title="New promotion"
      steps={workspaceSteps}
      current={current}
      onJump={setStepIdx}
      onClose={onClose}
      dirty={leavingDirty}
      discardTitle="Discard this promotion?"
      assistantContext={assistantContext}
      assistantScopeKey="New promotion"
      sidePanel={
        <PreviewPanel
          title="Promotion preview"
          name={kindLabel}
          sub={draft.propertyLabel || draft.address || undefined}
          facts={[
            { label: "Type", value: kindLabel },
            { label: "Property", value: draft.propertyLabel || "Not set", warn: !draft.propertyLabel },
            { label: "Headline", value: draft.headline || "From listing", warn: false },
          ]}
          creates={[{ tone: "yes", text: kind === "upload" ? "Saves the file on this property" : `Generates a ${kindLabel.toLowerCase()}` }]}
        />
      }
      lastLabel={lastLabel}
      lastDisabled={lastDisabled}
      busy={flyerBusy || textBusy || uploadBusy}
      onFinish={finish}
      dataAttrPrefix="promotion-new"
      finishDataAttr={kind === "flyer" ? "promotion-generate" : kind === "upload" ? "promotion-upload-save" : "promotion-text-generate-submit"}
      footerNote={uploadError ? <span className="text-sm text-rose-600">{uploadError}</span> : null}
    >
      {stepId === "kind" ? (
        <StepColumn>
          <StepHeading title="Kind" />
          <WizardSelect
            label="Promotion type"
            value={kind}
            onChange={(next) => void requestSwitch(next as PromotionAssetKind)}
            options={PROMOTION_KIND_OPTIONS.map((opt) => ({ value: opt.id, label: opt.label }))}
            disabled={flyerBusy || textBusy || uploadBusy}
            dataAttr="promotion-new-kind"
          />
          {!hidePropertyPicker ? (
            <WizardSelect
              label="Property"
              value={draft.propertyKey}
              onChange={onSelectProperty}
              options={[
                { value: CUSTOM_PROPERTY_KEY, label: "Custom" },
                ...listings.map((listing) => ({ value: listing.id, label: listing.label })),
              ]}
              dataAttr="promotion-new-property"
            />
          ) : null}
        </StepColumn>
      ) : null}
      {stepId === "content" ? (
        <StepColumn wide>
          <StepHeading title="Content" />
          {kind === "flyer" ? (
            <PromotionForm
              draft={draft}
              setDraft={setDraft}
              listings={listings}
              onSelectProperty={onSelectProperty}
              hidePropertyPicker
            />
          ) : kind === "upload" ? (
            <div className="space-y-4">
              <PromotionUploadComposer
                fileName={uploadFileName}
                error={uploadError}
                onPickFile={(file) => {
                  setUploadError(null);
                  setUploadFile(file);
                  setUploadFileName(file?.name ?? null);
                }}
              />
            </div>
          ) : (
            <PromotionTextComposer
              ref={textComposerRef}
              onGenerate={onGenerateText}
              busy={textBusy}
              initialFormat={textInitialFormat}
              initialTone={textInitialTone}
              initialImages={textInitialImages}
              onDirtyChange={handleTextDirty}
              propertyKey={undefined}
              listings={listings}
              onSelectProperty={undefined}
            />
          )}
        </StepColumn>
      ) : null}
      {stepId === "preview" ? (
        <StepColumn>
          <StepHeading title="Preview" />
          <PreviewPanel
            title="Promotion preview"
            name={kindLabel}
            sub={draft.propertyLabel || draft.address || undefined}
            facts={[
              { label: "Type", value: kindLabel },
              { label: "Property", value: draft.propertyLabel || "Not set", warn: !draft.propertyLabel },
              { label: "Headline", value: draft.headline || "From listing" },
            ]}
            creates={[{ tone: "yes", text: kind === "upload" ? "Saves the file on this property" : `Generates a ${kindLabel.toLowerCase()}` }]}
          />
        </StepColumn>
      ) : null}
    </AddWorkspace>
  );
}
