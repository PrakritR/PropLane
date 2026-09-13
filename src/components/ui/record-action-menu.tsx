"use client";

import { Children, Fragment, cloneElement, isValidElement, useContext, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RecordActionContext, RecordActionItemsContext, RecordActionCloseContext } from "./record-action-context";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "./dropdown-menu";

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
  const open = Boolean(context && openScope === context.scope);
  if (!context) return null;
  const closeForAction = () => {
    actionClosingRef.current = true;
    flushSync(() => setOpenScope(null));
    triggerRef.current?.focus();
  };
  return <span className="order-last ml-auto inline-flex shrink-0 self-center" data-portal-row-ignore onClick={(event) => event.stopPropagation()}>
    <DropdownMenu open={open} onOpenChange={(next) => {
      if (next) {
        actionClosingRef.current = false;
        flushSync(() => context.clear());
        if (!disabled) flushSync(activate);
      }
      setOpenScope(next ? context.scope : null);
    }}>
      <DropdownMenuTrigger asChild>
        <Button ref={triggerRef} type="button" variant="ghost" disabled={disabled && !onOpen} aria-label={`Actions for ${label}`} className="h-11 w-11 shrink-0 rounded-full p-0" data-attr="record-actions-trigger">
          <MoreHorizontal className="size-5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent onCloseAutoFocus={(event) => { if (actionClosingRef.current) event.preventDefault(); }} align="end" glass mobileSheet data-attr="record-actions-menu" className="record-action-menu max-h-[min(70dvh,28rem)] w-64 overflow-y-auto">
        <DropdownMenuLabel className="truncate text-xs font-semibold text-muted">{label}</DropdownMenuLabel>
        {onOpen ? <DropdownMenuItem onSelect={(event) => { event.preventDefault(); closeForAction(); onOpen(); }}>View details</DropdownMenuItem> : null}
        <RecordActionCloseContext.Provider value={closeForAction}>
        <RecordActionItemsContext.Provider value>
          {!disabled && context.actions ? <RecordActionItems>{context.actions}</RecordActionItems> : !onOpen ? <p className="px-3 py-2 text-sm text-muted">No actions available.</p> : null}
        </RecordActionItemsContext.Provider>
        </RecordActionCloseContext.Provider>
      </DropdownMenuContent>
    </DropdownMenu>
  </span>;
}
