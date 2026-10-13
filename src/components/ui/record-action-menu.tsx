"use client";

import { Children, Fragment, cloneElement, isValidElement, useContext, useLayoutEffect, useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { RecordActionContext, RecordActionItemsContext, RecordActionCloseContext } from "./record-action-context";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "./dropdown-menu";
import { classifyRecordActionTone, isPostDividerRecordActionId, orderRecordActions, type RecordActionTone } from "@/lib/portals/record-action-order";
import { recordActionIcon } from "@/lib/portals/record-action-icons";

/** Trailing ⋯ on list rows — shared sitewide (portal lists, DataList overflow, expense rows). */
export const RECORD_ACTION_TRIGGER_ICON_CLASS = "size-[18px] shrink-0 text-muted stroke-[2.25]";

/** Ghost trigger for row ⋯ menus: 32px on desktop, the 44x44 tap target on a phone. */
export const RECORD_ACTION_TRIGGER_BUTTON_CLASS =
  "h-11 w-11 shrink-0 rounded-lg p-0 text-muted hover:text-foreground lg:h-8 lg:w-8";

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
  disabled?: boolean;
  variant?: string;
  className?: string;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void | Promise<unknown>;
  onSelect?: (event: Event) => void;
  children?: ReactNode;
  /**
   * Opts a leaf into `orderRecordActions` (`src/lib/portals/record-action-order.ts`)
   * — the record's own action ids ("edit", "record-payment", …), or one of the
   * trailing ids it recognizes ("message", "copy", "share", "archive",
   * "delete"). A menu whose every leaf carries this renders in the one
   * canonical order; a menu with any untagged leaf keeps today's
   * destructive-goes-last behavior unchanged (PLAN-0920-1058 area 1d).
   */
  "data-record-action-id"?: string;
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

/** The visible words of a leaf (strings anywhere in its children), used to read its tone and pick its glyph. */
function leafLabel(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(leafLabel).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return leafLabel(node.props.children);
  return "";
}

/** Tone of a leaf: its own action id wins, otherwise the words it shows. */
function leafTone(leaf: ReactElement<ActionLeafProps>): RecordActionTone {
  const id = leaf.props["data-record-action-id"];
  const byId = id ? classifyRecordActionTone(id) : "neutral";
  return byId !== "neutral" ? byId : classifyRecordActionTone(leafLabel(leaf.props.children));
}

/** A leaf that already draws its own icon (a component child) keeps it; a plain-text leaf gets the 16px glyph. */
function leafHasOwnIcon(leaf: ReactElement<ActionLeafProps>): boolean {
  return Children.toArray(leaf.props.children).some((child) => isValidElement(child) && typeof child.type !== "string");
}

function withLeadingIcon(leaf: ReactElement<ActionLeafProps>, tone: RecordActionTone): ReactElement<ActionLeafProps> {
  const label = leafLabel(leaf.props.children).trim() || leaf.props["data-record-action-id"] || "";
  const extra = { "data-record-action-tone": tone } as Partial<ActionLeafProps>;
  if (leafHasOwnIcon(leaf)) return cloneElement(leaf, extra);
  const Icon = recordActionIcon(label);
  return cloneElement(leaf, extra, <Icon className="size-4 shrink-0" aria-hidden />, <span className="min-w-0 truncate">{leaf.props.children}</span>);
}

function isDestructiveLeaf(leaf: ReactElement<ActionLeafProps>): boolean {
  const actionId = leaf.props["data-record-action-id"];
  if (actionId && isPostDividerRecordActionId(actionId)) return true;
  if (leaf.type === Button && leaf.props.variant === "danger") return true;
  if (typeof leaf.props.className === "string" && leaf.props.className.includes("text-danger")) return true;
  return false;
}

/**
 * Split a menu's actions into non-destructive and destructive leaf groups.
 *
 * When every leaf declares `data-record-action-id`, the non-destructive group
 * is additionally sorted into the canonical order (own actions, capped, then
 * Message, then Copy link / Share) via `orderRecordActions` — a menu that has
 * not adopted ids yet keeps its given order exactly as before.
 */
function splitDestructiveActions(actions: ReactNode) {
  const leaves = flattenActionLeaves(actions).map(withStableKey);
  const neutral: ReactElement<ActionLeafProps>[] = [];
  const positive: ReactElement<ActionLeafProps>[] = [];
  const negative: ReactElement<ActionLeafProps>[] = [];
  const trailing: ReactElement<ActionLeafProps>[] = [];
  for (const leaf of leaves) {
    const tone = leafTone(leaf);
    if (tone === "positive") positive.push(withLeadingIcon(leaf, "positive"));
    else if (tone === "negative") negative.push(withLeadingIcon(leaf, "negative"));
    else if (tone === "destructive" || isDestructiveLeaf(leaf)) trailing.push(withLeadingIcon(leaf, tone === "destructive" ? "destructive" : "neutral"));
    else neutral.push(leaf);
  }
  const fullyTagged = neutral.length > 0 && neutral.every((leaf) => Boolean(leaf.props["data-record-action-id"]));
  const orderedNeutral = (fullyTagged
    ? orderRecordActions(neutral.map((leaf) => ({ id: leaf.props["data-record-action-id"]!, leaf }))).map((entry) => entry.leaf)
    : neutral
  ).map((leaf) => withLeadingIcon(leaf, "neutral"));
  // After the divider: green decisions, then the red one directly below them, then Delete / Remove.
  return { nonDestructive: orderedNeutral, destructive: [...positive, ...negative, ...trailing] };
}

/** The click handler of a lone menu item, or null when it is not a plain button / menu item we can fire directly. */
function singleActionHandler(leaf: ReactElement<ActionLeafProps>): ((event: MouseEvent<HTMLButtonElement>) => void) | null {
  if (leaf.type === Button || leaf.type === "button") {
    const { onClick } = leaf.props;
    return onClick ? (event) => { void onClick(event); } : null;
  }
  if (leaf.type === DropdownMenuItem) {
    const { onSelect } = leaf.props;
    return onSelect ? () => onSelect(new Event("select")) : null;
  }
  return null;
}

/**
 * A menu of exactly one item, drawn as that item's icon. The row's `activate` selects the record the
 * action is for, and the handlers are built from that selection, so the click runs the handler the
 * row rendered AFTER activating - never the one it closed over before.
 */
function SingleRecordAction({ label, actionId, tone, disabled, handler, prepare }: {
  label: string;
  actionId?: string;
  tone: "default" | "primary" | "danger";
  disabled?: boolean;
  handler: (event: MouseEvent<HTMLButtonElement>) => void;
  prepare: () => void;
}) {
  const latest = useRef(handler);
  useLayoutEffect(() => { latest.current = handler; });
  return <span className="order-last ml-auto inline-flex shrink-0 self-center" data-portal-row-ignore onClick={(event) => event.stopPropagation()}>
    <PortalIconAction
      icon={recordActionIcon(label)}
      label={label}
      tone={tone}
      disabled={disabled}
      data-attr="record-actions-single"
      data-record-action-id={actionId}
      onClick={(event) => { prepare(); latest.current(event); }}
    />
  </span>;
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
  // A positive decision (Approve, Mark done) shares the group after the divider but is not destructive,
  // so it takes no settle guard: it must answer the first tap.
  const destructive: ReactElement<ActionLeafProps>[] = destructiveLeaves.map((leaf) =>
    (leaf.props as Record<string, unknown>)["data-record-action-tone"] === "positive"
      ? leaf
      : cloneElement(leaf, { "data-record-action-destructive": "" } as Partial<ActionLeafProps>),
  );
  // A ⋯ that would hold exactly one item is that item's icon instead: one tap, no menu to open.
  const onlyLeaf = !onOpen && !context.lazy && nonDestructive.length + destructive.length === 1 ? [...nonDestructive, ...destructive][0]! : null;
  const onlyHandler = onlyLeaf ? singleActionHandler(onlyLeaf) : null;
  if (onlyLeaf && onlyHandler) {
    const itemLabel = leafLabel(onlyLeaf.props.children).trim() || onlyLeaf.props["data-record-action-id"] || label;
    const itemTone = (onlyLeaf.props as Record<string, unknown>)["data-record-action-tone"];
    return <SingleRecordAction
      label={itemLabel}
      actionId={onlyLeaf.props["data-record-action-id"]}
      tone={itemTone === "positive" ? "primary" : destructive.includes(onlyLeaf) ? "danger" : "default"}
      disabled={onlyLeaf.props.disabled}
      handler={onlyHandler}
      prepare={() => { flushSync(() => context.clear()); if (!disabled) flushSync(activate); }}
    />;
  }
  return <span className="order-last ml-auto inline-flex shrink-0 self-center" data-portal-row-ignore onClick={(event) => event.stopPropagation()}>
    <DropdownMenu modal={false} open={open} onOpenChange={(next) => {
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
        className="record-action-menu z-[10060] max-h-[min(var(--radix-dropdown-menu-content-available-height),28rem)] w-64 overflow-y-auto"
      >
        <DropdownMenuLabel className="truncate text-xs font-semibold text-muted lg:hidden">{label}</DropdownMenuLabel>
        {onOpen ? <DropdownMenuItem onSelect={(event) => { event.preventDefault(); closeForAction(); onOpen(); }}>View</DropdownMenuItem> : null}
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
