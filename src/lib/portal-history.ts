/**
 * Whether a Back press can stay inside the app. A deep link (a bookmark, a link
 * pasted in chat, a fresh tab) has no earlier PropLane screen: `history.back()`
 * there leaves the site. The Navigation API answers exactly that (same-origin
 * entries only); where it is missing (Safari / older WebViews) the only safe
 * proof is a same-origin referrer on a document with history.
 */
export function canGoBackInApp(): boolean {
  if (typeof window === "undefined") return false;
  const navigation = (window as unknown as { navigation?: { canGoBack?: boolean } }).navigation;
  if (navigation && typeof navigation.canGoBack === "boolean") return navigation.canGoBack;
  if (window.history.length <= 1) return false;
  try {
    return Boolean(document.referrer) && new URL(document.referrer).origin === window.location.origin;
  } catch {
    return false;
  }
}
