"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { NoImagePlaceholder } from "@/components/ui/no-image-placeholder";
import { roomAvailabilityTextClasses } from "@/lib/room-availability-style";
import { isListingFallbackBathroom, isListingPlaceholderSharedSpace } from "@/components/marketing/listing-key-facts";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useIsClient } from "@/hooks/use-is-client";
import type {
  AmenityItem,
  BundleCard,
  LeaseBasicRow,
  ListingBathroomRow,
  ListingFloorCard,
  ListingRoomRow,
  ListingSharedRow,
} from "@/data/listing-rich-content";
import {
  listingLinkTargetProps,
  useListingPreviewNewTab,
  useListingSidebarRenterCtas,
} from "@/components/marketing/listing-preview-context";
import {
  buildSmsDeepLink,
  isClawMessagingPubliclyEnabled,
} from "@/lib/claw-leasing-links";
import { useProspectListingHrefs } from "@/hooks/use-prospect-listing-hrefs";
import { listingApplyLabel, listingMessageLabel } from "@/lib/listing-prospect-cta-labels";
import { getRoomUnavailabilityWindows, LISTING_ROOM_CHOICE_SEP, type RoomUnavailabilityWindow } from "@/lib/rental-application/data";
import { roomAvailabilityPillClasses, roomAvailabilityTone } from "@/lib/room-availability-style";
import { formatRoomPriceAmount } from "@/lib/room-pricing";
import { RoomAvailabilityMonthCalendar, type RoomCalendarSpan } from "@/components/room-availability-month-calendar";

const LISTING_TABLE_HEAD =
  "text-[10px] font-semibold uppercase tracking-wide text-muted sm:text-[11px]";
const LISTING_FLOOR_CARD =
  "overflow-hidden rounded-xl border border-border bg-card shadow-sm listing-detail-surface";
const LISTING_DETAIL_BUTTON =
  "listing-detail-control inline-flex min-h-[36px] shrink-0 items-center justify-center rounded-full border border-border bg-card px-3.5 py-1.5 text-[11px] font-semibold text-foreground shadow-sm transition hover:border-primary/45 hover:bg-accent/35 hover:text-primary sm:min-h-0";

function AvailabilityPill({ text, variant = "default" }: { text: string; variant?: "default" | "room" }) {
  if (variant === "room") {
    const tone = roomAvailabilityTone(text);
    const { wrap, dot } = roomAvailabilityPillClasses(tone);
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 sm:gap-1.5 sm:px-2.5 sm:py-1 sm:text-xs ${wrap}`}
      >
        <span className={`h-1 w-1 shrink-0 rounded-full sm:h-1.5 sm:w-1.5 ${dot}`} />
        {text}
      </span>
    );
  }
  const t = text.toLowerCase();
  const green = t.includes("available") || t.includes("included");
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)] sm:gap-1.5 sm:px-2.5 sm:py-1 sm:text-xs ${
        green ? "portal-badge-success" : "border border-border bg-accent/35 text-foreground"
      }`}
    >
      <span className={`h-1 w-1 shrink-0 rounded-full sm:h-1.5 sm:w-1.5 ${green ? "bg-emerald-500" : "bg-muted"}`} />
      {text}
    </span>
  );
}


function DetailsButton({ onClick, className = "" }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      data-attr="listing-row-details"
      onClick={onClick}
      className={`${LISTING_DETAIL_BUTTON} ${className}`}
    >
      Details
    </button>
  );
}

function formatRangeDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function rangeSummaryLabel(w: RoomUnavailabilityWindow): string {
  if (w.start && w.end) return `Unavailable ${formatRangeDate(w.start)} to ${formatRangeDate(w.end)}`;
  if (w.start) return `Unavailable from ${formatRangeDate(w.start)}`;
  if (w.end) return `Unavailable until ${formatRangeDate(w.end)}`;
  return "Unavailable dates set";
}

function RoomAvailabilityTimelineCalendar({ windows }: { windows: RoomUnavailabilityWindow[] }) {
  // Every window a renter sees is simply "not open" — one colour.
  const spans: RoomCalendarSpan[] = windows.map((w) => ({ start: w.start, end: w.end, tone: "occupied" }));
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        Green dates are open and red dates are unavailable. Use the arrows to browse upcoming months.
      </p>
      <RoomAvailabilityMonthCalendar spans={spans} />
    </div>
  );
}

const LISTING_MODAL_LABEL = "text-xs font-semibold uppercase tracking-wide text-muted";
const LISTING_MODAL_CARD = "rounded-xl border border-border bg-card p-4";
const LISTING_MODAL_MEDIA_WRAP = "mx-auto flex w-full max-w-2xl flex-col items-center";
const LISTING_MODAL_MEDIA_FRAME = "aspect-video w-full overflow-hidden rounded-lg";

function ListingModalBody({
  children,
  footer,
}: {
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="space-y-4 p-5 sm:p-6">{children}</div>
      </div>
      {footer ? <div className="shrink-0 border-t border-border bg-card px-5 py-4 sm:px-6">{footer}</div> : null}
    </>
  );
}

function ListingModalHeader({
  eyebrow,
  title,
  subtitle,
  icon,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  icon?: string;
}) {
  return (
    <header className="border-b border-border pb-4">
      {eyebrow ? <p className={LISTING_MODAL_LABEL}>{eyebrow}</p> : null}
      <div className={`flex items-start gap-3 ${eyebrow ? "mt-1" : ""}`}>
        {icon ? (
          <span className="text-2xl leading-none" aria-hidden>
            {icon}
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <h2 className="pr-8 text-xl font-bold tracking-tight text-foreground sm:text-2xl">{title}</h2>
          {subtitle ? <p className="mt-1 text-sm leading-relaxed text-muted">{subtitle}</p> : null}
        </div>
      </div>
    </header>
  );
}

function ListingModalSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className={LISTING_MODAL_CARD}>
      <p className={LISTING_MODAL_LABEL}>{label}</p>
      <div className="mt-2 text-sm leading-relaxed text-foreground">{children}</div>
    </section>
  );
}

