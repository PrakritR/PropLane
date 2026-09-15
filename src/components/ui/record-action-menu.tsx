"use client";

import { Children, Fragment, cloneElement, isValidElement, useContext, useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RecordActionContext, RecordActionItemsContext, RecordActionCloseContext } from "./record-action-context";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "./dropdown-menu";

/** Trailing ⋯ on list rows — shared sitewide (portal lists, DataList overflow, expense rows). */
export const RECORD_ACTION_TRIGGER_ICON_CLASS = "size-8 shrink-0 text-foreground stroke-[2.75]";

/** Ghost circle trigger for row ⋯ menus (44×44 tap target). */
export const RECORD_ACTION_TRIGGER_BUTTON_CLASS =
  "h-11 w-11 shrink-0 rounded-full p-0 text-foreground hover:text-foreground";

/**
 * iOS can synthesise a click into a freshly-mounted menu at the tap point.
 * Destructive items ignore any activation within this window of the menu
 * opening so a stray synthetic tap never fires a delete the user never chose.
 */
export const RECORD_ACTION_DESTRUCTIVE_SETTLE_MS = 150;

/** Preserve each screen's existing handler and disabled state inside a real menu. */
export function RecordActionItems({ children }: { children: ReactNode }) {
  const close = useContext(RecordActionCloseContext);
  return <>{Children.map(children, (child) => {
    if (!isValidElement<{ children?: ReactNode; disabled?: boolean; onClick?: (event: MouseEvent<HTMLButtonElement>) => void | Promise<unknown>; onSelect?: (event: Event) => void }>(child)) return child;
    if (child.type === Fragment || child.type === "div") {
      return <RecordActionItems>{child.props.children}</RecordActionItems>;
    }
    if (child.type === Button || child.type === "button") {
      return <DropdownMenuItem asChild disabled={child.props.disabled}>{cloneElement(child, {
        onClick: (event) => { event.preventDefault(); close?.(); return child.props.onClick?.(event); },
      })}</DropdownMenuItem>;
    }
    if (child.type === DropdownMenuItem && close) return cloneElement(child, {
      onSelect: (event) => { event.preventDefault(); close(); child.props.onSelect?.(event); },
    });
    return child;
  })}</>;
}

type ActionLeafProps = {
  variant?: string;
  className?: string;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void | Promise<unknown>;
  onSelect?: (event: Event) => void;
  children?: ReactNode;
};

/** Flatten `context.actions` into leaves, mirroring RecordActionItems' own Fragment/"div" recursion. */
function flattenActionLeaves(children: ReactNode): ReactElement<ActionLeafProps>[] {
  const leaves: ReactElement<ActionLeafProps>[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement<ActionLeafProps>(child)) return;
    if (child.type === Fragment || child.type === "div") {
      leaves.push(...flattenActionLeaves(child.props.children));
      return;
    }
    leaves.push(child);
  });
  return leaves;
}

/** Assign a stable key to a leaf that does not already carry one from its original array position. */
function withStableKey(leaf: ReactElement<ActionLeafProps>, index: number): ReactElement<ActionLeafProps> {
  if (leaf.key != null) return leaf;
  return cloneElement(leaf, { key: `record-action-${index}` });
}

function isDestructiveLeaf(leaf: ReactElement<ActionLeafProps>): boolean {
  if (leaf.type === Button && leaf.props.variant === "danger") return true;
  if (typeof leaf.props.className === "string" && leaf.props.className.includes("text-danger")) return true;
  return false;
}

/** Split a menu's actions into non-destructive and destructive leaf groups, order preserved. */
function splitDestructiveActions(actions: ReactNode) {
  const leaves = flattenActionLeaves(actions).map(withStableKey);
  const nonDestructive: ReactElement<ActionLeafProps>[] = [];
  const destructive: ReactElement<ActionLeafProps>[] = [];
  for (const leaf of leaves) {
    if (isDestructiveLeaf(leaf)) destructive.push(leaf);
    else nonDestructive.push(leaf);
  }
  return { nonDestructive, destructive };
}

