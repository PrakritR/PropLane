/**
 * `?compose=1` is a one-shot request ("open New message"), not page state.
 * The sidebar's New message button, the command palette and "Message the
 * manager" links all push `…/communication/active?compose=1`. If the flag stays
 * in the URL after the compose opens, closing the modal and clicking New
 * message again pushes the identical URL and nothing changes, so the second
 * click does nothing. Each opener therefore consumes the flag once it has acted
 * on it. `history.replaceState` is synced into `useSearchParams` by the App
 * Router, so the next push of `?compose=1` is a real change and fires again.
 */
export function consumeComposeQueryParam(): void {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("compose")) return;
    url.searchParams.delete("compose");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // A sandboxed frame can refuse history writes; the flag then simply stays.
  }
}
