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
    <div className="fixed inset-0 z-[80] flex items-stretch justify-center overscroll-contain bg-foreground/30 p-0 backdrop-blur-sm sm:p-4">
      {/*
       * The editor is a workspace, not a dialog: a step rail, the form, and the
       * panel showing what the manager just changed need the screen. Capping it
       * at max-w-4xl is what left no room for the third column.
       */}
      <div className="h-full w-full max-w-[1560px]">{children}</div>
    </div>,
    document.body,
  );
}
