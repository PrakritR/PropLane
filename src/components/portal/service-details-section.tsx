"use client";

import Image from "next/image";
import { useState, type ReactNode } from "react";
import { Pencil } from "lucide-react";
import { Input } from "@/components/ui/input";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { RecordTabBand } from "@/components/portal/record-list-band";
import { ServiceProgressLine } from "@/components/portal/service-vendor-cycle-section";
import { renderRecordSection } from "@/components/portal/record-section-renderers";
import { sanitizeMoneyInput } from "@/lib/listing-form-inputs";
import type { StageBarItem } from "@/lib/work-order-bid-cycle";
import type { ServiceActivityEvent } from "@/lib/service-activity";

// A stored photo link must be http(s) or an inline image data URL before it reaches <a href> / <Image src>.
const SAFE_PHOTO_HREF_RE =
  /^(?:data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+|https?:\/\/[A-Za-z0-9._~:/?#@!$&*+,;=%()[\]-]+)$/i;

type DetailsTab = "details" | "photos" | "activity";

/**
 * The Service section: the standard band (Details · Photos · Activity with counts, the Edit icon at
 * the top right), the compact progress line, then the tab's content - the overview cards, the
 * resident's photos, or what happened. The same section serves a maintenance service and an add-on.
 */
export function ServiceDetailsSection({
  stages,
  photos,
  activity,
  onEdit,
  details,
}: {
  stages: readonly StageBarItem[];
  photos: readonly string[];
  activity: readonly ServiceActivityEvent[];
  /** The Edit icon; omit where the record cannot be edited. */
  onEdit?: () => void;
  details: ReactNode;
}) {
  const [tab, setTab] = useState<DetailsTab>("details");
  const safePhotos = photos.map((src) => src.trim()).filter((src) => SAFE_PHOTO_HREF_RE.test(src));
  return (
    <div data-attr="service-details" className="pb-6">
      <RecordTabBand
        dataAttr="service-details"
        ariaLabel="Service details"
        tabs={[
          { id: "details", label: "Details" },
          { id: "photos", label: "Photos", count: safePhotos.length },
          { id: "activity", label: "Activity", count: activity.length },
        ]}
        activeId={tab}
        onChange={(id) => setTab(id as DetailsTab)}
        actions={onEdit ? <PortalIconAction icon={Pencil} label="Edit" data-attr="service-details-edit" onClick={onEdit} /> : undefined}
      />
      <ServiceProgressLine stages={stages} />
      {tab === "details" ? details : null}
      {tab === "photos" ? (
        safePhotos.length > 0 ? (
          <div className="grid grid-cols-2 gap-2 px-3 sm:grid-cols-3 sm:px-4" data-attr="work-order-photos">
            {safePhotos.map((src, index) => (
              <a key={`${index}-${src.slice(-24)}`} href={src} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-xl border border-border bg-accent/30">
                <Image src={src} alt={`Service photo ${index + 1}`} width={240} height={180} className="h-28 w-full object-cover" unoptimized />
              </a>
            ))}
          </div>
        ) : (
          <PortalListEmptyCard title="No photos yet" workspaceAware={false} dataAttr="work-order-photos-empty" />
        )
      ) : null}
      {tab === "activity"
        ? renderRecordSection("activity", {
            role: "manager",
            kind: "service",
            kindLabel: "service",
            recordId: "activity",
            activity: activity.map(({ id, label, timestamp }) => ({ id, label, timestamp })),
          })
        : null}
    </div>
  );
}

/** Edit an add-on request's charges (the same two fields, and the same write, as the header Edit on a pending request). */
export function AddOnEditDialog({
  open,
  title,
  price,
  deposit,
  onClose,
  onSave,
}: {
  open: boolean;
  title: string;
  price: string;
  deposit: string;
  onClose: () => void;
  onSave: (next: { price: string; deposit: string }) => void;
}) {
  const [priceDraft, setPriceDraft] = useState(price);
  const [depositDraft, setDepositDraft] = useState(deposit);
  const [seed, setSeed] = useState({ price, deposit, open });
  if (seed.open !== open || seed.price !== price || seed.deposit !== deposit) {
    setSeed({ price, deposit, open });
    if (open) {
      setPriceDraft(price);
      setDepositDraft(deposit);
    }
  }
  return (
    <PortalDialog
      open={open}
      onClose={onClose}
      title={`Edit ${title}`}
      primaryAction={{
        label: "Save changes",
        onClick: () => {
          onSave({ price: priceDraft.trim(), deposit: depositDraft.trim() });
          onClose();
        },
        dataAttr: "service-edit-save",
      }}
    >
      <div className="space-y-4" data-attr="service-edit-dialog">
        <label className="block text-xs font-medium text-muted">
          Service fee
          <Input value={priceDraft} inputMode="decimal" placeholder="$0" onChange={(e) => setPriceDraft(sanitizeMoneyInput(e.target.value))} data-attr="service-edit-price" />
        </label>
        <label className="block text-xs font-medium text-muted">
          Deposit
          <Input value={depositDraft} inputMode="decimal" placeholder="$0" onChange={(e) => setDepositDraft(sanitizeMoneyInput(e.target.value))} data-attr="service-edit-deposit" />
        </label>
      </div>
    </PortalDialog>
  );
}
