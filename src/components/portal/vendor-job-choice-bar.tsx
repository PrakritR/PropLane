"use client";

import { Button } from "@/components/ui/button";
import { VENDOR_JOB_CHOICES, type VendorJobChoiceId } from "@/lib/vendor-job-choice";
import { cn } from "@/lib/utils";

/**
 * The three things a vendor can do about a job they can see: Needs an estimate visit, Bid now,
 * Message the manager (vendor-work-share-1006). One component for Find work rows and the vendor's
 * own Open service page, so the three options read and behave the same everywhere. The buttons are
 * labeled text because each one commits an action; "Bid now" is the primary one. On a phone the
 * row wraps and the short labels keep it inside 390px - the full label is the accessible name.
 */
export function VendorJobChoiceBar({
  onChoose,
  disabled = false,
  busyChoice = null,
  className,
  dataAttr = "vendor-job-choice-bar",
}: {
  onChoose: (choice: VendorJobChoiceId) => void | Promise<unknown>;
  /** Disables all three (a request for this job is in flight, or the job is gone). */
  disabled?: boolean;
  /** The choice whose request is in flight; it shows the spinner, all three stay disabled. */
  busyChoice?: VendorJobChoiceId | null;
  className?: string;
  dataAttr?: string;
}) {
  return (
    <div
      role="group"
      aria-label="What would you like to do"
      className={cn("flex flex-wrap items-center gap-2", className)}
      data-attr={dataAttr}
    >
      {VENDOR_JOB_CHOICES.map((choice) => (
        <Button
          key={choice.id}
          type="button"
          variant={choice.id === "bid" ? "primary" : "outline"}
          aria-label={choice.label}
          disabled={disabled || busyChoice !== null}
          loading={busyChoice === choice.id}
          data-attr={`${dataAttr}-${choice.id}`}
          className="h-10 min-h-[40px] flex-1 !rounded-lg px-3 py-0 text-xs font-medium sm:flex-none sm:px-4 sm:text-sm"
          onClick={() => onChoose(choice.id)}
        >
          <span className="sm:hidden">{choice.short}</span>
          <span className="hidden sm:inline">{choice.label}</span>
        </Button>
      ))}
    </div>
  );
}
