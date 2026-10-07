"use client";

import { PanelLeft, PanelRight, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  PortalCommandPalette,
  portalPaletteActions,
} from "@/components/portal/portal-command-palette";
import { useAssistantLauncher } from "@/components/portal/use-assistant-launcher";
import { usePortalJumpItems } from "@/components/portal/use-portal-jump-items";
import { useWorkspaces } from "@/components/portal/workspace-provider";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import {
  getPortalSidebarCollapsed,
  subscribePortalSidebarCollapsed,
  togglePortalSidebarCollapsed,
} from "@/lib/portal-sidebar-collapse-store";
import type { PortalDefinition, PortalKind } from "@/lib/portal-types";
import type { ResidentPortalNavStage } from "@/lib/resident-portal-nav";

/** "Ask PropLane or search <this>" for the portals that have no workspace to name. */
function portalDisplayName(kind: PortalKind): string {
  switch (kind) {
    case "resident":
      return "Resident portal";
    case "vendor":
      return "Vendor portal";
    case "admin":
      return "Admin portal";
    default:
      return "PropLane";
  }
}

/** A text field, a number field or a rich-text area owns its own Ctrl/Cmd+K. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

/**
 * A modal or menu already on screen keeps the keystroke and its focus trap.
 *
 * The same selector the inbox uses for "something else owns this key"
 * (`portal-inbox-ui.tsx`): the app's hand-rolled sheets and info panels carry
 * `role="dialog"` / `aria-modal` without Radix's `data-state`, so matching on
 * `data-state` alone would miss them.
 */
function hasOpenDialog(): boolean {
  if (typeof document === "undefined") return false;
  return Boolean(
    document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [aria-modal="true"]'),
  );
}

/**
 * The portal's top strip (desktop, `lg+`): a full-width 40px dark bar that
 * replaced the old header row. Left, the collapse-sidebar control; centre, the
 * "Ask PropLane or search <workspace>" bar (click it or press Cmd/Ctrl+K to open
 * the command palette); right, a button that opens the assistant panel. The
 * avatar / account menu moved to the bottom of the workspace rail, so nothing
 * else lives here. On phones and tablets this strip is hidden - the mobile nav
 * bar and the assistant FAB own those jobs.
 */
export function PortalTopBar({
  kind,
  basePath,
  definition,
  subscriptionTier,
  residentNavStage,
  initialSidebarCollapsed = false,
}: {
  kind: PortalKind;
  basePath: string;
  definition: PortalDefinition;
  subscriptionTier?: "free" | "paid" | null;
  residentNavStage?: ResidentPortalNavStage;
  initialSidebarCollapsed?: boolean;
  /** Retained for call-site compatibility; the account menu now lives in the rail. */
  name?: string | null;
  email?: string | null;
}) {
  const navigate = usePortalNavigate();
  const workspaces = useWorkspaces();
  const launcher = useAssistantLauncher();
  const jumpItems = usePortalJumpItems({ definition, subscriptionTier, residentNavStage });
  const [paletteOpen, setPaletteOpen] = useState(false);

  const collapsed = useSyncExternalStore(
    subscribePortalSidebarCollapsed,
    () => getPortalSidebarCollapsed(initialSidebarCollapsed),
    () => initialSidebarCollapsed,
  );

  const isWorkspacePortal = kind === "manager" || kind === "pro";
  const workspaceName = isWorkspacePortal && workspaces && !workspaces.loading ? workspaces.active?.name : undefined;
  const searchTarget = workspaceName?.trim() || portalDisplayName(kind);

  // Cmd/Ctrl+K opens (or closes) the palette. Only this shortcut is claimed, and
  // only when nothing else owns the keystroke: a field the manager is typing in
  // keeps its own Ctrl+K, and a dialog already on screen keeps its focus trap
  // rather than having the palette stacked over it.
  const paletteOpenRef = useRef(paletteOpen);
  useEffect(() => {
    paletteOpenRef.current = paletteOpen;
  }, [paletteOpen]);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key !== "k" && event.key !== "K") return;
      if (event.defaultPrevented) return;
      if (paletteOpenRef.current) {
        event.preventDefault();
        setPaletteOpen(false);
        return;
      }
      if (isEditableTarget(event.target)) return;
      if (hasOpenDialog()) return;
      event.preventDefault();
      setPaletteOpen(true);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const onAsk = useCallback((query: string) => launcher.ask(query), [launcher]);

  return (
    <header
      className="hidden h-10 shrink-0 items-center gap-2 bg-[var(--portal-strip-bg,#101828)] px-2.5 text-[var(--portal-strip-fg,#c7ccd6)] lg:flex"
      data-slot="portal-top-strip"
    >
      <button
        type="button"
        onClick={() => togglePortalSidebarCollapsed(initialSidebarCollapsed)}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-expanded={!collapsed}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        data-attr="portal-sidebar-toggle"
        className="grid size-7 min-h-0 shrink-0 place-items-center rounded-[6px] text-inherit opacity-85 outline-none transition hover:bg-white/10 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-white/50"
      >
        <PanelLeft className="size-4" strokeWidth={1.75} aria-hidden />
      </button>

      <button
        type="button"
        onClick={() => setPaletteOpen(true)}
        data-attr="portal-ask-proplane"
        aria-label="Ask PropLane or search"
        aria-haspopup="dialog"
        aria-keyshortcuts="Meta+K Control+K"
        className="mx-auto my-auto flex h-7 min-h-0 min-w-0 flex-[0_1_560px] cursor-pointer items-center gap-2 rounded-[7px] border border-white/[0.12] bg-white/10 px-2.5 text-[13px] text-inherit outline-none transition hover:bg-white/[0.16] focus-visible:ring-2 focus-visible:ring-white/50"
      >
        <Sparkles className="size-3.5 shrink-0 text-[#8fb0ff]" strokeWidth={1.75} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-left">Ask PropLane or search {searchTarget}</span>
        <kbd className="ml-auto shrink-0 rounded-[4px] border border-white/20 px-[5px] text-[11px] font-normal leading-4 opacity-80">
          ⌘K
        </kbd>
      </button>

      <button
        type="button"
        onClick={launcher.toggle}
        aria-label={launcher.assistantOpen ? "Close PropLane Assistant" : "Open PropLane Assistant"}
        aria-expanded={launcher.assistantVisible}
        title="PropLane Assistant"
        data-attr="portal-assistant-panel"
        className="grid size-7 min-h-0 shrink-0 place-items-center rounded-[6px] text-inherit opacity-85 outline-none transition hover:bg-white/10 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-white/50"
      >
        <PanelRight className="size-4" strokeWidth={1.75} aria-hidden />
      </button>

      <PortalCommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        jumpItems={jumpItems}
        actions={portalPaletteActions(basePath, kind)}
        onAsk={onAsk}
        onNavigate={navigate}
      />
    </header>
  );
}
