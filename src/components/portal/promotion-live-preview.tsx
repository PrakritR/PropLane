"use client";

import { useEffect, useState } from "react";
import { type PromotionDraft } from "@/components/portal/promotion-form";
import type { PromotionTextGenerateOptions } from "@/components/portal/promotion-text-generate-modal";
import { formatPromotionTextPlain, PROMOTION_TEXT_FORMAT_OPTIONS } from "@/lib/promotion-text";

/** Un-generated draft layout uses only manager-entered facts, never invented amenities. */
export function PromotionPostPreview({ draft, options }: { draft: PromotionDraft; options: PromotionTextGenerateOptions }) {
  const hook = draft.headline.trim() || draft.title.trim();
  const body = [draft.address, draft.price, draft.sellingPoints, draft.customDetails, draft.promo].map((value) => value.trim()).filter(Boolean).join("\n\n");
  const ctaLine = [draft.cta, draft.contact, draft.includeSchedulingLink ? draft.schedulingUrl : ""].map((value) => value.trim()).filter(Boolean).join(" · ");
  const copy = { format: options.format, hook, body, ctaLine, hashtags: "", ...(options.format === "email_blast" ? { subjectLine: hook } : {}) };
  return <article className="overflow-hidden rounded-xl border border-border bg-card" data-attr="promotion-post-preview">
    <header className="border-b border-border px-4 py-3">
      <p className="text-xs font-semibold text-muted">{PROMOTION_TEXT_FORMAT_OPTIONS.find((format) => format.id === options.format)?.label} · Draft</p>
      {draft.propertyLabel ? <p className="font-semibold">{draft.propertyLabel}</p> : null}
    </header>
    {options.images.length ? <div className="grid grid-cols-2 gap-1">
      {options.images.map((src, index) => (
        // Real manager-selected photos only; blob/data URLs need no image optimizer.
        // eslint-disable-next-line @next/next/no-img-element
        <img key={`${index}-${src.slice(-40)}`} src={src} alt={`Promotion photo ${index + 1}`} className="aspect-square w-full object-cover" />
      ))}
    </div> : null}
    <div className="whitespace-pre-wrap break-words p-4 text-sm leading-relaxed">{formatPromotionTextPlain(copy)}</div>
  </article>;
}

/**
 * `URL.createObjectURL` always hands back `blob:<origin>/<uuid>`, but the value
 * still carries the picked file as its taint source, so pin it to that shape
 * before it reaches an `src` / `href` / `data` attribute. Fully anchored over a
 * charset with no HTML meta-characters (CodeQL js/xss-through-dom).
 */
const OBJECT_URL_RE = /^blob:[A-Za-z0-9._~:/?#@!$&*+,;=%()[\]-]+$/;

/** Preview the selected local file, never a fabricated marketing image. */
export function PromotionUploadPreview({ file }: { file: File | null }) {
  const [source, setSource] = useState<{ file: File; url: string } | null>(null);
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setSource({ file, url });
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const url = source?.file === file && OBJECT_URL_RE.test(source.url) ? source.url : null;
  if (!file) return <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted">Choose a file</div>;
  return <article className="overflow-hidden rounded-xl border border-border bg-card" data-attr="promotion-upload-preview">
    <p className="break-words border-b border-border px-4 py-3 text-sm font-semibold">{file.name}</p>
    {!url ? <p role="status" className="p-4 text-sm">Loading preview…</p> : file.type.startsWith("image/") ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={url} alt={file.name} className="h-auto w-full" />
    ) : file.type === "application/pdf" || /\.pdf$/i.test(file.name) ? (
      <object data={url} type="application/pdf" aria-label={`Preview ${file.name}`} className="aspect-[8.5/11] w-full"><a href={url} download={file.name}>Download {file.name}</a></object>
    ) : <a className="block p-4 text-primary" href={url} download={file.name}>Download {file.name}</a>}
  </article>;
}
