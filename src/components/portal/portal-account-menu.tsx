"use client";

import { HelpCircle, Settings } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { PortalRoleSwitcher } from "@/components/portal/portal-role-switcher";
import { PortalSignOutButton } from "@/components/portal/portal-sign-out-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DARK_MODE_ENABLED } from "@/lib/theme-storage";
import type { PortalKind } from "@/lib/portal-types";

export function accountInitials(name: string | null, email: string | null): string {
  const src = (name ?? "").trim() || (email ?? "").trim();
  if (!src) return "?";
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

/**
 * The account menu. It moved from the old top bar's right edge to the bottom of
 * the workspace rail (the avatar, with its green presence dot) and keeps
 * exactly the items it had: name + email header, Settings, Appearance, the
 * portal switcher rows, Sign out; plus Help & feedback, which used to live in
 * the sidebar footer. Settings is reachable from here and nowhere in the nav.
 */
export function PortalAccountMenu({
  kind,
  basePath,
  name,
  email,
  onOpenHelp,
}: {
  kind: PortalKind;
  basePath: string;
  name: string | null;
  email: string | null;
  onOpenHelp?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const displayName = (name ?? "").trim() || (email ?? "").trim() || "Account";
  const initials = accountInitials(name, email);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        className="relative grid size-[34px] place-items-center rounded-[9px] bg-[var(--portal-avatar-bg,#eaf0fe)] text-[11px] font-bold text-[var(--portal-avatar-fg,#1e4fd6)] outline-none transition hover:brightness-95 focus-visible:ring-2 focus-visible:ring-white/70"
        aria-label="Account menu"
        data-attr="portal-account-menu"
      >
        {initials}
        <i
          aria-hidden
          className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-[var(--portal-strip-bg,#101828)] bg-[#22a06b]"
        />
      </DropdownMenuTrigger>

      <DropdownMenuContent side="right" align="end" sideOffset={10} className="w-max min-w-[236px] max-w-[300px]">
        <div className="flex items-center gap-2.5 border-b border-border px-[9px] pb-2.5 pt-1.5">
          <span className="grid size-[34px] shrink-0 place-items-center rounded-[9px] bg-[var(--portal-avatar-bg,#eaf0fe)] text-[11px] font-bold text-[var(--portal-avatar-fg,#1e4fd6)]">
            {initials}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[14px] font-semibold text-foreground">{displayName}</span>
            {email ? <span className="block truncate text-[12.5px] text-muted">{email}</span> : null}
          </span>
        </div>

        <DropdownMenuItem
          data-attr="portal-top-bar-settings"
          onSelect={(event) => {
            event.preventDefault();
            router.push(`${basePath}/profile`);
          }}
        >
          <Settings aria-hidden />
          Settings
        </DropdownMenuItem>

        {DARK_MODE_ENABLED ? (
          <div className="flex items-center justify-between gap-3 px-[9px] py-1.5">
            <span className="text-[14px] text-foreground">Appearance</span>
            <ThemeToggle />
          </div>
        ) : null}

        <div className="px-0">
          <PortalRoleSwitcher currentKind={kind} />
        </div>

        {onOpenHelp ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-attr="portal-account-help"
              onSelect={() => {
                setOpen(false);
                onOpenHelp();
              }}
            >
              <HelpCircle aria-hidden />
              Help &amp; feedback
            </DropdownMenuItem>
          </>
        ) : null}

        <DropdownMenuSeparator />

        <PortalSignOutButton
          onRequestConfirm={() => setOpen(false)}
          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[14px] font-medium text-[#d92d20] transition hover:bg-accent/70 disabled:opacity-60 lg:rounded-[6px] lg:px-[9px] lg:py-[7px] lg:font-normal"
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
