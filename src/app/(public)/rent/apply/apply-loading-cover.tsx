/**
 * The opaque screen the apply route shows while it works out where this visitor
 * belongs.
 *
 * Two things here are load-bearing, not styling:
 *
 *  - The public navbar and footer are rendered ABOVE this subtree by the public
 *    layout and cannot be unmounted from inside the route, so they are hidden by
 *    CSS instead. For a signed-in resident the marketing chrome is the WRONG
 *    PAGE — they are on their way to the portal, and seeing the marketing site
 *    paint and then reload is exactly what reads as the application link going
 *    back on itself. The rule lives in this component, so it applies only while
 *    this screen is mounted and reverts the moment the real page renders.
 *  - `position: fixed` does NOT work here. `PublicMainTransition` wraps every
 *    public page in `.animate-page-enter`, which animates `transform`, and a
 *    transformed ancestor becomes the containing block for fixed descendants —
 *    so a `fixed inset-0` cover was sized to the content column and faded in
 *    with the animation, leaving the chrome showing through. This fills the
 *    viewport in flow instead, and neutralises the entrance animation so the
 *    screen does not fade up before the hand-off.
 *
 * Rendered identically by the route's loading fallback and by
 * `ApplyPortalHandoff`, so the swap between the two frames is invisible.
 */
export function ApplyLoadingCover({ children }: { children?: React.ReactNode }) {
  return (
    <>
      <style>{`
        #axis-public-navbar { display: none !important; }
        footer { display: none !important; }
        .animate-page-enter { animation: none !important; opacity: 1 !important; transform: none !important; }
      `}</style>
      <div
        className="flex min-h-[100svh] w-full flex-col items-center justify-center gap-4 bg-[var(--pl-surface)] px-6 text-center"
        role="status"
        aria-live="polite"
        data-testid="apply-loading-cover"
      >
        <svg className="h-6 w-6 animate-spin text-primary" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
          <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
        <p className="text-sm font-semibold text-foreground">Loading application…</p>
        {children}
      </div>
    </>
  );
}
