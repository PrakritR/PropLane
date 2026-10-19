import type { ReactNode } from "react";

/**
 * The one header every homepage section wears (captain feedback #15). Its text is the exact word in the top
 * bar — "How it works", "Software", "Service", "Pricing", "Contact" — and its size, weight and position come
 * from the single `.home-section-head` class (home-h1.css), so no section sizes its own.
 *
 * Usage: `<HomeSectionHeader id="home-xyz-title">Software</HomeSectionHeader>` as the first child of the
 * section's padded wrapper, and point the section's `aria-labelledby` at that id. A header that must carry
 * controls beside it (the pricing toggle) wraps it in `.home-section-head-row`.
 */
export function HomeSectionHeader({
  id,
  children,
  className = "",
}: {
  id?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <h2 id={id} className={`home-section-head ${className}`.trim()}>
      {children}
    </h2>
  );
}
