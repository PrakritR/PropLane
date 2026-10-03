"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Photos and Video as two equal tiles (stacked on narrow viewports).
 * Shared by room, bathroom, shared-space, and move-in editors (studio 0930).
 */
export function ListingMediaRow({
  photos,
  video,
  photoSlot,
  videoSlot,
  className,
  dataAttr = "re30-media",
}: {
  photos: ReactNode;
  video: ReactNode;
  photoSlot?: ReactNode;
  videoSlot?: ReactNode;
  className?: string;
  dataAttr?: string;
}) {
  return (
    <div data-attr={dataAttr} className={cn("grid grid-cols-1 gap-3 sm:grid-cols-2", className)}>
      <div className="min-w-0 rounded-xl border border-border bg-card p-3">
        <div className="mb-2 text-[12px] font-bold text-foreground">Photos</div>
        {photos}
        {photoSlot ? <div className="mt-2">{photoSlot}</div> : null}
      </div>
      <div className="min-w-0 rounded-xl border border-border bg-card p-3">
        <div className="mb-2 text-[12px] font-bold text-foreground">Video</div>
        {video}
        {videoSlot ? <div className="mt-2">{videoSlot}</div> : null}
      </div>
    </div>
  );
}
