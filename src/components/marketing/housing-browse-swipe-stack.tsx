"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { demoOnlyBrowseCardPlaceholderImage, type PropertyBrowseCard } from "@/lib/room-listings-catalog";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { formatRoomPriceAmount } from "@/lib/room-pricing";
import { HousingBrowseCardOverlay } from "@/components/marketing/housing-browse-card-overlay";
import { NoImagePlaceholder } from "@/components/ui/no-image-placeholder";

const SWIPE_THRESHOLD_PX = 72;
const TAP_THRESHOLD_PX = 12;
const EXIT_ANIM_MS = 280;

function formatRent(card: PropertyBrowseCard): string {
  const display = card.headlineRent ?? card.rentNumeric;
  if (display !== null) {
    return formatRoomPriceAmount(display);
  }
  const stripped = card.priceLabel.replace(/\/month/i, "").replace(/\/day/i, "").trim();
  return stripped || "—";
}

function SwipeCardFace({
  card,
  style,
  asPeek = false,
}: {
  card: PropertyBrowseCard;
  style?: CSSProperties;
  /** The card stacked behind the active one — render bare (no badge/overlay) so its text/badge doesn't ghost through. */
  asPeek?: boolean;
}) {
  const rent = formatRent(card);
  const resolvedImageUrl =
    card.imageUrl || (isDemoModeActive() ? demoOnlyBrowseCardPlaceholderImage(card.propertyId) : "");
  const isDataUrl = resolvedImageUrl.startsWith("data:");
  const hasPhoto = Boolean(resolvedImageUrl);

  return (
    <div
      className="relative h-full w-full overflow-hidden rounded-3xl bg-accent/20 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.55)] ring-1 ring-border/40"
      style={style}
    >
      <div className="relative h-full w-full overflow-hidden">
        {hasPhoto ? (
          <Image
            src={resolvedImageUrl}
            alt=""
            fill
            className="object-cover"
            sizes="(max-width: 1024px) 92vw, 400px"
            unoptimized={isDataUrl}
            draggable={false}
          />
        ) : asPeek ? (
          // Bare branded wash — no icon/label, so the stacked peek card never ghosts text through the active card.
          <div
            className="absolute inset-0 bg-gradient-to-br from-accent/25 via-accent/15 to-primary/10"
            aria-hidden
          />
        ) : (
          <NoImagePlaceholder variant="branded" />
        )}
        {asPeek ? null : (
          <>
            <HousingBrowseCardOverlay
              card={card}
              rent={rent}
              periodLabel={card.pricePeriod === "day" ? " / day" : card.pricePeriod === "week" ? " / week" : " / month"}
              layout="swipe"
            />
            {card.petFriendly ? (
              <span className="absolute left-2.5 top-2.5 rounded-full bg-black/45 px-2.5 py-0.5 text-[11px] font-semibold text-white backdrop-blur-sm">
                Pets OK
              </span>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

export function HousingBrowseSwipeStack({ cards }: { cards: PropertyBrowseCard[] }) {
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const [dragX, setDragX] = useState(0);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [exiting, setExiting] = useState<"left" | "right" | null>(null);
  const pointerIdRef = useRef<number | null>(null);
  const startRef = useRef({ x: 0, y: 0 });

  const cardKey = cards.map((c) => c.propertyId).join(",");
  useEffect(() => {
    setIndex(0);
    setDragX(0);
    setDragY(0);
    setExiting(null);
  }, [cardKey]);

  const current = cards[index];
  const next = cards[index + 1];
  const prev = cards[index - 1];
  const done = !current;

  const openListing = useCallback(
    (card: PropertyBrowseCard) => {
      router.push(`/rent/listings/${encodeURIComponent(card.propertyId)}`);
    },
    [router],
  );

  const goNext = useCallback(() => {
    if (!current || exiting || index >= cards.length - 1) {
      setDragX(0);
      setDragY(0);
      return;
    }
    setExiting("left");
    setDragX(-window.innerWidth * 1.1);

    window.setTimeout(() => {
      setIndex((i) => i + 1);
      setDragX(0);
      setDragY(0);
      setExiting(null);
    }, EXIT_ANIM_MS);
  }, [cards.length, current, exiting, index]);

  const goPrev = useCallback(() => {
    if (!current || exiting || index <= 0) {
      setDragX(0);
      setDragY(0);
      return;
    }
    setExiting("right");
    setDragX(window.innerWidth * 1.1);

    window.setTimeout(() => {
      setIndex((i) => i - 1);
      setDragX(0);
      setDragY(0);
      setExiting(null);
    }, EXIT_ANIM_MS);
  }, [current, exiting, index]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (exiting || !current) return;
    pointerIdRef.current = e.pointerId;
    startRef.current = { x: e.clientX, y: e.clientY };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging || pointerIdRef.current !== e.pointerId || exiting) return;
    const dx = e.clientX - startRef.current.x;
    const dy = e.clientY - startRef.current.y;
    const atStart = index <= 0;
    const atEnd = index >= cards.length - 1;
    const resistedDx =
      (atStart && dx > 0) || (atEnd && dx < 0) ? dx * 0.25 : dx;
    setDragX(resistedDx);
    setDragY(dy * 0.15);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (pointerIdRef.current !== e.pointerId) return;
    pointerIdRef.current = null;
    setDragging(false);
    if (exiting || !current) return;

    const dx = e.clientX - startRef.current.x;
    const dy = e.clientY - startRef.current.y;

    if (Math.abs(dx) < TAP_THRESHOLD_PX && Math.abs(dy) < TAP_THRESHOLD_PX) {
      openListing(current);
      setDragX(0);
      setDragY(0);
      return;
    }

    if (dx < -SWIPE_THRESHOLD_PX) {
      goNext();
      return;
    }
    if (dx > SWIPE_THRESHOLD_PX) {
      goPrev();
      return;
    }
    setDragX(0);
    setDragY(0);
  };

  const onPointerCancel = () => {
    pointerIdRef.current = null;
    setDragging(false);
    if (!exiting) {
      setDragX(0);
      setDragY(0);
    }
  };

  if (done) {
    return (
      <div className="flex min-h-[min(62dvh,520px)] flex-col items-center justify-center rounded-3xl border border-dashed border-border/70 px-6 py-12 text-center">
        <p className="text-base font-semibold text-foreground">You&apos;ve seen every home</p>
        <p className="mt-2 text-sm text-muted">Adjust filters or check back when new listings go live.</p>
        <button
          type="button"
          onClick={() => setIndex(0)}
          data-attr="resident-browse-restart-swipe"
          className="mt-5 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white"
        >
          Start over
        </button>
      </div>
    );
  }

  const rotate = dragX * 0.04;
  const transition = dragging ? "none" : `transform ${EXIT_ANIM_MS}ms ease-out`;
  const peekCard = dragX < 0 ? next : dragX > 0 ? prev : next;

  return (
    <div className="flex flex-col items-center">
      <div
        className="relative mx-auto w-full max-w-[min(100%,22rem)] touch-none select-none"
        style={{ height: "min(62dvh, 520px)" }}
        aria-label="Browse homes. Swipe left for next, right for previous, tap to view"
      >
        {peekCard ? (
          <div className="absolute inset-0 scale-[0.96] opacity-90" aria-hidden>
            <SwipeCardFace card={peekCard} asPeek />
          </div>
        ) : null}

        <div
          className="absolute inset-0 cursor-grab active:cursor-grabbing"
          style={{
            transform: `translate(${dragX}px, ${dragY}px) rotate(${rotate}deg)`,
            transition,
            zIndex: 2,
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          data-attr="resident-browse-swipe-card"
        >
          <SwipeCardFace card={current} />
        </div>
      </div>

      <p className="mt-3 text-center text-xs text-muted">
        {index + 1} of {cards.length} · swipe left for next · right for back · tap to view
      </p>
    </div>
  );
}
