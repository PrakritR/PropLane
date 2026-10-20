"use client";

import { useId, useState, type ReactNode } from "react";

/**
 * Tablet and phone (up to 1024px) show plan cards and keep the full compare table behind this button, closed by
 * default; the table is the same server-rendered markup, so opening it reveals it in place. At 1025px and up the
 * button is hidden and the table is always drawn (CSS), exactly as before.
 */
export function HomePricingCompareReveal({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  return (
    <div className="home-compare-reveal" data-open={open}>
      <button
        type="button"
        className="home-compare-toggle"
        aria-expanded={open}
        aria-controls={panel}
        data-attr="pricing-compare-plans"
        onClick={() => setOpen((value) => !value)}
      >
        Compare plans
      </button>
      <div id={panel} className="home-compare-panel">
        {children}
      </div>
    </div>
  );
}