export function RecordActionMenu({ label, activate, disabled = false, onOpen }: {
  label: string;
  activate: () => void;
  disabled?: boolean;
  onOpen?: () => void;
}) {
  const context = useContext(RecordActionContext);
  const [openScope, setOpenScope] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const actionClosingRef = useRef(false);
  const openedAtRef = useRef(0);
  const open = Boolean(context && openScope === context.scope);
  if (!context) return null;
  const closeForAction = () => {
    actionClosingRef.current = true;
    flushSync(() => setOpenScope(null));
    triggerRef.current?.focus();
  };
  const hasActions = !disabled && Boolean(context.actions);
  const { nonDestructive, destructive: destructiveLeaves } = hasActions
    ? splitDestructiveActions(context.actions)
    : { nonDestructive: [], destructive: [] };
  // Tagged (not handler-guarded) — the actual settle guard is a single
  // capture-phase listener on DropdownMenuContent below. RecordActionItems
  // always closes the menu before calling a leaf's own onClick/onSelect, so
  // a guard living there could skip the destructive handler but never stop
  // the close; a capture-phase listener on the content runs first and can
  // stop the click before it reaches anything, including that close.
  const destructive: ReactElement<ActionLeafProps>[] = destructiveLeaves.map((leaf) =>
    cloneElement(leaf, { "data-record-action-destructive": "" } as Partial<ActionLeafProps>),
  );
  return <span className="order-last ml-auto inline-flex shrink-0 self-center" data-portal-row-ignore onClick={(event) => event.stopPropagation()}>
    <DropdownMenu open={open} onOpenChange={(next) => {
      if (next) {
        actionClosingRef.current = false;
        openedAtRef.current = Date.now();
        flushSync(() => context.clear());
        if (!disabled) flushSync(activate);
      }
      setOpenScope(next ? context.scope : null);
    }}>
      <DropdownMenuTrigger asChild>
        <Button ref={triggerRef} type="button" variant="ghost" disabled={disabled && !onOpen} aria-label={`Actions for ${label}`} className={RECORD_ACTION_TRIGGER_BUTTON_CLASS} data-attr="record-actions-trigger">
          <MoreHorizontal className={RECORD_ACTION_TRIGGER_ICON_CLASS} aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        onCloseAutoFocus={(event) => { if (actionClosingRef.current) event.preventDefault(); }}
        onClickCapture={(event) => {
          if (Date.now() - openedAtRef.current >= RECORD_ACTION_DESTRUCTIVE_SETTLE_MS) return;
          if (!(event.target instanceof Element)) return;
          if (!event.target.closest("[data-record-action-destructive]")) return;
          event.preventDefault();
          event.stopPropagation();
        }}
        align="end"

        aria-label={`Actions for ${label}`}
        data-attr="record-actions-menu"
        className="record-action-menu max-h-[min(var(--radix-dropdown-menu-content-available-height),28rem)] w-64 overflow-y-auto"
      >
        <DropdownMenuLabel className="truncate text-xs font-semibold text-muted">{label}</DropdownMenuLabel>
        {onOpen ? <DropdownMenuItem onSelect={(event) => { event.preventDefault(); closeForAction(); onOpen(); }}>View details</DropdownMenuItem> : null}
        <RecordActionCloseContext.Provider value={closeForAction}>
        <RecordActionItemsContext.Provider value>
          {hasActions ? (
            <>
              <RecordActionItems>{nonDestructive}</RecordActionItems>
              {nonDestructive.length > 0 && destructive.length > 0 ? <DropdownMenuSeparator /> : null}
              <RecordActionItems>{destructive}</RecordActionItems>
            </>
          ) : !onOpen ? <p className="px-3 py-2 text-sm text-muted">No actions available.</p> : null}
        </RecordActionItemsContext.Provider>
        </RecordActionCloseContext.Provider>
      </DropdownMenuContent>
    </DropdownMenu>
  </span>;
}