function truncateModalText(text: string | undefined, max = 100): string {
  const t = text?.trim();
  if (!t) return "—";
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function ListingModalStatGrid({ items, columns }: { items: { label: string; value: React.ReactNode }[]; columns?: 2 }) {
  const colClass =
    columns === 2
      ? "grid-cols-2"
      : items.length >= 5
        ? "sm:grid-cols-2 lg:grid-cols-3"
        : items.length >= 3
          ? "sm:grid-cols-3"
          : "sm:grid-cols-2";
  return (
    <div className={`grid gap-3 ${colClass}`}>
      {items.map((item) => (
        <div key={item.label} className={LISTING_MODAL_CARD}>
          <p className={LISTING_MODAL_LABEL}>{item.label}</p>
          <div className="mt-2 text-xs font-medium leading-snug text-foreground sm:text-sm [&_*]:break-words">{item.value}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * The room's rent for the detail modal, in the SAME format as
 * `roomHeadlinePriceLabel` ("$1,200/mo", "$40.50/day"). It reads the exact
 * `priceHeadlineAmount` the row already carries — never re-parsing the display
 * `price` string, whose monthly form differs per builder — and returns null when
 * the row carries no headline number, leaving the decision to
 * `roomRentFallbackLabel`.
 */
function roomRentLabel(room: ListingRoomRow): string | null {
  const amount = room.priceHeadlineAmount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return null;
  return `${formatRoomPriceAmount(amount)}${room.pricePeriod === "day" ? "/day" : room.pricePeriod === "week" ? "/week" : "/mo"}`;
}

/**
 * The row's own display price, shown verbatim whenever there is no headline
 * number to format. Both an entire-home room's descriptive label ("Included")
 * and a builder that ships only a pre-formatted string (the generic fallback
 * content's "$775/month") land here, so the modal can never disagree with the
 * room row rendered from the same data on the same page.
 *
 * Returns null only when the label carries no meaningful price — blank, "—", or
 * one whose every number is zero ("$0", "$0.00", "$0/mo") — so the card shows
 * its empty state rather than printing "$0" as a rent.
 */
function roomRentFallbackLabel(room: ListingRoomRow): string | null {
  const raw = room.price?.trim();
  if (!raw || raw === "—") return null;
  const numbers = raw.match(/\d+(?:[.,]\d+)*/g);
  if (numbers && !numbers.some((n) => Number.parseFloat(n.replace(/,/g, "")) > 0)) return null;
  return raw;
}

function ListingModalTags({ tags }: { tags: readonly string[] }) {
  if (tags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {tags.map((t) => (
        <span key={t} className="rounded-full border border-border bg-accent/40 px-3 py-1 text-xs font-medium text-foreground">
          {t}
        </span>
      ))}
    </div>
  );
}

function ListingModalMedia({ photoUrls, videoSrc }: { photoUrls?: string[]; videoSrc?: string | null }) {
  const photos = photoUrls?.filter(Boolean) ?? [];
  const video = videoSrc?.trim() || null;
  if (photos.length === 0 && !video) {
    return (
      <div className="relative h-[120px] w-full overflow-hidden rounded-xl border border-border">
        <NoImagePlaceholder variant="compact" />
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {photos.length > 0 ? <PhotoStrip imageUrls={photos} /> : null}
      {video ? (
        <video src={video} controls playsInline autoPlay muted loop className={`${LISTING_MODAL_MEDIA_FRAME} w-full bg-black object-cover`} />
      ) : null}
    </div>
  );
}

function ListingModalCta({
  href,
  label,
  variant,
  dataAttr,
  newTabProps,
  onClick,
}: {
  href: string;
  label: string;
  variant: "primary" | "secondary";
  dataAttr?: string;
  newTabProps: ReturnType<typeof listingLinkTargetProps>;
  onClick?: () => void;
}) {
  const className =
    variant === "primary"
      ? "flex min-h-[48px] w-full items-center justify-center rounded-full bg-primary py-3 text-sm font-semibold text-white shadow-[0_4px_20px_rgba(47,107,255,0.28)] transition hover:opacity-95"
      : "flex min-h-[48px] w-full items-center justify-center rounded-full border border-border bg-card py-3 text-sm font-semibold text-foreground transition hover:bg-accent/30";
  // sms: must use a plain anchor — Next Link treats it as an app route.
  if (href.startsWith("sms:")) {
    return (
      <a href={href} className="flex-1" data-attr={dataAttr}>
        <span className={className}>{label}</span>
      </a>
    );
  }
  return (
    <Link href={href} className="flex-1" data-attr={dataAttr} onClick={onClick} {...newTabProps}>
      <span className={className}>{label}</span>
    </Link>
  );
}

function ListingModalActions({
  primary,
  secondary,
  newTabProps,
}: {
  primary: { href: string; label: string; dataAttr?: string; onClick?: () => void };
  secondary: { href: string; label: string; dataAttr?: string; onClick?: () => void };
  newTabProps: ReturnType<typeof listingLinkTargetProps>;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <ListingModalCta
        href={primary.href}
        label={primary.label}
        variant="primary"
        dataAttr={primary.dataAttr}
        newTabProps={newTabProps}
        onClick={primary.onClick}
      />
      <ListingModalCta
        href={secondary.href}
        label={secondary.label}
        variant="secondary"
        dataAttr={secondary.dataAttr}
        newTabProps={newTabProps}
        onClick={secondary.onClick}
      />
    </div>
  );
}

/** Hides renter apply/message CTAs when sidebar (or preview) already covers them. */
function PreviewSafeModalActions(props: Parameters<typeof ListingModalActions>[0]) {
  const previewBrowse = useListingPreviewNewTab();
  const sidebarRenterCtas = useListingSidebarRenterCtas();
  if (previewBrowse || sidebarRenterCtas) return null;
  return <ListingModalActions {...props} />;
}

function PhotoStrip({ captions, imageUrls }: { captions?: string[]; imageUrls?: string[] }) {
  const imgs = imageUrls?.filter(Boolean) ?? [];
  if (imgs.length > 0) {
    // A strip, not a stack: the first photo large, the rest as tiles beside it,
    // so the facts under it are one scroll away instead of six.
    return (
      <div className={`grid gap-2 ${imgs.length === 1 ? "grid-cols-1" : "grid-cols-[2fr_1fr]"}`}>
        {imgs.slice(0, 5).map((src, i) => (
          <div
            key={`${src.slice(0, 48)}-${i}`}
            className={`relative overflow-hidden rounded-lg bg-accent/30 ${i === 0 ? "row-span-2 aspect-[4/3]" : "aspect-[4/3]"} ${
              imgs.length === 2 && i === 1 ? "row-span-2" : ""
            }`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt="" className="absolute inset-0 h-full w-full object-cover object-center" />
            {i === 4 && imgs.length > 5 ? (
              <span className="absolute inset-0 flex items-center justify-center bg-black/45 text-sm font-bold text-white">
                +{imgs.length - 5}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    );
  }
  const caps = captions ?? [];
  if (caps.length === 0) return null;
  return (
    <div className={`${LISTING_MODAL_MEDIA_WRAP} space-y-3`}>
      {caps.map((cap) => (
        <div
          key={cap}
          className={`${LISTING_MODAL_MEDIA_FRAME} flex flex-col items-center justify-center border border-dashed border-border bg-accent/25 p-4 text-center`}
        >
          <p className="text-sm font-semibold text-foreground">{cap}</p>
        </div>
      ))}
    </div>
  );
}

type ModalState =
  | { kind: "room"; room: ListingRoomRow; floorLabel: string }
  | { kind: "floorPlan"; floor: ListingFloorCard }
  | { kind: "bathroom"; row: ListingBathroomRow }
  | { kind: "shared"; row: ListingSharedRow }
  | { kind: "lease"; row: LeaseBasicRow }
  | { kind: "bundle"; row: BundleCard }
  | { kind: "amenity"; row: AmenityItem }
  | null;

export function ListingDetailModal({
  state,
  onClose,
  listingPropertyId,
  propertyLabel = null,
  contactSmsPhone = null,
}: {
  state: ModalState;
  onClose: () => void;
  listingPropertyId: string;
  propertyLabel?: string | null;
  contactSmsPhone?: string | null;
}) {
  const stop = useCallback((e: React.MouseEvent) => e.stopPropagation(), []);
  const isClient = useIsClient();
  const newTabProps = listingLinkTargetProps(useListingPreviewNewTab());
  const textEnabled = isClawMessagingPubliclyEnabled(contactSmsPhone);
  const label = propertyLabel?.trim() || null;
  const { applyHref: webApplyHref, messageHref: webMessageHref, tourHref, stageMessageCompose } =
    useProspectListingHrefs(listingPropertyId);
  const textApplyHref = textEnabled
    ? buildSmsDeepLink({ intent: "apply", propertyId: listingPropertyId, propertyLabel: label, toPhone: contactSmsPhone })
    : webApplyHref;
  const textMessageHref = textEnabled
    ? buildSmsDeepLink({ intent: "question", propertyId: listingPropertyId, propertyLabel: label, toPhone: contactSmsPhone })
    : webMessageHref;
  const textMessageAbout = (topic: string) =>
    textEnabled
      ? buildSmsDeepLink({ intent: "question", propertyId: listingPropertyId, propertyLabel: label, topic, toPhone: contactSmsPhone })
      : webMessageHref;
  const applyLabel = listingApplyLabel(textEnabled);
  const messageLabel = listingMessageLabel(textEnabled);
  const stageWebMessageCompose = textEnabled ? undefined : stageMessageCompose;
  const messageCtaExtras = { onClick: stageWebMessageCompose };

  useEffect(() => {
    if (!state) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [state]);

  if (!state) return null;
  if (!isClient || typeof document === "undefined") return null;

  const panel = (
    <div className="fixed inset-0 z-[240] flex items-end justify-center p-3 sm:items-center sm:p-6" role="dialog" aria-modal>
      <button type="button" className="absolute inset-0 modal-overlay" onClick={onClose} aria-label="Close dialog" />
      <div
        className="modal-panel relative z-10 flex max-h-[min(92vh,820px)] w-full max-w-lg flex-col overflow-hidden rounded-3xl border border-border shadow-2xl sm:max-w-2xl"
        onClick={stop}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 z-20 flex h-9 w-9 items-center justify-center rounded-full bg-card text-lg text-muted shadow-sm ring-1 ring-border transition hover:bg-accent/30"
          aria-label="Close"
        >
          ×
        </button>

        {state.kind === "room" ? (
          <ListingModalBody
            footer={
              // One action per sheet (PLAN-0914-2124): the tour is room-specific;
              // Apply already sits in the page's own card / sticky bar.
              <ListingModalCta
                href={tourHref}
                label="Schedule tour"
                variant="primary"
                dataAttr="listing-room-tour"
                newTabProps={newTabProps}
              />
            }
          >
            {(() => {
              const roomChoiceValue = `${listingPropertyId}${LISTING_ROOM_CHOICE_SEP}${state.room.id}`;
              const roomUnavailableWindows = getRoomUnavailabilityWindows(roomChoiceValue);
              return (
                <>
                  <ListingModalHeader title={state.room.name} />
                  <ListingModalMedia photoUrls={state.room.modal.photoUrls} videoSrc={state.room.modal.videoSrc} />
                  <ListingModalStatGrid
                    columns={2}
                    items={[
                      {
                        // Rent leads the grid, and is the one stat rendered at
                        // headline size: it is the number a renter came for, and
                        // the utilities estimate sitting beside it reads as the
                        // price of the room when nothing outranks it.
                        label: "Rent",
                        value: (() => {
                          const rent = roomRentLabel(state.room);
                          if (rent) {
                            return (
                              <span className="text-base font-bold tabular-nums text-foreground sm:text-lg">
                                {rent}
                              </span>
                            );
                          }
                          const fallback = roomRentFallbackLabel(state.room);
                          if (fallback) {
                            return <span className="text-sm font-semibold text-foreground">{fallback}</span>;
                          }
                          return <span className="text-sm font-semibold text-muted">Not set</span>;
                        })(),
                      },
                      {
                        label: "Floor",
                        value: state.room.modal.floorLine?.trim() || state.floorLabel || "—",
                      },
                      {
                        label: "Bathroom",
                        value:
                          (state.room.modal.bathroomAccessLines?.length ?? 0) > 0 ? (
                            <ul className="space-y-1">
                              {state.room.modal.bathroomAccessLines!.map((line) => (
                                <li key={line} className="font-semibold text-foreground">
                                  {line}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            state.room.modal.bathroomShortLabel?.trim() || "—"
                          ),
                      },
                      ...(state.room.utilitiesEstimate
                        ? [{ label: "Utilities", value: state.room.utilitiesEstimate }]
                        : []),
                      {
                        label: "Status",
                        value: <AvailabilityPill text={state.room.availability} variant="room" />,
                      },
                      ...(state.room.modal.roomNotes?.trim()
                        ? [
                            {
                              label: "Details",
                              value: (
                                <p className="line-clamp-4 whitespace-pre-wrap text-sm leading-relaxed">
                                  {truncateModalText(state.room.modal.roomNotes, 160)}
                                </p>
                              ),
                            },
                          ]
                        : []),
                    ]}
                  />
                  {(() => {
                    const bathTagPattern = /^(private|shared|house hall)\s+bath$/i;
                    const highlightTags = state.room.modal.includedTags.filter((t) => !bathTagPattern.test(t));
                    const furnishingLine = state.room.modal.furnishingDetail?.trim();
                    const amenityLabels = state.room.modal.roomAmenityLabels ?? [];
                    const tags = [...highlightTags, ...amenityLabels.filter((t) => !highlightTags.includes(t))];
                    return (
                      <>
                        {tags.length > 0 ? (
                          <ListingModalSection label="Included">
                            <ListingModalTags tags={tags} />
                            {furnishingLine ? <p className="mt-3 text-muted">{furnishingLine}</p> : null}
                          </ListingModalSection>
                        ) : furnishingLine ? (
                          <ListingModalSection label="Included">
                            <p className="text-muted">{furnishingLine}</p>
                          </ListingModalSection>
                        ) : null}
                      </>
                    );
                  })()}
                  <ListingModalSection label="Availability timeline">
                    {roomUnavailableWindows.length > 0 ? (
                      <div className="space-y-2">
                        {roomUnavailableWindows.map((w) => (
                          <div
                            key={w.id}
                            className="flex items-start gap-2 rounded-lg border border-border bg-accent/30 px-3 py-2 text-xs text-muted"
                          >
                            <span
                              className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${w.source === "resident" ? "bg-rose-500" : "bg-sky-500"}`}
                            />
                            <span>{rangeSummaryLabel(w)}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-emerald-800 [html[data-theme=dark]_&]:text-emerald-300">
                        No blocked ranges or resident occupancy currently set for this room.
                      </p>
                    )}
                    <div className={roomUnavailableWindows.length > 0 ? "mt-4" : "mt-3"}>
                      <RoomAvailabilityTimelineCalendar windows={roomUnavailableWindows} />
                    </div>
                  </ListingModalSection>
                </>
              );
            })()}
          </ListingModalBody>
        ) : null}

        {state.kind === "floorPlan" ? (
          <ListingModalBody
            footer={
              <PreviewSafeModalActions
                newTabProps={newTabProps}
                primary={{
                  href: textMessageAbout("the floor plan / layout"),
                  label: messageLabel,
                  dataAttr: "listing-text-message-layout",
                  ...messageCtaExtras,
                }}
                secondary={{
                  href: textApplyHref,
                  label: applyLabel,
                  dataAttr: "listing-text-apply",
                }}
              />
            }
          >
            <ListingModalHeader eyebrow="Floor plan" title={state.floor.floorLabel} />
            <ListingModalSection label="Layout">
              <div className={LISTING_MODAL_MEDIA_WRAP}>
                {state.floor.floorPlanImageUrl ? (
                  <div className={`${LISTING_MODAL_MEDIA_FRAME} bg-accent/30`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={state.floor.floorPlanImageUrl}
                      alt={`Floor plan for ${state.floor.floorLabel}`}
                      className="h-full w-full object-contain object-center"
                    />
                  </div>
                ) : (
                  <div
                    className={`${LISTING_MODAL_MEDIA_FRAME} flex flex-col items-center justify-center border border-dashed border-border bg-accent/20 px-4 text-center`}
                  >
                    <p className="text-sm font-semibold text-foreground">No floor plan submitted yet</p>
                    <p className="mt-1 max-w-sm text-xs text-muted">
                      The property manager has not uploaded a floor plan for this level. Ask leasing for layout details.
                    </p>
                  </div>
                )}
              </div>
            </ListingModalSection>
          </ListingModalBody>
        ) : null}

        {state.kind === "bathroom" ? (
          <ListingModalBody
            footer={
              <PreviewSafeModalActions
                newTabProps={newTabProps}
                primary={{
                  href: textMessageAbout("this bathroom"),
                  label: messageLabel,
                  dataAttr: "listing-text-message-bathroom",
                  ...messageCtaExtras,
                }}
                secondary={{
                  href: textApplyHref,
                  label: applyLabel,
                  dataAttr: "listing-text-apply",
                }}
              />
            }
          >
            <ListingModalHeader title={state.row.name} />
            <ListingModalMedia photoUrls={state.row.modal.photoUrls} videoSrc={state.row.modal.videoSrc} />
            <ListingModalStatGrid
              columns={2}
              items={[
                ...(state.row.detail && state.row.detail !== "—" ? [{ label: "Where", value: state.row.detail }] : []),
                {
                  label: "Used by",
                  value:
                    state.row.modal.usedByRoomNames.length > 0
                      ? state.row.modal.usedByRoomNames.join(", ")
                      : state.row.modal.setupCard || "—",
                },
                {
                  label: "Fixtures",
                  value: [state.row.shower ? "Shower" : null, state.row.bathtub ? "Tub" : null, state.row.toilet ? "Toilet" : null]
                    .filter(Boolean)
                    .join(" · ") || "—",
                },
              ]}
            />
            {state.row.modal.includedTags.length > 0 ? (
              <ListingModalSection label="Included">
                <ListingModalTags tags={state.row.modal.includedTags} />
              </ListingModalSection>
            ) : null}
          </ListingModalBody>
        ) : null}

        {state.kind === "shared" ? (
          <ListingModalBody
            footer={
              <PreviewSafeModalActions
                newTabProps={newTabProps}
                primary={{
                  href: textApplyHref,
                  label: applyLabel,
                  dataAttr: "listing-text-apply",
                }}
                secondary={{
                  href: textMessageHref,
                  label: messageLabel,
                  dataAttr: "listing-text-message",
                  ...messageCtaExtras,
                }}
              />
            }
          >
            <ListingModalHeader title={state.row.name} />
            <ListingModalMedia photoUrls={state.row.modal.photoUrls} videoSrc={state.row.modal.videoSrc} />
            <ListingModalStatGrid
              columns={2}
              items={[
                ...(state.row.detail && state.row.detail !== "—" ? [{ label: "Where", value: state.row.detail }] : []),
                ...(state.row.useNote?.trim() ? [{ label: "Use", value: state.row.useNote }] : []),
                ...(state.row.availability && state.row.availability !== "—"
                  ? [{ label: "Access", value: state.row.availability }]
                  : []),
              ]}
            />
            {state.row.modal.includedTags.length > 0 ? (
              <ListingModalSection label="Included">
                <ListingModalTags tags={state.row.modal.includedTags} />
              </ListingModalSection>
            ) : null}
          </ListingModalBody>
        ) : null}

        {state.kind === "lease" ? (
          <ListingModalBody
            footer={
              <PreviewSafeModalActions
                newTabProps={newTabProps}
                primary={{
                  href: textApplyHref,
                  label: applyLabel,
                  dataAttr: "listing-text-apply",
                }}
                secondary={{
                  href: textMessageAbout("lease terms"),
                  label: messageLabel,
                  dataAttr: "listing-text-message-lease",
                  ...messageCtaExtras,
                }}
              />
            }
          >
            <ListingModalHeader
              eyebrow="Lease"
              icon={state.row.icon}
              title={state.row.title}
              subtitle={state.row.detail}
            />
            <ListingModalStatGrid
              items={[
                { label: "Amount / rate", value: state.row.price },
                { label: "Timing", value: <AvailabilityPill text={state.row.status} /> },
              ]}
            />
            <ListingModalSection label="Details">
              <p className="text-muted">{state.row.body}</p>
            </ListingModalSection>
          </ListingModalBody>
        ) : null}

        {state.kind === "bundle" ? (
          <ListingModalBody
            footer={
              <PreviewSafeModalActions
                newTabProps={newTabProps}
                primary={{
                  href: textEnabled
                    ? buildSmsDeepLink({
                        intent: "bundle",
                        propertyId: listingPropertyId,
                        propertyLabel: label,
                        bundleId: state.row.id,
                        bundleLabel: state.row.label,
                        toPhone: contactSmsPhone,
                      })
                    : textApplyHref,
                  label: textEnabled ? "Text for bundle" : "Apply online",
                  dataAttr: "listing-text-bundle",
                }}
                secondary={{
                  href: textMessageHref,
                  label: messageLabel,
                  dataAttr: "listing-text-message",
                  ...messageCtaExtras,
                }}
              />
            }
          >
            <ListingModalHeader eyebrow="Bundle" title={state.row.label} />
            <ListingModalSection label="Monthly">
              <div className="flex flex-wrap items-baseline gap-2">
                {state.row.strikethrough ? (
                  <span className="text-sm text-muted line-through">{state.row.strikethrough}</span>
                ) : null}
                <span className="text-2xl font-bold">{state.row.price}</span>
                {state.row.promo ? <AvailabilityPill text={state.row.promo} /> : null}
              </div>
            </ListingModalSection>
            {state.row.summaryItems?.length ? (
              <ListingModalStatGrid
                items={state.row.summaryItems.map((item) => ({ label: item.label, value: item.value }))}
              />
            ) : null}
            <ListingModalSection label="Included rooms">
              {state.row.roomLines?.length ? (
                <div className="grid gap-2">
                  {state.row.roomLines.map((line) => (
                    <div key={line} className="rounded-lg border border-border bg-accent/30 px-3 py-2">
                      {line}
                    </div>
                  ))}
                </div>
              ) : (
                <p>{state.row.roomsLine}</p>
              )}
            </ListingModalSection>
            <p className="text-xs text-muted">Confirm availability, utilities, and final rent with leasing before applying.</p>
          </ListingModalBody>
        ) : null}

        {state.kind === "amenity" ? (
          <ListingModalBody
            footer={
              <PreviewSafeModalActions
                newTabProps={newTabProps}
                primary={{
                  href: textMessageHref,
                  label: messageLabel,
                  dataAttr: "listing-text-message",
                  ...messageCtaExtras,
                }}
                secondary={{
                  href: textApplyHref,
                  label: applyLabel,
                  dataAttr: "listing-text-apply",
                }}
              />
            }
          >
            <ListingModalHeader eyebrow="Amenity" icon={state.row.icon} title={state.row.label} />
            <ListingModalSection label="About">
              <p className="text-muted">
                This feature is included with the listing as described. Confirm specifics with the leasing team before you apply.
              </p>
            </ListingModalSection>
          </ListingModalBody>
        ) : null}
      </div>
    </div>
  );

  return createPortal(panel, document.body);
}

function FloorPlanSummaryBar({
  floor,
  onOpenFloorPlan,
}: {
  floor: ListingFloorCard;
  onOpenFloorPlan: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted">{floor.floorLabel}</p>
        <p className="mt-1 text-2xl font-bold tracking-tight text-foreground">{floor.fromPrice}</p>
        {floor.remainingNote ? (
          <p className="mt-1.5 flex items-center gap-2 text-xs text-sky-700 [html[data-theme=dark]_&]:text-sky-300">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" aria-hidden />
            {floor.remainingNote}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 rounded-full border border-border bg-accent/35 px-3 py-1.5 listing-detail-surface">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">Rooms</span>
          <span className="text-sm font-bold text-foreground">{floor.roomCount}</span>
        </div>
        <DetailsButton onClick={onOpenFloorPlan} />
      </div>
    </div>
  );
}

export function InteractiveFloorPlanCard({
  floor,
  listingPropertyId,
  propertyLabel = null,
  contactSmsPhone = null,
}: {
  floor: ListingFloorCard;
  listingPropertyId: string;
  propertyLabel?: string | null;
  contactSmsPhone?: string | null;
}) {
  const [modal, setModal] = useState<ModalState>(null);

  return (
    <>
      <div className={LISTING_FLOOR_CARD}>
        <div className="px-4 py-3.5 sm:px-5">
          <FloorPlanSummaryBar floor={floor} onOpenFloorPlan={() => setModal({ kind: "floorPlan", floor })} />
        </div>
      </div>
      <ListingDetailModal
        state={modal}
        onClose={() => setModal(null)}
        listingPropertyId={listingPropertyId}
        propertyLabel={propertyLabel}
        contactSmsPhone={contactSmsPhone}
      />
    </>
  );
}

/**
 * Lease basics as a two-column ledger (PLAN-0914-2124): item on the left,
 * amount on the right, the timing pill under the amount. Each row still opens
 * its sheet for the full wording.
 */
export function LeaseBasicsTableInteractive({
  rows,
  listingPropertyId,
  propertyLabel = null,
  contactSmsPhone = null,
  showTermSections = false,
}: {
  rows: LeaseBasicRow[];
  listingPropertyId: string;
  propertyLabel?: string | null;
  contactSmsPhone?: string | null;
  /** When true, always render Long term / Short term headings (short-term may be empty). */
  showTermSections?: boolean;
}) {
  const [modal, setModal] = useState<ModalState>(null);

  const longTerm = rows.filter((r) => r.section !== "short-term");
  const shortTerm = rows.filter((r) => r.section === "short-term");
  const groups: { key: "long-term" | "short-term"; label: string; rows: LeaseBasicRow[] }[] = [];
  if (showTermSections) {
    groups.push({ key: "long-term", label: "Long term", rows: longTerm });
    groups.push({ key: "short-term", label: "Short term", rows: shortTerm });
  } else {
    if (longTerm.length) groups.push({ key: "long-term", label: "Long term", rows: longTerm });
    if (shortTerm.length) groups.push({ key: "short-term", label: "Short term", rows: shortTerm });
  }
  const showHeadings = groups.length > 1 || showTermSections;

  return (
    <>
      <div className="space-y-6">
        {groups.map((group) => (
          <div key={group.key}>
            {showHeadings ? (
              <p className="mb-2 text-[10px] font-bold uppercase tracking-[0.16em] text-muted">{group.label}</p>
            ) : null}
            {group.rows.length === 0 ? (
              <p className="py-2 text-sm text-muted">No fees listed for this term.</p>
            ) : (
              <dl className="grid gap-x-8 sm:grid-cols-2">
                {group.rows.map((r) => (
                  <div key={r.id} className="border-b border-border">
                    <button
                      type="button"
                      onClick={() => setModal({ kind: "lease", row: r })}
                      data-attr="listing-lease-row"
                      className="flex min-h-[48px] w-full items-center justify-between gap-4 py-2.5 text-left transition hover:text-primary"
                    >
                      <dt className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                        <span className="shrink-0 text-base leading-none" aria-hidden>
                          {r.icon}
                        </span>
                        <span className="min-w-0 truncate">{r.title}</span>
                      </dt>
                      <dd className="shrink-0 text-right">
                        <span className="block text-sm font-bold tabular-nums text-foreground">{r.price}</span>
                        {r.status ? <span className="block text-[11px] font-medium text-muted">{r.status}</span> : null}
                      </dd>
                    </button>
                  </div>
                ))}
              </dl>
            )}
          </div>
        ))}
      </div>
      <ListingDetailModal
        state={modal}
        onClose={() => setModal(null)}
        listingPropertyId={listingPropertyId}
        propertyLabel={propertyLabel}
        contactSmsPhone={contactSmsPhone}
      />
    </>
  );
}

function bundlePromoIsShortBadge(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return t.length <= 36 && t.split(/\s+/).length <= 5;
}

function BundlePromoLine({ promo }: { promo: string }) {
  const text = promo.trim();
  if (!text) return null;
  if (bundlePromoIsShortBadge(text)) {
    return (
      <div className="mt-2">
        <AvailabilityPill text={text} />
      </div>
    );
  }
  return <p className="mt-2 text-sm leading-relaxed text-muted">{text}</p>;
}

function BundleRoomPreview({ row }: { row: BundleCard }) {
  const roomLines = row.roomLines ?? [];
  if (roomLines.length === 0) {
    if (!row.roomsLine.trim()) return null;
    return <p className="mt-3 text-xs leading-relaxed text-muted">{row.roomsLine}</p>;
  }
  const preview = roomLines.slice(0, 4);
  const remaining = roomLines.length - preview.length;
  return (
    <div className="mt-3">
      {row.roomsLine.trim() ? (
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted">Included rooms</p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {preview.map((line) => (
          <span
            key={line}
            className="inline-flex max-w-full items-center rounded-lg border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground"
          >
            <span className="truncate">{line}</span>
          </span>
        ))}
        {remaining > 0 ? (
          <span className="inline-flex items-center rounded-lg bg-accent/30 px-2.5 py-1 text-xs font-semibold text-muted">
            +{remaining} more
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function BundleTableInteractive({
  rows,
  listingPropertyId,
  propertyLabel = null,
  contactSmsPhone = null,
}: {
  rows: BundleCard[];
  listingPropertyId: string;
  propertyLabel?: string | null;
  contactSmsPhone?: string | null;
}) {
  const [modal, setModal] = useState<ModalState>(null);

  return (
    <>
      <div className={`grid gap-4 ${rows.length >= 3 ? "xl:grid-cols-3" : ""} md:grid-cols-2`}>
        {rows.map((c) => {
          const cardClass =
            "group relative overflow-hidden rounded-2xl border border-border bg-card p-4 shadow-sm ring-1 ring-border/70 transition duration-200 sm:p-5 hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-lg hover:ring-primary/20";
          return (
            <div key={c.id} className={cardClass}>
              <div className="absolute left-0 top-0 h-full w-1 bg-gradient-to-b from-primary to-primary/40 opacity-90" aria-hidden />
              <div className="relative pl-2">
                <div className="min-w-0">
                  <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-primary">Package</p>
                  <p className="mt-1 text-lg font-bold tracking-tight text-foreground">{c.label}</p>
                  {c.promo ? <BundlePromoLine promo={c.promo} /> : null}
                  {c.roomLines?.length ? null : c.roomsLine.trim() ? (
                    <p className="mt-2 text-xs leading-snug text-muted">{c.roomsLine}</p>
                  ) : null}
                </div>
                <div className="mt-4 rounded-xl border border-border bg-accent/25 p-3">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-muted">Monthly</p>
                  <div className="mt-1 flex flex-wrap items-baseline gap-2">
                    {c.strikethrough ? <span className="text-sm text-muted line-through">{c.strikethrough}</span> : null}
                    <span className="text-2xl font-bold tabular-nums tracking-tight text-foreground">{c.price}</span>
                  </div>
                </div>
                {c.summaryItems && c.summaryItems.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {c.summaryItems.slice(0, 4).map((item) => (
                      <span
                        key={`${c.id}-${item.label}`}
                        className="inline-flex items-center rounded-full border border-border bg-accent/35 px-2.5 py-1 text-[10px] font-semibold text-foreground"
                      >
                        <span className="text-muted">{item.label}:</span>
                        <span className="ml-1 text-foreground">{item.value}</span>
                      </span>
                    ))}
                  </div>
                ) : null}
                <BundleRoomPreview row={c} />
                <DetailsButton className="mt-4 w-full" onClick={() => setModal({ kind: "bundle", row: c })} />
              </div>
            </div>
          );
        })}
      </div>
      <ListingDetailModal
        state={modal}
        onClose={() => setModal(null)}
        listingPropertyId={listingPropertyId}
        propertyLabel={propertyLabel}
        contactSmsPhone={contactSmsPhone}
      />
    </>
  );
}

const AMENITIES_PREVIEW_COUNT = 8;

/**
 * Amenities as the two-column icon list every rental marketplace settled on
 * (PLAN-0914-2124): the first eight, then "Show all N amenities". The old
 * per-row Details button and its filler sheet are gone — an amenity is a fact,
 * not a record.
 */
export function AmenitiesTableInteractive({
  rows,
}: {
  rows: AmenityItem[];
  listingPropertyId?: string;
  propertyLabel?: string | null;
  contactSmsPhone?: string | null;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? rows : rows.slice(0, AMENITIES_PREVIEW_COUNT);
  const hidden = rows.length - visible.length;
  if (rows.length === 0) return null;
  return (
    <div>
      <ul className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
        {visible.map((a) => (
          <li key={a.id} className="flex min-w-0 items-center gap-3 text-sm text-foreground">
            <span className="w-6 shrink-0 text-center text-base leading-none" aria-hidden>
              {a.icon}
            </span>
            <span className="min-w-0 font-medium">{a.label}</span>
          </li>
        ))}
      </ul>
      {rows.length > AMENITIES_PREVIEW_COUNT ? (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          data-attr="listing-amenities-show-all"
          aria-expanded={showAll}
          className={`${LISTING_DETAIL_BUTTON} mt-4 !text-xs`}
        >
          {showAll ? "Show fewer amenities" : `Show all ${rows.length} amenities`}
          {!showAll && hidden > 0 ? null : null}
        </button>
      ) : null}
    </div>
  );
}


/* ------------------------------------------------------------------ */
/* Rooms · Bathrooms · Shared spaces (PLAN-0914-2124)                    */
/* ------------------------------------------------------------------ */

/**
 * A row's own photo: its first uploaded slide with a count badge, or the
 * compact neutral tile when it has none. Never a stock image.
 */
export function ListingThumb({
  urls,
  className = "h-12 w-16",
}: {
  urls?: string[] | null;
  className?: string;
}) {
  const list = urls?.filter(Boolean) ?? [];
  const first = list[0];
  return (
    <span className={`relative block shrink-0 overflow-hidden rounded-lg border border-border bg-accent/25 ${className}`}>
      {first ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={first} alt="" className="absolute inset-0 h-full w-full object-cover" />
          {list.length > 1 ? (
            <span className="absolute bottom-1 right-1 rounded-full bg-black/70 px-1.5 text-[10px] font-bold leading-4 text-white tabular-nums">
              {list.length}
            </span>
          ) : null}
        </>
      ) : (
        <NoImagePlaceholder variant="compact" label="" />
      )}
    </span>
  );
}

const SPACE_TABLE_WRAP = "hidden overflow-hidden rounded-xl border border-border bg-card listing-detail-surface md:block";
const SPACE_TABLE = "w-full text-sm";
const SPACE_TH = `${LISTING_TABLE_HEAD} bg-[var(--pl-surface-muted)] px-3 py-2 text-left font-semibold`;
const SPACE_TD = "border-t border-border px-3 py-2.5 align-middle";
const SPACE_ROWS_MOBILE = "md:hidden";
const SPACE_ROW_MOBILE =
  "flex min-h-[64px] w-full items-center gap-3 py-2.5 text-left transition [&+&]:border-t [&+&]:border-border";
const SPACE_SUBHEAD = "mb-3 mt-7 flex items-center gap-2 text-base font-bold tracking-tight text-foreground";

function roomBathLabel(room: ListingRoomRow): string {
  const short = room.modal.bathroomShortLabel?.trim();
  if (short) return short.replace(/\s*bathroom$/i, " bath");
  const n = room.bathroomShareCount;
  if (n === 1) return "Private bath";
  if (typeof n === "number" && n > 1) return `Shared · ${n}`;
  return "—";
}

function roomRentCell(room: ListingRoomRow): string {
  return roomRentLabel(room) ?? roomRentFallbackLabel(room) ?? "—";
}

function bathroomFixtures(row: ListingBathroomRow): string {
  const parts: string[] = [];
  if (row.shower) parts.push("Shower");
  if (row.bathtub) parts.push("Tub");
  if (row.toilet) parts.push("Toilet");
  return parts.join(" · ") || "—";
}

function bathroomUsedBy(row: ListingBathroomRow): string {
  const names = row.modal.usedByRoomNames;
  if (names.length > 0) return names.join(", ");
  return row.usedByLabel?.trim() || row.detail?.trim() || "—";
}

/**
 * The rooms table, then bathrooms, then shared spaces — every row ends in ONE
 * Details button (on a phone the whole row is the button) that opens that
 * item's own sheet. No per-row apply or tour buttons: those live once, in the
 * page's card / sticky bar.
 */
export function SpacesInteractive({
  floorPlans,
  bathrooms,
  sharedSpaces,
  listingPropertyId,
  propertyLabel = null,
  contactSmsPhone = null,
}: {
  floorPlans: ListingFloorCard[];
  bathrooms: ListingBathroomRow[];
  sharedSpaces: ListingSharedRow[];
  listingPropertyId: string;
  propertyLabel?: string | null;
  contactSmsPhone?: string | null;
}) {
  const [modal, setModal] = useState<ModalState>(null);
  const rooms = floorPlans.flatMap((f) => f.rooms.map((room) => ({ room, floorLabel: f.floorLabel })));
  // The builder's placeholder rows are words, not records: no thumb, no Details.
  const realBathrooms = bathrooms.filter((b) => !isListingFallbackBathroom(b));
  const realShared = sharedSpaces.filter((r) => !isListingPlaceholderSharedSpace(r));
  const bathroomsListed = realBathrooms.length > 0;
  if (rooms.length === 0 && !bathroomsListed && realShared.length === 0) return null;

  return (
    <>
      {rooms.length > 0 ? (
        <>
          <div className={SPACE_TABLE_WRAP}>
            <table className={SPACE_TABLE}>
              <thead>
                <tr>
                  <th className={`${SPACE_TH} w-[84px]`}>
                    <span className="sr-only">Photo</span>
                  </th>
                  <th className={SPACE_TH}>Room</th>
                  <th className={SPACE_TH}>Floor</th>
                  <th className={SPACE_TH}>Bath</th>
                  <th className={SPACE_TH}>Available</th>
                  <th className={`${SPACE_TH} text-right`}>Rent</th>
                  <th className={SPACE_TH}>
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rooms.map(({ room, floorLabel }) => (
                  <tr key={room.id}>
                    <td className={SPACE_TD}>
                      <ListingThumb urls={room.modal.photoUrls} className="h-[54px] w-[72px]" />
                    </td>
                    <td className={`${SPACE_TD} font-bold text-foreground`}>{room.name}</td>
                    <td className={`${SPACE_TD} whitespace-nowrap text-muted`}>{floorLabel}</td>
                    <td className={`${SPACE_TD} whitespace-nowrap text-muted`}>{roomBathLabel(room)}</td>
                    <td className={SPACE_TD}>
                      <AvailabilityPill text={room.availability} variant="room" />
                    </td>
                    <td className={`${SPACE_TD} whitespace-nowrap text-right font-bold tabular-nums text-foreground`}>
                      {roomRentCell(room)}
                    </td>
                    <td className={`${SPACE_TD} text-right`}>
                      <button
                        type="button"
                        data-attr="listing-room-details"
                        onClick={() => setModal({ kind: "room", room, floorLabel })}
                        className={`${LISTING_DETAIL_BUTTON} !text-xs`}
                      >
                        Details
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={SPACE_ROWS_MOBILE}>
            {rooms.map(({ room, floorLabel }) => (
              <button
                key={room.id}
                type="button"
                data-attr="listing-room-details"
                onClick={() => setModal({ kind: "room", room, floorLabel })}
                className={SPACE_ROW_MOBILE}
              >
                <ListingThumb urls={room.modal.photoUrls} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-bold text-foreground">{room.name}</span>
                  <span className="block truncate text-xs text-muted">
                    {floorLabel} · {roomBathLabel(room)}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-sm font-bold tabular-nums text-foreground">{roomRentCell(room)}</span>
                  <span className={`block text-[11px] font-semibold ${roomAvailabilityTextClasses(roomAvailabilityTone(room.availability))}`}>
                    {room.availability}
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
              </button>
            ))}
          </div>
        </>
      ) : null}

      {!bathroomsListed ? (
        <>
          <h3 className={SPACE_SUBHEAD} id="listing-bathrooms">
            Bathrooms
          </h3>
          <p className="text-sm text-muted">No bathrooms listed yet.</p>
        </>
      ) : null}
      {bathroomsListed ? (
        <>
          <h3 className={SPACE_SUBHEAD} id="listing-bathrooms">
            Bathrooms
            <span className="rounded-full border border-border bg-accent/35 px-2.5 py-0.5 text-xs font-semibold text-foreground listing-detail-surface">
              {realBathrooms.length}
            </span>
          </h3>
          <div className={SPACE_TABLE_WRAP}>
            <table className={SPACE_TABLE}>
              <thead>
                <tr>
                  <th className={`${SPACE_TH} w-[84px]`}>
                    <span className="sr-only">Photo</span>
                  </th>
                  <th className={SPACE_TH}>Bathroom</th>
                  <th className={SPACE_TH}>Used by</th>
                  <th className={SPACE_TH}>Fixtures</th>
                  <th className={SPACE_TH}>
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {realBathrooms.map((row) => (
                  <tr key={row.id}>
                    <td className={SPACE_TD}>
                      <ListingThumb urls={row.modal.photoUrls} className="h-[54px] w-[72px]" />
                    </td>
                    <td className={`${SPACE_TD} font-bold text-foreground`}>
                      {row.name}
                      {row.detail && row.detail !== "—" ? (
                        <span className="font-medium text-muted"> · {row.detail}</span>
                      ) : null}
                    </td>
                    <td className={`${SPACE_TD} text-muted`}>{bathroomUsedBy(row)}</td>
                    <td className={`${SPACE_TD} whitespace-nowrap text-muted`}>{bathroomFixtures(row)}</td>
                    <td className={`${SPACE_TD} text-right`}>
                      <button
                        type="button"
                        data-attr="listing-bath-details"
                        onClick={() => setModal({ kind: "bathroom", row })}
                        className={`${LISTING_DETAIL_BUTTON} !text-xs`}
                      >
                        Details
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={SPACE_ROWS_MOBILE}>
            {realBathrooms.map((row) => (
              <button
                key={row.id}
                type="button"
                data-attr="listing-bath-details"
                onClick={() => setModal({ kind: "bathroom", row })}
                className={SPACE_ROW_MOBILE}
              >
                <ListingThumb urls={row.modal.photoUrls} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-bold text-foreground">{row.name}</span>
                  <span className="block truncate text-xs text-muted">
                    {bathroomUsedBy(row)} · {bathroomFixtures(row)}
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
              </button>
            ))}
          </div>
        </>
      ) : null}

      {realShared.length > 0 ? (
        <>
          <h3 className={SPACE_SUBHEAD} id="listing-shared">
            Shared spaces
            <span className="rounded-full border border-border bg-accent/35 px-2.5 py-0.5 text-xs font-semibold text-foreground listing-detail-surface">
              {realShared.length}
            </span>
          </h3>
          <div className={SPACE_TABLE_WRAP}>
            <table className={SPACE_TABLE}>
              <thead>
                <tr>
                  <th className={`${SPACE_TH} w-[84px]`}>
                    <span className="sr-only">Photo</span>
                  </th>
                  <th className={SPACE_TH}>Space</th>
                  <th className={SPACE_TH}>Where</th>
                  <th className={SPACE_TH}>Use</th>
                  <th className={SPACE_TH}>
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {realShared.map((row) => (
                  <tr key={row.id}>
                    <td className={SPACE_TD}>
                      <ListingThumb urls={row.modal.photoUrls} className="h-[54px] w-[72px]" />
                    </td>
                    <td className={`${SPACE_TD} font-bold text-foreground`}>{row.name}</td>
                    <td className={`${SPACE_TD} text-muted`}>{row.detail && row.detail !== "—" ? row.detail : "—"}</td>
                    <td className={`${SPACE_TD} text-muted`}>{row.useNote?.trim() || row.availability || "—"}</td>
                    <td className={`${SPACE_TD} text-right`}>
                      <button
                        type="button"
                        data-attr="listing-shared-details"
                        onClick={() => setModal({ kind: "shared", row })}
                        className={`${LISTING_DETAIL_BUTTON} !text-xs`}
                      >
                        Details
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={SPACE_ROWS_MOBILE}>
            {realShared.map((row) => (
              <button
                key={row.id}
                type="button"
                data-attr="listing-shared-details"
                onClick={() => setModal({ kind: "shared", row })}
                className={SPACE_ROW_MOBILE}
              >
                <ListingThumb urls={row.modal.photoUrls} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-bold text-foreground">{row.name}</span>
                  <span className="block truncate text-xs text-muted">
                    {[row.detail !== "—" ? row.detail : null, row.useNote?.trim() || null].filter(Boolean).join(" · ") || row.availability}
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />
              </button>
            ))}
          </div>
        </>
      ) : null}

      <ListingDetailModal
        state={modal}
        onClose={() => setModal(null)}
        listingPropertyId={listingPropertyId}
        propertyLabel={propertyLabel}
        contactSmsPhone={contactSmsPhone}
      />
    </>
  );
}
