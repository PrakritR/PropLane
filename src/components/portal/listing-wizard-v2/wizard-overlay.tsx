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
    <div className="fixed inset-0 z-[80] flex items-start justify-center overflow-y-auto overscroll-contain bg-foreground/30 p-3 backdrop-blur-sm sm:p-6">
      <div className="w-full max-w-4xl">{children}</div>
    </div>,
    document.body,
  );
}
