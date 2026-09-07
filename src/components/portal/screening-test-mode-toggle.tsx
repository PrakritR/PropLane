"use client";

import { cn } from "@/lib/utils";
import { showToast } from "@/lib/toast";
import { setScreeningTestModeActive } from "@/lib/screening/screening-test-mode";

/** In-header Test mode switch — never a bottom-left overlay under the sidebar (PRP-383). */
export function ScreeningTestModeToggle({
  active,
  onChanged,
}: {
  active: boolean;
  onChanged?: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs shadow-sm">
      <span className="font-medium text-foreground">Test mode</span>
      <button
        type="button"
        role="switch"
        aria-checked={active}
        className={cn(
          "relative h-6 w-11 rounded-full transition",
          active ? "bg-amber-400" : "bg-muted",
        )}
        onClick={() => {
          const next = !active;
          setScreeningTestModeActive(next);
          showToast(
            next
              ? "Screening test mode on — simulated reports, no charges."
              : "Live screening mode — real Checkr orders.",
          );
          onChanged?.();
        }}
        data-attr="screening-test-mode-toggle"
      >
        <span
          className={cn(
            "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition",
            active ? "left-[22px]" : "left-0.5",
          )}
        />
      </button>
    </div>
  );
}
