"use client";

import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";

/** Floating primary action — matches resident Payments list chrome (bottom-right, above tab bar). */
export function PortalResidentListFab({
  onClick,
  disabled = false,
  ariaLabel,
  dataAttr,
  className,
}: {
  onClick: () => void;
  disabled?: boolean;
  ariaLabel: string;
  dataAttr?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      data-attr={dataAttr}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "portal-resident-list-fab fixed z-[44] flex h-12 w-12 items-center justify-center rounded-full text-white shadow-[0_12px_28px_-12px_rgba(47,107,255,0.75)] outline-none transition-[transform,filter] hover:brightness-110 focus-visible:ring-2 focus-visible:ring-primary/30 active:scale-95 disabled:pointer-events-none disabled:opacity-40",
        "bottom-[calc(var(--portal-native-bottom-nav-inset,0px)+4.25rem)] right-[max(1rem,env(safe-area-inset-right))]",
        "lg:bottom-6 lg:right-6",
        className,
      )}
      style={{ background: "var(--btn-primary)" }}
    >
      <Plus className="h-6 w-6" strokeWidth={2.25} aria-hidden />
    </button>
  );
}
