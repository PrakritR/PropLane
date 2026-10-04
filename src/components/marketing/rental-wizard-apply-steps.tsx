"use client";

const MILESTONES = ["Lease", "About you", "Details", "Review", "Fee"] as const;

function milestoneIndexForWizardStep(step: number): number {
  if (step <= 1) return 0;
  if (step === 2) return 1;
  if (step >= 3 && step <= 9) return 2;
  if (step === 10) return 3;
  if (step === 11) return 4;
  return 0;
}

/** Replica `jr-apply-steps` — styled five-step stepper without a total count. */
export function RentalWizardApplySteps({ currentStep }: { currentStep: number }) {
  const currentIndex = milestoneIndexForWizardStep(currentStep);
  return (
    <ol className="jr-apply-steps mb-4 flex flex-wrap items-center gap-2" data-jr-apply-steps>
      {MILESTONES.map((label, index) => {
        const done = index < currentIndex;
        const on = index === currentIndex;
        return (
          <li
            key={label}
            className={`flex items-center gap-2 text-[13px] font-bold ${
              on ? "text-foreground" : done ? "text-foreground" : "text-muted"
            }`}
          >
            {index > 0 ? (
              <span className="mr-1 hidden h-px w-5 bg-border sm:inline-block" aria-hidden />
            ) : null}
            <span
              className={`inline-flex h-7 w-7 items-center justify-center rounded-full border text-xs font-bold ${
                on
                  ? "border-primary bg-primary text-white"
                  : done
                    ? "border-foreground bg-foreground text-white"
                    : "border-border bg-card text-muted"
              }`}
            >
              {done ? "✓" : index + 1}
            </span>
            <span>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}
