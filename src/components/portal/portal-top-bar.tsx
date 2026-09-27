"use client";

import { ChevronDown, Settings } from "lucide-react";
import { useRouter } from "next/navigation";
import { startTransition, useCallback, useEffect, useSyncExternalStore } from "react";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { DARK_MODE_ENABLED } from "@/lib/theme-storage";
import { PortalRoleSwitcher } from "@/components/portal/portal-role-switcher";
import { PortalSignOutButton } from "@/components/portal/portal-sign-out-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { track } from "@/lib/analytics/track-client";
import { AssistantDockExpandButton } from "@/components/portal/assistant-layout-controls";
import { ASSISTANT_DOCK_INPUT_ID } from "@/components/portal/assistant-dock-input-id";
import { useAxisAssistantDock } from "@/components/portal/axis-assistant";
import {
  collapseAssistantDock,
  getAssistantDockCollapsed,
  getAssistantDocked,
  subscribeAssistantDockCollapsed,
  subscribeAssistantDocked,
  toggleAssistantDock,
} from "@/lib/axis-assistant/dock-store";
import {
  closeAxisAssistant,
  getAxisAssistantOpen,
  openAxisAssistant,
  subscribeAxisAssistantOpen,
} from "@/lib/axis-assistant/open-store";
import type { PortalKind } from "@/lib/portal-types";

/**
 * The full-height assistant rail is the desktop destination for the top-bar
 * action and ⌘K. It is `lg`-only, so smaller viewports retain the popup fallback
 * rather than attempting to focus an off-screen composer.
 */
function initials(name: string | null, email: string | null): string {
  const src = (name ?? "").trim() || (email ?? "").trim();
  if (!src) return "?";
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

/**
 * Slim desktop top bar (`lg+`) with Ask PropLane and the account menu. On phones
 * and tablets, this bar is hidden — {@link PortalMobileNavBar} owns the page
 * title and profile avatar without a duplicate assistant strip above it.
 */
export function PortalTopBar({
  kind,
  basePath,
  name,
  email,
}: {
  kind: PortalKind;
  basePath: string;
  name: string | null;
  email: string | null;
}) {
  const router = useRouter();
  const displayName = (name ?? "").trim() || (email ?? "").trim() || "Account";
  const assistantOpen = useSyncExternalStore(
    subscribeAxisAssistantOpen,
    getAxisAssistantOpen,
    () => false,
  );
  const { dockable, mode, setMode } = useAxisAssistantDock();
  const dockCollapsed = useSyncExternalStore(
    subscribeAssistantDockCollapsed,
    getAssistantDockCollapsed,
    () => true,
  );
  const storeDocked = useSyncExternalStore(subscribeAssistantDocked, getAssistantDocked, () => false);
  const showCollapsedDockExpand =
    dockCollapsed && (dockable ? mode === "docked" : storeDocked);

  const openAskProPlane = useCallback(() => {
    track("assistant_opened");

    const dockInput = document.getElementById(ASSISTANT_DOCK_INPUT_ID) as HTMLTextAreaElement | null;
    if (dockInput?.offsetParent) {
      dockInput.focus();
      return;
    }

    // The rail is intentionally `lg`-only. On a wide, dock-enabled portal,
    // make it the active presentation and wait for React to mount its composer
    // before moving focus into it.
    if (dockable && window.matchMedia?.("(min-width: 1024px)").matches) {
      setMode("docked");
      closeAxisAssistant();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          (document.getElementById(ASSISTANT_DOCK_INPUT_ID) as HTMLTextAreaElement | null)?.focus();
        });
      });
      return;
    }

    startTransition(() => {
      openAxisAssistant();
    });
  }, [dockable, setMode]);

  function toggleAssistant() {
    const dockInput = document.getElementById(ASSISTANT_DOCK_INPUT_ID) as HTMLTextAreaElement | null;
    if (assistantOpen) {
      closeAxisAssistant();
      return;
    }
    // An open rail closes like its ✕: the docked preference stays.
    if (dockInput?.offsetParent) {
      collapseAssistantDock();
      return;
    }
    openAskProPlane();
  }

  // ⌘K / Ctrl+K opens the assistant, matching the visible keyboard chip. Only
  // this shortcut is claimed; nothing else in the app binds ⌘K.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key === "k" || event.key === "K")) {
        event.preventDefault();
        openAskProPlane();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openAskProPlane]);

  return (
    <header className="hidden h-14 shrink-0 items-center justify-end gap-3 border-b border-border bg-background px-4 sm:px-5 lg:flex">
      <button
        type="button"
        onClick={toggleAssistant}
        data-attr="portal-ask-proplane"
        aria-label={assistantOpen ? "Close PropLane Assistant" : "Ask PropLane"}
        aria-expanded={assistantOpen}
        aria-keyshortcuts="Meta+K Control+K"
        className="group flex items-center gap-2 rounded-full border border-border bg-card py-1.5 pl-2.5 pr-2 text-[13px] font-medium text-muted outline-none transition hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <span aria-hidden className="text-[13px] leading-none text-primary">
          ✦
        </span>
        <span className="tracking-[-0.01em]">Ask PropLane</span>
        <kbd className="ml-0.5 hidden items-center rounded-md border border-border bg-[var(--secondary)] px-1.5 py-0.5 text-[10.5px] font-medium leading-none text-muted lg:inline-flex">
          ⌘K
        </kbd>
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger
          className="hidden items-center gap-2 rounded-full border border-border bg-card py-1 pl-1 pr-2.5 text-foreground outline-none transition hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-primary/40 md:flex"
          aria-label="Account menu"
        >
          <span className="grid h-7 w-7 place-items-center rounded-full bg-gradient-to-br from-primary to-[var(--cobalt-deep,#16233f)] text-[12px] font-bold text-white">
            {initials(name, email)}
          </span>
          <ChevronDown className="h-4 w-4 text-muted" aria-hidden />
        </DropdownMenuTrigger>

        <DropdownMenuContent>
          <div className="border-b border-border px-3 pb-2.5 pt-1.5">
            <p className="truncate text-[13.5px] font-semibold text-foreground">{displayName}</p>
            {email ? <p className="truncate text-[12px] text-muted">{email}</p> : null}
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
            <div className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="text-[13.5px] font-medium text-foreground">Appearance</span>
              <ThemeToggle />
            </div>
          ) : null}

          <div className="px-1">
            <PortalRoleSwitcher currentKind={kind} />
          </div>

          <DropdownMenuSeparator />

          <PortalSignOutButton className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13.5px] font-medium text-red-600 transition hover:bg-accent/70 disabled:opacity-60" />
        </DropdownMenuContent>
      </DropdownMenu>

      {showCollapsedDockExpand ? <AssistantDockExpandButton onClick={toggleAssistantDock} /> : null}
    </header>
  );
}
