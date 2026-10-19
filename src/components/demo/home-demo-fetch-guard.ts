/**
 * The homepage Software demo's iframe renders the REAL portal panels, and some of them read or mirror to
 * authenticated `/api/*` routes the public page has no session for. Nothing in the sample may reach a server, so
 * for the lifetime of the embed every same-origin `/api/*` request is answered here, in the browser:
 * the sample workspace, an empty SMS directory, a quiet success for a write (so a panel keeps the local state it
 * just wrote), and "unavailable" for any other read (every reader keeps its local copy on a non-OK answer).
 * Router prefetches of portal pages are answered empty, and a real router navigation to a portal page (a control
 * the shell does not intercept) never resolves, so the sample can never leave itself for a sign-in page. Same
 * technique as the shell's own `portal-roles` shim.
 */
import { homeDemoWorkspacePayload } from "@/lib/demo/demo-guided-data";

const PORTAL_PAGE = /^\/(portal|resident|vendor|admin|auth|rent|owner)(\/|$)/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function answer(pathname: string, method: string): Response {
  if (method !== "GET") return json({ ok: true });
  if (pathname === "/api/demo/workspace") return json(homeDemoWorkspacePayload());
  if (pathname === "/api/manager/sms-conversations") return json({ residents: [] });
  // No linked Google Calendar in the sample: an empty, complete busy list (not "unavailable").
  if (pathname.endsWith("/google-calendar/events")) return json({ meetings: [] });
  return json({ error: "Sample portal" }, 503);
}

/**
 * Reused panels write portal addresses into the history (the Services stage tabs push `/portal/services/...`). Demo mode
 * is read off the page's pathname, so the sample keeps its own address and lets the panels keep their local state.
 */
function installHistoryGuard(): () => void {
  const { pushState, replaceState } = window.history;
  const keep = (url: string | URL | null | undefined) => (url && new URL(String(url), window.location.href).pathname === window.location.pathname ? url : undefined);
  window.history.pushState = (data, unused, url) => pushState.call(window.history, data, unused, keep(url));
  window.history.replaceState = (data, unused, url) => replaceState.call(window.history, data, unused, keep(url));
  return () => {
    window.history.pushState = pushState;
    window.history.replaceState = replaceState;
  };
}

export function installHomeDemoGuards(): () => void {
  if (typeof window === "undefined") return () => {};
  const restoreHistory = installHistoryGuard();
  const restoreFetch = installFetchGuard();
  return () => {
    restoreFetch();
    restoreHistory();
  };
}

function installFetchGuard(): () => void {
  const original = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    let url: URL | null = null;
    try {
      url = new URL(raw, window.location.href);
    } catch {
      url = null;
    }
    if (url && url.origin === window.location.origin) {
      if (url.pathname.startsWith("/api/")) return Promise.resolve(answer(url.pathname, method));
      if (PORTAL_PAGE.test(url.pathname)) {
        const headers = new Headers(init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined));
        if (headers.has("next-router-prefetch")) return Promise.resolve(new Response(null, { status: 204 }));
        return new Promise<Response>(() => {});
      }
    }
    return original(input, init);
  }) as typeof window.fetch;
  return () => {
    window.fetch = original;
  };
}
