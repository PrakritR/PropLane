"use client";

/**
 * Full-screen host for the listing wizard.
 *
 * It renders into `document.body` rather than in place. The portal's main
 * content area clips its overflow (see docs/portal-ui-system.md), and a clipped
 * ancestor also establishes the stacking context, so an overlay rendered inside
 * it sits UNDERNEATH the portal sidebar no matter how high its z-index goes —
 * which is exactly what happened before this existed. Escaping to the body is
 * the fix; a bigger z-index is not.
 */

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function ListingWizardOverlay({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
    // The page behind must not scroll while the wizard owns the screen.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);
  if (!mounted) return null;
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Listing editor"
      className="pointer-events-none fixed inset-0 z-[80] flex min-h-0 min-w-0 outline-none overscroll-contain bg-foreground/30 p-0 backdrop-blur-sm sm:p-4"
    >
      {/*
       * ModalAssistantStrip portals the assistant rail into the nearest
       * [role="dialog"]. Without this shell the rail fell through to body at
       * z-[72] — underneath this overlay at z-[80] — so Ask PropLane looked
       * broken. Same contract as Modal's data-modal-assistant-workspace.
       */}
      <div
        data-modal-assistant-workspace=""
        data-full-screen="true"
        className="pointer-events-none flex min-h-0 min-w-0 flex-1 items-stretch justify-center p-0"
      >
        <div className="pointer-events-auto h-full w-full max-w-[1560px]">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
