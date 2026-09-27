"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import {
  PROPLANE_MARK_PATHS,
  PROPLANE_MARK_STROKE_WIDTH,
  PROPLANE_MARK_VIEWBOX_SIZE,
} from "@/lib/brand/proplane-mark";

const markTileBase =
  "flex shrink-0 items-center justify-center border border-white/35 bg-[linear-gradient(150deg,rgba(255,255,255,0.34),rgba(255,255,255,0.1))] shadow-[inset_0_1px_0_rgba(255,255,255,0.45)] [html[data-theme=light]_&]:border-border/80 [html[data-theme=light]_&]:bg-[linear-gradient(150deg,#ffffff,#e9eefb)] [html[data-theme=light]_&]:shadow-[inset_0_1px_0_#ffffff,0_1px_2px_rgba(15,23,42,0.05)]";

const markTileSizes = {
  default: "h-14 w-14 rounded-[18px]",
  compact: "h-10 w-10 rounded-[14px]",
} as const;

const glyphSizes = {
  default: "h-[28px] w-[28px]",
  compact: "h-[20px] w-[20px]",
  /** Bare glyph at avatar-chip scale — a workspace switcher's own h-6/h-7 tile
   *  supplies the background box, so only the mark itself is needed here. */
  micro: "h-[15px] w-[15px]",
} as const;

export type AxisLogoSize = keyof typeof markTileSizes;
export type AxisLogoGlyphSize = keyof typeof glyphSizes;

export type AxisLogoVariant = "default" | "portalHeader" | "adminHeader";

/**
 * Inline PropLane mark — rounded house/chevron outline with a crossing X,
 * single-colour line art (no fill). Geometry is the canonical
 * {@link PROPLANE_MARK_PATHS} (see src/lib/brand/proplane-mark.ts); the
 * stroke uses the `primary` theme variable (blue in light theme, purple in
 * dark theme — src/app/globals.css) rather than a hardcoded hex, so the mark
 * always matches the rest of the UI's brand accent instead of showing a
 * fixed blue in a dark-mode context.
 *
 * Exported (not just used by {@link AxisLogoMark}) so a caller that already
 * draws its own tile chrome — the workspace switcher's flat avatar chip — can
 * drop in just the glyph at `size="micro"` instead of building a second mark.
 */
export function AxisLogoGlyph({
  className = "",
  size = "default",
}: {
  className?: string;
  size?: AxisLogoGlyphSize;
}) {
  return (
    <svg
      className={`block shrink-0 ${glyphSizes[size]} ${className}`}
      viewBox={`0 0 ${PROPLANE_MARK_VIEWBOX_SIZE} ${PROPLANE_MARK_VIEWBOX_SIZE}`}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      shapeRendering="geometricPrecision"
      aria-hidden
    >
      <g
        className="stroke-primary"
        fill="none"
        strokeWidth={PROPLANE_MARK_STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {PROPLANE_MARK_PATHS.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  );
}

/** Primary PropLane mark — crisp gradient tile + SVG glyph. */
export function AxisLogoMark({
  className = "",
  variant,
  size = "default",
}: {
  className?: string;
  variant?: AxisLogoVariant;
  size?: AxisLogoSize;
}) {
  void variant;
  return (
    <div className={`${markTileBase} ${markTileSizes[size]} ${className}`} aria-hidden>
      <AxisLogoGlyph size={size} />
    </div>
  );
}

/**
 * Same tile chrome as the header brand mark — use for portal empty states
 * so icons read with the same weight as the global header.
 */
export function AxisHeaderMarkTile({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`${markTileBase} ${markTileSizes.default} text-foreground ${className}`} aria-hidden>
      {children}
    </div>
  );
}

/** Lighter shadow variant — same glyph and tile. */
export function AxisLogoMarkSoft({ className = "" }: { className?: string }) {
  return (
    <div className={`${markTileBase} h-14 w-14 rounded-[20px] ${className}`} aria-hidden>
      <AxisLogoGlyph />
    </div>
  );
}

export function AxisLogoWordmark({ size = "default" }: { size?: AxisLogoSize }) {
  return (
    <span
      className={`font-semibold tracking-[-0.035em] text-foreground ${size === "compact" ? "text-[15px]" : "text-[17px]"}`}
    >
      PropLane
    </span>
  );
}

export function AxisLogoLink({
  href = "/",
  variant = "default",
  size = "default",
  showWordmark = true,
}: {
  href?: string;
  variant?: AxisLogoVariant;
  size?: AxisLogoSize;
  showWordmark?: boolean;
}) {
  return (
    <Link
      href={href}
      aria-label="PropLane home"
      className={`flex items-center ${showWordmark ? (size === "compact" ? "gap-2" : "gap-3") : ""}`}
    >
      <AxisLogoMark variant={variant} size={size} />
      {showWordmark ? <AxisLogoWordmark size={size} /> : null}
    </Link>
  );
}
