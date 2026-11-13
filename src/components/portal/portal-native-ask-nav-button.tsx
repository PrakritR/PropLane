"use client";

import { AxisAssistantChatIcon } from "@/components/portal/assistant-shared";
import {
  PORTAL_NATIVE_BOTTOM_NAV_ICON_SLOT_CLASS,
  PORTAL_NATIVE_BOTTOM_NAV_ITEM_CLASS,
  PORTAL_NATIVE_BOTTOM_NAV_LABEL_CLASS,
} from "@/lib/portal-layout-classes";

/**
 * The resident phone bar's "Ask" tab. It is the assistant, not a section: it opens the same full-screen assistant sheet the
 * top-bar icon opens, at every stage, and takes no route, so it never appears in a stage table.
 */
export function PortalNativeAskNavButton({
  open,
  unread,
  onClick,
}: {
  open: boolean;
  unread: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-attr="bottom-nav-ask"
      data-native-nav-ask=""
      onClick={onClick}
      className={`${PORTAL_NATIVE_BOTTOM_NAV_ITEM_CLASS} ${open ? "text-primary" : "text-muted"}`}
      aria-label={unread ? "Ask PropLane, new reply" : "Ask PropLane"}
      aria-expanded={open}
    >
      <span className={PORTAL_NATIVE_BOTTOM_NAV_ICON_SLOT_CLASS} aria-hidden>
        <span className={`inline-flex transition-opacity duration-200 ${open ? "opacity-100" : "opacity-60"}`}>
          <AxisAssistantChatIcon className="h-5 w-5" />
        </span>
        {unread ? (
          <span data-attr="bottom-nav-ask-unread" className="absolute -top-0.5 right-0 size-2 rounded-full bg-primary ring-2 ring-[var(--card,#fff)]" />
        ) : null}
      </span>
      <span className={`${PORTAL_NATIVE_BOTTOM_NAV_LABEL_CLASS} ${open ? "text-primary" : "text-muted"}`}>Ask</span>
    </button>
  );
}
