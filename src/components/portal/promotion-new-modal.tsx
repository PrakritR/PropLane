"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Select } from "@/components/ui/input";
import {
  CUSTOM_PROPERTY_KEY,
  PromotionForm,
  PromotionPropertyPicker,
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

const PROMOTION_KIND_OPTIONS: { id: PromotionAssetKind; label: string; description: string }[] = [
  { id: "flyer", label: "Flyer", description: "Printable or social-ready design." },
  { id: "text", label: "Text", description: "Caption, email, SMS, or listing blurb." },
  { id: "upload", label: "Upload your own", description: "Use your own image or PDF for this property." },
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
  draft: PromotionDraft;
  setDraft: React.Dispatch<React.SetStateAction<PromotionDraft>>;
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
  // Snapshot of the flyer draft as it was seeded. Anything the user changes from
  // this counts as "entered content" for the discard warn, and it's what we reset
  // back to when the flyer form is abandoned on a switch.
  const flyerBaseRef = useRef<PromotionDraft>(draft);
  const flyerBasePropertyRef = useRef<string>(draft.propertyKey);
  const textDirtyRef = useRef(false);
  const textComposerRef = useRef<PromotionTextComposerHandle>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadFileName, setUploadFileName] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setKind(initialKind);
    flyerBaseRef.current = draft;
    flyerBasePropertyRef.current = draft.propertyKey;
    textDirtyRef.current = false;
    setUploadFile(null);
    setUploadFileName(null);
    setUploadError(null);
    // Intentionally only re-run on open — draft is captured as the opening seed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialKind]);

  // Selecting a property (here or in the text composer) re-derives most of the
  // draft from the listing, and a parent can re-seed the draft while the modal is
  // already open (the demo autofill does). Both are autofill, not typed content,
  // so they re-baseline rather than tripping the discard warning.
  useEffect(() => {
    if (!open || draft.propertyKey === flyerBasePropertyRef.current) return;
    flyerBaseRef.current = draft;
    flyerBasePropertyRef.current = draft.propertyKey;
  }, [open, draft]);

  const handleTextDirty = useCallback((dirty: boolean) => {
    textDirtyRef.current = dirty;
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

  const selected = PROMOTION_KIND_OPTIONS.find((o) => o.id === kind);
  const assistantContext = buildPromotionNewModalAssistantContext(draft, kind);

  return (
    <Modal
      open={open}
      title="New promotion"
      onClose={onClose}
      panelClassName="max-w-2xl"
      assistantContext={assistantContext}
      assistantStorageScopeKey="New promotion"
      footer={
        kind === "flyer" ? (
          <ModalFooter>
            <Button
              type="button"
              onClick={onGenerateFlyer}
              disabled={flyerBusy}
              data-attr="promotion-generate"
            >
              {flyerBusy ? "Generating…" : "Generate flyer"}
            </Button>
          </ModalFooter>
        ) : kind === "upload" ? (
          <ModalFooter>
            <Button
              type="button"
              onClick={saveUpload}
              disabled={uploadBusy || !uploadFile}
              data-attr="promotion-upload-save"
            >
              {uploadBusy ? "Saving…" : "Save promotion"}
            </Button>
          </ModalFooter>
        ) : (
          <ModalFooter>
            <Button
              type="button"
              disabled={textBusy}
              data-attr="promotion-text-generate-submit"
              onClick={() => textComposerRef.current?.generate()}
            >
              {textBusy ? "Generating…" : "Generate promotion text"}
            </Button>
          </ModalFooter>
        )
      }
    >
      {/* The Modal body is the one scroll container — no nested scroller here,
          which trapped touch scrolling in the native WebView. */}
      <div className="pr-1">
        <div className="mb-3">
          <label className="text-xs font-semibold text-muted" htmlFor="promotion-new-kind">
            Promotion type
          </label>
          <Select
            id="promotion-new-kind"
            className="mt-1"
            value={kind}
            onChange={(e) => requestSwitch(e.target.value as PromotionAssetKind)}
            disabled={flyerBusy || textBusy || uploadBusy}
            data-attr="promotion-new-kind"
          >
            {PROMOTION_KIND_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </Select>
          {selected ? <p className="mt-1.5 text-xs text-muted">{selected.description}</p> : null}
        </div>

        {kind === "flyer" ? (
          <PromotionForm
            draft={draft}
            setDraft={setDraft}
            listings={listings}
            onSelectProperty={onSelectProperty}
            hidePropertyPicker={hidePropertyPicker}
          />
        ) : kind === "upload" ? (
          <div className="space-y-4">
            {!hidePropertyPicker ? (
              <PromotionPropertyPicker
                id="promotion-upload-property"
                value={draft.propertyKey}
                listings={listings}
                onSelect={onSelectProperty}
              />
            ) : null}
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
            propertyKey={hidePropertyPicker ? undefined : draft.propertyKey}
            listings={listings}
            onSelectProperty={hidePropertyPicker ? undefined : onSelectProperty}
          />
        )}
      </div>
    </Modal>
  );
}
