/**
 * Shared auth interstitial state (continue, OAuth finishes, the account check): a small centered spinner and one line
 * of text, nothing else. The auth layout already carries the PropLane mark top-left, so there is no second logo here.
 */
export function AuthOAuthLoading({
  label = "Loading your portal",
  caption,
}: {
  label?: string;
  caption?: string;
}) {
  return (
    <div className="flex min-h-[50dvh] flex-col items-center justify-center gap-4 py-10" role="status" aria-live="polite">
      <div className="h-7 w-7 animate-spin rounded-full border-2 border-primary/20 border-t-primary" aria-hidden />
      <p className="text-[15px] text-muted">{caption ?? `${label}…`}</p>
    </div>
  );
}
