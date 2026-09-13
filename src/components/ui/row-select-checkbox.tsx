"use client";

import { useContext, useRef, type InputHTMLAttributes, type MouseEvent, type Ref } from "react";
import { RowSelectionModeContext } from "./row-selection-mode";
import { RecordActionContext } from "./record-action-context";
import { RecordActionMenu } from "./record-action-menu";
const PORTAL_LIST_CHECKBOX_HIT_CLASS = "-m-3 inline-flex shrink-0 cursor-pointer items-center justify-center p-3";
import { cn } from "@/lib/utils";

/**
 * Hit pad for a 16 px selection box: 12 px of padding on every side, pulled
 * back with the same negative margin, so the label occupies exactly the 16 px
 * the bare input used to and the row's layout does not move — while the tap
 * target grows to 40 × 40. The same pad `DataList` adopted for AXI-157; this
 * is the one place every other list row gets it from.
 */
export const ROW_SELECT_HIT_PAD_CLASS = `relative ${PORTAL_LIST_CHECKBOX_HIT_CLASS}`;

export const ROW_SELECT_INPUT_CLASS = "h-4 w-4 rounded border-border accent-primary";

/**
 * The leading selection checkbox on a list row, with a thumb-sized hit area.
 *
 * Every list surface selects rows with a leading checkbox (AGENTS.md, "Every
 * list tab copies the Properties portal"), and every one of them drew a bare
 * 16 × 16 `<input>` — under WCAG 2.2's 24 px minimum and well under the 44 px
 * a phone wants. Worse than a hard tap: on the Communication list a miss lands
 * on the row itself, which OPENS the conversation, so trying to multi-select
 * navigated the user away (PRP-369, PRP-378).
 *
 * The box stays visually 16 px. The wrapping `<label>` is what grows: its
 * padding is the hit area, and clicking anywhere on it toggles the input the
 * way a label always has. Clicks stop at the label so the row underneath never
 * sees them, and `data-portal-row-ignore` tells the row's own click handler to
 * skip this element on the way up.
 *
 * `wrapperClassName` takes the row's own margins. Because the label carries
 * `-m-3`, express each side as the bare input's old margin MINUS 12 px — a
 * former `mr-3 mt-1` becomes `mr-0 -mt-2` — so the row's spacing is unchanged.
 */
export function RowSelectCheckbox({
  className,
  wrapperClassName,
  onClick,
  onOpenRecord,
  ref,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  wrapperClassName?: string;
  onOpenRecord?: () => void;
  /** Reaches the `<input>` — a group checkbox sets `indeterminate` through it. */
  ref?: Ref<HTMLInputElement>;
}) {
  const selectionMode = useContext(RowSelectionModeContext);
  const actions = useContext(RecordActionContext);
  const inputRef = useRef<HTMLInputElement>(null);
  if (actions) {
    const label = String(props["aria-label"] ?? "record");
    if (/^Select (all|group|cluster|visible)\b/i.test(label)) return null;
    return <>
      <input {...props} type="checkbox" hidden
        ref={(node) => { inputRef.current = node; if (typeof ref === "function") return ref(node); if (ref) ref.current = node; }}
        onClick={(event) => { event.stopPropagation(); onClick?.(event); }} tabIndex={-1} aria-hidden />
      <RecordActionMenu label={label.replace(/^Select\s+/i, "")} disabled={props.disabled} onOpen={onOpenRecord} activate={() => inputRef.current?.click()} />
    </>;
  }
  return (
    <label
      hidden={selectionMode === false}
      className={cn(ROW_SELECT_HIT_PAD_CLASS, "min-h-11 min-w-11", wrapperClassName, selectionMode === false && "hidden")}
      onClick={(event) => event.stopPropagation()}
      data-portal-row-ignore
      data-row-select-hit-pad
    >
      <input
        ref={ref}
        type="checkbox"
        className={cn(ROW_SELECT_INPUT_CLASS, className)}
        onClick={(event: MouseEvent<HTMLInputElement>) => {
          event.stopPropagation();
          onClick?.(event);
        }}
        {...props}
      />
    </label>
  );
}
