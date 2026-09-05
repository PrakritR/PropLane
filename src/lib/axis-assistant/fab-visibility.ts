/** Matches Tailwind `lg` — used by layout chrome that is mobile-only. */
export const ASSISTANT_FAB_MOBILE_MQ = "(max-width: 1023px)";

/**
 * Whether the floating assistant trigger should be hidden. Communication shows
 * the FAB on the conversation list and hides it while a specific thread is open.
 */
export function shouldHideAssistantFab(): boolean {
  if (typeof document === "undefined") return false;
  const html = document.documentElement;
  if (html.hasAttribute("data-hide-assistant-fab")) return true;
  if (html.hasAttribute("data-modal-assistant-active")) return true;
  if (html.hasAttribute("data-rental-wizard-active")) return true;
  if (html.hasAttribute("data-communication-hide-assistant-fab")) return true;
  if (
    html.hasAttribute("data-communication-surface") &&
    (html.hasAttribute("data-communication-thread-reading") ||
      html.hasAttribute("data-communication-thread-selected"))
  ) {
    return true;
  }
  return false;
}

export function subscribeAssistantFabVisibility(onStoreChange: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const html = document.documentElement;
  const obs = new MutationObserver(onStoreChange);
  obs.observe(html, {
    attributes: true,
    attributeFilter: [
      "data-hide-assistant-fab",
      "data-modal-assistant-active",
      "data-rental-wizard-active",
      "data-communication-surface",
      "data-communication-hide-assistant-fab",
      "data-communication-thread-reading",
      "data-communication-thread-selected",
    ],
  });
  const mq = window.matchMedia(ASSISTANT_FAB_MOBILE_MQ);
  const onMq = () => onStoreChange();
  mq.addEventListener("change", onMq);
  return () => {
    obs.disconnect();
    mq.removeEventListener("change", onMq);
  };
}
