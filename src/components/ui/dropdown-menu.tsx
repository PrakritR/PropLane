"use client";

import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import * as React from "react";
import { cn } from "@/lib/utils";

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

export function DropdownMenuContent({
  className,
  sideOffset = 8,
  align = "end",
  backdrop = false,
  glass = false,
  mobileSheet = false,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content> & {
  backdrop?: boolean;
  glass?: boolean;
  mobileSheet?: boolean;
}) {
  return (
    <>
      {(backdrop || glass) && (
        <DropdownMenuPrimitive.Portal>
          <div
            className="fixed inset-0 z-40 animate-in bg-background/15 fade-in-0 backdrop-blur-[3px] pointer-events-none"
            aria-hidden
          />
        </DropdownMenuPrimitive.Portal>
      )}
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          data-mobile-sheet={mobileSheet || undefined}
          sideOffset={sideOffset}
          align={align}
          className={cn(
            "z-50 min-w-[14rem] overflow-hidden rounded-xl border border-border bg-card p-1.5 text-foreground shadow-[var(--shadow-lg,0_12px_32px_-8px_rgba(20,28,48,0.22))]",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
            glass && "portal-liquid-glass z-[10060]",
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
