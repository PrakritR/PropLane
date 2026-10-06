"use client";

import Image from "next/image";
import { useRef, type ReactNode } from "react";
import { Check, Clock3, ImagePlus } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { RecordFactCard, RecordFactRow } from "@/components/portal/portal-record-overview-kit";
import { cn } from "@/lib/utils";
import type { StageBarItem } from "@/lib/work-order-bid-cycle";
import type { ServiceActivityEvent } from "@/lib/service-activity";

// A stored photo link must be http(s) or an inline image data URL before it reaches <a href> / <Image src>.
const SAFE_PHOTO_HREF_RE =
  /^(?:data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+|https?:\/\/[A-Za-z0-9._~:/?#@!$&*+,;=%()[\]-]+)$/i;

/** A card of label / value rows on the Service page (Request, Home). */
export type ServiceDetailsCard = {
  id: string;
  title: string;
  action?: { label: string; href: string };
  rows: ReadonlyArray<{ label: string; value: ReactNode }>;
};

/**
 * The stage stepper at the top of the Service page: Open -> Assigned -> Scheduled -> Completed (and
 * Paid for a job a vendor is paid for). Done steps are filled and ticked, the current one outlined,
 * the rest muted.
 */
export function ServiceStageStepper({ stages }: { stages: readonly StageBarItem[] }) {
  const current = stages.find((stage) => stage.state === "current");
  if (stages.length === 0) return null;
  return (
    <ol
      className="flex flex-wrap items-center gap-y-2 rounded-2xl border border-border bg-card px-4 py-3"
      data-attr="service-stage-stepper"
      aria-label={current ? `Stage: ${current.label}` : "Stage"}
    >
      {stages.map((stage, index) => (
        <li
          key={stage.id}
          data-stage-state={stage.state}
          aria-current={stage.state === "current" ? "step" : undefined}
          className={cn(
            "flex items-center gap-2 text-[13px] font-semibold",
            stage.state === "todo" ? "text-muted" : stage.state === "current" ? "text-primary" : "text-foreground",
          )}
        >
          {index > 0 ? <span aria-hidden className="mx-2 h-0.5 w-5 bg-border" /> : null}
          <span
            aria-hidden
            className={cn(
              "grid size-5 place-items-center rounded-full border-2",
              stage.state === "done" ? "border-primary bg-primary text-white" : stage.state === "current" ? "border-primary" : "border-border",
            )}
          >
            {stage.state === "done" ? <Check className="size-3" strokeWidth={3} /> : null}
          </span>
          {stage.label}
        </li>
      ))}
    </ol>
  );
}

const MAX_PHOTO_EDGE = 1280;

/** A picked photo as a small JPEG data URL (long edge 1280 px); the original data URL when it cannot be drawn. */
async function photoFileToDataUrl(file: File): Promise<string> {
  const original = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new window.Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode"));
      el.src = original;
    });
    const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(image.width, image.height, 1));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return original;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82);
  } catch {
    return original;
  }
}

/**
 * The Service page, ONE page for a maintenance service and an add-on, top to bottom: the stage stepper,
 * Who's doing it, the Request and Home cards, Photos (count + the add-photo icon in its header) and
 * Activity. There are no sub-tabs and no stat tiles - the status is the stepper, the assignee and the
 * price live in Who's doing it, and the priority is a Request fact. The Needs-you row is gone with the
 * tiles: its one action is the header's labeled primary.
 */
export function ServiceDetailsSection({
  stages,
  who,
  cards,
  photos,
  onAddPhotos,
  activity,
}: {
  stages: readonly StageBarItem[];
  /** The Who's doing it card (`ServiceWhoCard`). */
  who: ReactNode;
  cards: readonly ServiceDetailsCard[];
  photos: readonly string[];
  /** The add-photo icon; omit where the record cannot take photos. Receives the picked images as data URLs. */
  onAddPhotos?: (dataUrls: string[]) => void | Promise<void>;
  activity: readonly ServiceActivityEvent[];
}) {
  const picker = useRef<HTMLInputElement>(null);
  const safePhotos = photos.map((src) => src.trim()).filter((src) => SAFE_PHOTO_HREF_RE.test(src));
  return (
    <div data-attr="service-details" className="space-y-3 pb-6">
      <ServiceStageStepper stages={stages} />
      {who}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2" data-attr="service-details-cards">
        {cards.map((card) => (
          <RecordFactCard key={card.id} title={card.title} action={card.action} dataAttr={`record-overview-card-${card.id}`}>
            {card.rows.map((row) => (
              <RecordFactRow key={row.label} label={row.label} value={row.value} />
            ))}
          </RecordFactCard>
        ))}
      </div>
      <RecordFactCard
        title="Photos"
        count={safePhotos.length}
        dataAttr="service-photos"
        headerActions={
          onAddPhotos ? (
            <>
              <PortalIconAction icon={ImagePlus} label="Add photo" data-attr="service-photos-add" onClick={() => picker.current?.click()} />
              <input
                ref={picker}
                type="file"
                accept="image/*"
                multiple
                hidden
                data-attr="service-photos-input"
                onChange={async (event) => {
                  const files = [...(event.target.files ?? [])].filter((file) => file.type.startsWith("image/"));
                  event.target.value = "";
                  if (files.length === 0) return;
                  await onAddPhotos(await Promise.all(files.map(photoFileToDataUrl)));
                }}
              />
            </>
          ) : undefined
        }
      >
        {safePhotos.length > 0 ? (
          <div className="grid grid-cols-2 gap-2 p-[var(--portal-card-padding,16px)] sm:grid-cols-4" data-attr="work-order-photos">
            {/* The allowlist is re-tested on the value that reaches <a href> / <Image src>, so it
                sits directly on the sinks: no other-scheme string can be rendered even if the
                list above is ever rebuilt from somewhere else. */}
            {safePhotos.map((src, index) =>
              SAFE_PHOTO_HREF_RE.test(src) ? (
                <a key={`${index}-${src.slice(-24)}`} href={src} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-xl border border-border bg-accent/30">
                  <Image src={src} alt={`Service photo ${index + 1}`} width={240} height={180} className="h-28 w-full object-cover" unoptimized />
                </a>
              ) : null,
            )}
          </div>
        ) : (
          <p className="px-[var(--portal-card-padding,16px)] py-3.5 text-[13.5px] text-muted" data-attr="work-order-photos-empty">
            None yet
          </p>
        )}
      </RecordFactCard>
      <RecordFactCard title="Activity" dataAttr="service-activity">
        {activity.length > 0 ? (
          <ol className="divide-y divide-border/70" data-attr="record-activity-list">
            {activity.map((event) => (
              <li key={event.id} className="flex items-start gap-2.5 px-[var(--portal-card-padding,16px)] py-3">
                <Clock3 className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                <div className="min-w-0">
                  <p className="text-[14px] font-medium text-foreground">{event.label}</p>
                  <p className="text-[12px] text-muted">{event.timestamp}</p>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="px-[var(--portal-card-padding,16px)] py-3.5 text-[13.5px] text-muted" data-attr="record-activity-empty">
            No activity yet
          </p>
        )}
      </RecordFactCard>
    </div>
  );
}
