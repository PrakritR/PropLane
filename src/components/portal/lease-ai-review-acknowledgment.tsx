"use client";

import { LEASE_AI_REVIEW_DISCLAIMER } from "@/lib/lease-templates/types";
import { cn } from "@/lib/utils";

export function LeaseAiReviewAcknowledgment({
  checked,
  onCheckedChange,
  className,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2.5 rounded-xl border border-amber-200/80 bg-amber-50/80 px-3 py-2.5 text-sm leading-relaxed text-amber-950",
        className,
      )}
    >
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-amber-400"
        checked={checked}
        onChange={(e) => onCheckedChange(e.target.checked)}
        data-attr="lease-ai-review-acknowledgment"
      />
      <span>
        <strong className="font-semibold">I have reviewed this AI-generated lease draft.</strong>{" "}
        {LEASE_AI_REVIEW_DISCLAIMER} Required disclosure language is locked in the document — edit
        surrounding sections only.
      </span>
    </label>
  );
}
