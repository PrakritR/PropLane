"use client";

/**
 * The ONE "who sees what" preview pager both builders draw in their right-hand panel: the
 * application editor's "Applicant sees" and the move-in form editor's "Resident sees". A header
 * line ("Step n of N · form name") with ‹ › icon buttons on the right, then one step: whole
 * sections (title above their questions), with consecutive short sections combined so a step
 * shows up to ~6 questions. A section is never split across steps. Nothing here saves anything.
 */
import { useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { WorkspacePreviewTitle } from "@/components/portal/add-workspace/frame";

/** A step fills up to this many questions before the next section starts a new step. */
export const PREVIEW_STEP_MAX_QUESTIONS = 6;

/** One section's questions (already filtered to what is visible). `title` is empty when the questions have no section. */
export type PreviewGroup<T> = { key: string; title: string; items: readonly T[] };

/**
 * Pack consecutive sections into steps. A section stays whole; it joins the current step only while
 * the step stays within `max` questions, otherwise it starts a new step (alone, if it is bigger than
 * `max` by itself). Empty sections draw nothing, so they are dropped.
 */
export function packPreviewSteps<T>(groups: readonly PreviewGroup<T>[], max: number = PREVIEW_STEP_MAX_QUESTIONS): PreviewGroup<T>[][] {
  const steps: PreviewGroup<T>[][] = [];
  let current: PreviewGroup<T>[] = [];
  let count = 0;
  for (const group of groups) {
    if (group.items.length === 0) continue;
    if (current.length > 0 && count + group.items.length > max) {
      steps.push(current);
      current = [];
      count = 0;
    }
    current.push(group);
    count += group.items.length;
  }
  if (current.length > 0) steps.push(current);
  return steps;
}

/** "Step 1 of 9 · Household application": where the preview is. */
export function previewStepLabel(index: number, total: number, formName: string): string {
  return `Step ${index + 1} of ${total} · ${formName}`;
}

/** Keep an index inside 0..total-1 (0 when there are no steps). */
export function clampPreviewIndex(index: number, total: number): number {
  return Math.min(Math.max(index, 0), Math.max(total - 1, 0));
}

/** The step (counting a leading step, if any) that holds the first item `match` accepts; -1 when none. */
export function previewStepIndexOf<T>(groups: readonly PreviewGroup<T>[], match: (item: T) => boolean, hasLeadingStep = false): number {
  const at = packPreviewSteps(groups).findIndex((step) => step.some((group) => group.items.some(match)));
  return at < 0 ? -1 : at + (hasLeadingStep ? 1 : 0);
}

export function PreviewPager<T>({
  heading,
  ariaLabel,
  dataAttr,
  attrPrefix,
  formName,
  groups,
  itemKey,
  renderItem,
  leadingStep,
  emptyText,
  index,
  onIndexChange,
}: {
  /** "Applicant sees" / "Resident sees". */
  heading: string;
  ariaLabel: string;
  /** `data-attr` on the section. */
  dataAttr: string;
  /** Prefix for the step label and the empty line (`<prefix>-step-label`, `<prefix>-empty`). */
  attrPrefix: string;
  formName: string;
  groups: readonly PreviewGroup<T>[];
  itemKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  /** An extra first step ahead of the questions (an uploaded PDF). */
  leadingStep?: ReactNode;
  emptyText: string;
  /** Controlled step; omit and the pager keeps its own. */
  index?: number;
  onIndexChange?: (next: number) => void;
}) {
  const [ownIndex, setOwnIndex] = useState(0);
  const steps = packPreviewSteps(groups);
  const hasLeading = leadingStep !== undefined && leadingStep !== null;
  const total = steps.length + (hasLeading ? 1 : 0);
  const at = clampPreviewIndex(index ?? ownIndex, total);
  const go = (next: number) => {
    setOwnIndex(next);
    onIndexChange?.(next);
  };
  const questionStep = hasLeading ? (at === 0 ? null : steps[at - 1]) : steps[at];

  return (
    <section aria-label={ariaLabel} data-attr={dataAttr}>
      <WorkspacePreviewTitle>{heading}</WorkspacePreviewTitle>
      <div className="space-y-4 rounded-2xl border border-border bg-card p-3.5">
        <div className="flex items-center justify-between gap-2">
          {total === 0 ? (
            <h4 className="min-w-0 truncate text-sm font-bold text-foreground">{formName}</h4>
          ) : (
            <p className="min-w-0 truncate text-xs text-muted" data-attr={`${attrPrefix}-step-label`}>
              {previewStepLabel(at, total, formName)}
            </p>
          )}
          {total > 0 ? (
            <div className="flex shrink-0 items-center gap-0.5">
              <PortalIconAction icon={ChevronLeft} label="Previous step" disabled={at === 0} onClick={() => go(at - 1)} />
              <PortalIconAction icon={ChevronRight} label="Next step" disabled={at >= total - 1} onClick={() => go(at + 1)} />
            </div>
          ) : null}
        </div>
        {total === 0 ? (
          <p className="text-sm text-muted" data-attr={`${attrPrefix}-empty`}>
            {emptyText}
          </p>
        ) : (
          <div key={at} className="motion-wiz-dir-fwd min-h-0 space-y-5 text-[13px]" data-attr={`${attrPrefix}-step`}>
            {questionStep
              ? questionStep.map((group) => (
                  <div key={group.key} className="space-y-4">
                    {group.title ? <h4 className="text-sm font-bold text-foreground">{group.title}</h4> : null}
                    {group.items.map((item) => (
                      <div key={itemKey(item)}>{renderItem(item)}</div>
                    ))}
                  </div>
                ))
              : leadingStep}
          </div>
        )}
      </div>
    </section>
  );
}
