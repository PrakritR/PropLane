"use client";

import { useMemo, type Dispatch, type SetStateAction } from "react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { PromotionFlyerPreview } from "@/components/portal/promotion-flyer-preview";
import { PromotionPostPreview } from "@/components/portal/promotion-live-preview";
import { EMPTY_DRAFT, PromotionForm, draftInputs, type PromotionDraft } from "@/components/portal/promotion-form";
import type { MockProperty } from "@/data/types";
import type { ManagerPromotionRow } from "@/lib/promotion-flyer";
import type { PropertyPromotionBuiltinDef } from "@/lib/property-promotion-builtin";
import { buildManagerPromotionPropertyOptions } from "@/lib/manager-property-links";
import type { PromotionTextFormat } from "@/lib/promotion-text";

export function PropertyPromotionBuiltinModal({
  open,
  def,
  draft,
  setDraft,
  property,
  promotionRow,
  textFormat,
  textBody,
  onTextBodyChange,
  managerUserId,
  onClose,
  onSave,
  busy,
}: {
  open: boolean;
  def: PropertyPromotionBuiltinDef | null;
  draft: PromotionDraft;
  setDraft: Dispatch<SetStateAction<PromotionDraft>>;
  property: MockProperty | null;
  promotionRow: ManagerPromotionRow | null;
  managerUserId: string | null;
  textFormat?: PromotionTextFormat;
  textBody?: string;
  onTextBodyChange?: (next: string) => void;
  onClose: () => void;
  onSave: () => void;
  busy?: boolean;
}) {
  const listings = useMemo(
    () => buildManagerPromotionPropertyOptions(managerUserId),
    [managerUserId],
  );

  const previewRow = useMemo((): ManagerPromotionRow | null => {
    if (!def || def.kind !== "flyer" || !property) return null;
    const now = new Date().toISOString();
    return {
      id: promotionRow?.id ?? "preview",
      managerUserId: promotionRow?.managerUserId ?? null,
      propertyId: property.id,
      propertyLabel: draft.propertyLabel || property.title,
      title: def.name,
      theme: draft.theme,
      flyerSize: draft.flyerSize,
      template: draft.template,
      status: "generated",
      inputs: draftInputs(draft),
      copy: null,
      createdAt: now,
      updatedAt: now,
    };
  }, [def, draft, promotionRow, property]);

  if (!def) return null;

  return (
    <Modal
      open={open}
      title={`Edit ${def.name}`}
      onClose={onClose}
      panelClassName="max-w-4xl"
      footer={
        <ModalFooter className="w-full">
          <Button type="button" variant="primary" className="ml-auto rounded-full" disabled={busy} onClick={onSave} data-attr="property-promotion-builtin-save">
            {busy ? "Saving…" : "Save"}
          </Button>
        </ModalFooter>
      }
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          {def.kind === "flyer" ? (
            <PromotionForm draft={draft} setDraft={setDraft} listings={listings} onSelectProperty={() => {}} hidePropertyPicker />
          ) : def.kind === "text" ? (
            <>
              <label className="text-sm font-semibold" htmlFor="property-promo-builtin-text">
                Text
              </label>
              <Textarea
                id="property-promo-builtin-text"
                rows={12}
                value={textBody ?? ""}
                onChange={(e) => onTextBodyChange?.(e.target.value)}
                className="mt-2"
                data-attr="property-promotion-builtin-text"
              />
            </>
          ) : (
            <p className="text-sm text-muted">
              The door card uses your public house link and QR settings from House details printables.
            </p>
          )}
        </div>
        <div data-attr="property-promotion-builtin-preview">
          <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-muted">As it will appear</p>
          {def.kind === "flyer" && previewRow ? (
            <PromotionFlyerPreview promotion={previewRow} embedded />
          ) : def.kind === "text" && textFormat ? (
            <PromotionPostPreview
              draft={{ ...EMPTY_DRAFT, ...draft, sellingPoints: textBody ?? "", headline: draft.headline || draft.propertyLabel }}
              options={{ format: textFormat, tone: draft.tone, extraInstructions: "", images: draft.images }}
            />
          ) : def.kind === "print" ? (
            <div className="rounded-2xl border border-border bg-card p-6 text-center">
              <p className="text-lg font-bold">{property?.title ?? "Your property"}</p>
              <p className="mt-2 text-xs font-semibold uppercase tracking-[0.12em] text-primary">Welcome home</p>
              <div className="mx-auto mt-4 h-24 w-24 rounded-xl border-2 border-foreground" aria-hidden />
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
