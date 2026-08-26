import { DEMO_NAVIGATE_EVENT, isDemoModeActive } from "@/lib/demo/demo-session";

/** Parse `/…/communication/{active|unread|archived}/{threadId}` from the current pathname. */
export function parseCommunicationThreadId(pathname: string, commBase: string): string | undefined {
  const base = commBase.replace(/\/$/, "");
  const prefix = `${base}/`;
  if (!pathname.startsWith(prefix)) return undefined;
  const segments = pathname.slice(prefix.length).split("/").filter(Boolean);
  if (segments.length < 2) return undefined;
  const segment = segments[0];
  if (segment !== "active" && segment !== "unread" && segment !== "archived") return undefined;
  const raw = segments[1]?.trim();
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function updateCommunicationUrl(href: string, mode: "replace" | "push") {
  if (typeof window === "undefined") return;
  if (isDemoModeActive()) {
    window.dispatchEvent(new CustomEvent(DEMO_NAVIGATE_EVENT, { detail: { href } }));
    return;
  }
  if (mode === "push") {
    window.history.pushState({ portalCommunicationThread: true }, "", href);
  } else {
    window.history.replaceState(window.history.state, "", href);
  }
}

/** Open a thread without remounting the Communication section (history push on first open). */
export function selectCommunicationThreadUrl(href: string, opts?: { replaceExisting?: boolean }) {
  updateCommunicationUrl(href, opts?.replaceExisting ? "replace" : "push");
}

/** Return to the conversation list without a full App Router navigation. */
export function clearCommunicationThreadUrl(listHref: string) {
  updateCommunicationUrl(listHref, "replace");
}
