"use client";

import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSafeAreaInsets } from "@/hooks/use-safe-area-insets";

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuSub = DropdownMenuPrimitive.Sub;

/**
 * Every dropdown menu is liquid glass over a blurred page.
 *
 * The ⋯ row menus and the composer menus had the approved translucent surface
 * (`.portal-liquid-glass`) and a few others asked for a faint scrim, but the
 * ＋ menu on Properties and half a dozen more were plain white cards over an
 * untouched page. One look for all of them, so `glass` and `backdrop` default
 * on; a caller opts out of the scrim only when the menu already sits inside
 * a modal whose own overlay is the blur (see application-form-builder).
 */
export function DropdownMenuContent({
  className,
  sideOffset = 8,
  align = "end",
  backdrop = true,
  glass = true,
  collisionPadding,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content> & {
  /** Blur and dim the page behind the menu. Off only inside a modal. */
  backdrop?: boolean;
  /** The translucent liquid surface. Off only for a deliberately flat menu. */
  glass?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const resolvedCollisionPadding =
    collisionPadding ?? {
      top: 12 + insets.top,
      right: 12 + insets.right,
      bottom: 12 + insets.bottom + insets.bottomNav,
      left: 12 + insets.left,
    };
  return (
    <>
      {backdrop && (
        <DropdownMenuPrimitive.Portal>
          <div
            // Just under the menu itself (z-[10060]) so it blurs whatever the
            // menu opened over — the page, or a modal or full-page workspace.
            className="portal-menu-backdrop fixed inset-0 z-[10050] animate-in fade-in-0 pointer-events-none motion-reduce:animate-none"
            data-testid="dropdown-menu-backdrop"
            aria-hidden
          />
        </DropdownMenuPrimitive.Portal>
      )}
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          sideOffset={sideOffset}
          align={align}
          avoidCollisions
          sticky="always"
          updatePositionStrategy="always"
          // No `hideWhenDetached`: floating-ui's `hide` middleware reports a
          // zero-size reference as detached (true of every element without a
          // real layout engine), and this menu is modal, so a detached
          // trigger is not a real case worth hiding for.
          collisionPadding={resolvedCollisionPadding}
          className={cn(
            // Above PortalDialog / ModalShell (z-[90]) so row ⋯ menus stay clickable on sheets.
            "z-[10060] min-w-[14rem] overflow-hidden rounded-xl border border-border bg-card p-1.5 text-foreground shadow-[0_12px_32px_-8px_rgba(20,28,48,0.22)]",
            "origin-[var(--radix-dropdown-menu-content-transform-origin)]",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
            "data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1",
            "duration-[220ms] ease-[cubic-bezier(.22,1,.36,1)] data-[state=closed]:duration-[120ms]",
            "motion-reduce:animate-none motion-reduce:transition-none",
            glass && "portal-liquid-glass",
            className,
          )}
          {...props}
        />
      </DropdownMenuPrimitive.Portal>
    </>
  );
}

export function DropdownMenuItem({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & { inset?: boolean }) {
  return (
    <DropdownMenuPrimitive.Item
      className={cn(
        "flex min-h-11 cursor-pointer select-none items-center gap-2.5 rounded-lg px-3 py-2.5 text-[13.5px] font-medium outline-none transition focus:bg-accent/70 focus:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&>svg]:h-[16px] [&>svg]:w-[16px] [&>svg]:shrink-0 [&>svg]:text-muted",
        inset && "pl-8",
        className,
      )}
      {...props}
    />
  );
}

/** Flyout trigger for a nested menu (e.g. "Move to section ▸"). */
export function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger>) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      className={cn(
        "flex min-h-11 cursor-pointer select-none items-center gap-2.5 rounded-lg px-3 py-2.5 text-[13.5px] font-medium outline-none transition focus:bg-accent/70 focus:text-foreground data-[state=open]:bg-accent/70 data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <span className="min-w-0 flex-1">{children}</span>
      <ChevronRight className="h-[15px] w-[15px] shrink-0 text-muted" aria-hidden />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

export function DropdownMenuSubContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent
        sideOffset={sideOffset}
        className={cn(
          "z-[10060] min-w-[12rem] overflow-hidden rounded-xl border border-border bg-card p-1.5 text-foreground shadow-[0_12px_32px_-8px_rgba(20,28,48,0.22)]",
          "origin-[var(--radix-dropdown-menu-content-transform-origin)]",
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          "duration-[220ms] ease-[cubic-bezier(.22,1,.36,1)] data-[state=closed]:duration-[120ms]",
          "motion-reduce:animate-none motion-reduce:transition-none",
          "portal-liquid-glass",
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      className={cn("px-3 py-1.5", className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      className={cn("my-1 h-px bg-border", className)}
      {...props}
    />
  );
}
