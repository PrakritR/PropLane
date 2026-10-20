import { fetchWithTimeout } from "@/lib/auth/fetch-with-timeout";

const TIMEOUT_MS = 25_000;

/**
 * Open a PropLane Service workspace in service mode: the admin route re-derives membership and sets the workspace
 * cookie, the manager portal is made the active one (a multi-role account would otherwise stop at the chooser), and
 * the page navigates fully so /portal reads the cookie. Returns an error message, or null when it navigated.
 */
export async function openServiceWorkspace(
  id: string,
  navigate: (href: string) => void = (href) => window.location.assign(href),
  opts: { isAdmin?: boolean } = {},
): Promise<string | null> {
  // A helper (not a platform admin) has no admin route: the ordinary workspace switch sets the same cookie and
  // re-derives membership, since a helper's seat is a normal shared workspace.
  if (opts.isAdmin === false) return selectWorkspaceAndGo(id, navigate, "Could not open this workspace.");
  try {
    const res = await fetchWithTimeout(
      "/api/admin/service-workspaces",
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "open", id }),
      },
      TIMEOUT_MS,
    );
    const json = (await res.json().catch(() => ({}))) as { href?: string; error?: string };
    if (!res.ok || !json.href) return json.error ?? "Could not open this workspace.";
    // Best effort, re-checked server-side. `keepWorkspace`: the cookie was just set on purpose.
    await fetchWithTimeout(
      "/api/auth/set-active-portal",
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "manager", keepWorkspace: true }),
      },
      TIMEOUT_MS,
    ).catch(() => undefined);
    navigate(json.href);
    return null;
  } catch {
    return "Could not open this workspace.";
  }
}

async function selectWorkspaceAndGo(id: string, navigate: (href: string) => void, failure: string): Promise<string | null> {
  try {
    const select = await fetchWithTimeout(
      "/api/workspaces",
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "select", id }),
      },
      TIMEOUT_MS,
    );
    if (!select.ok) return failure;
    await fetchWithTimeout(
      "/api/auth/set-active-portal",
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "manager", keepWorkspace: true }),
      },
      TIMEOUT_MS,
    ).catch(() => undefined);
    navigate("/portal/dashboard");
    return null;
  } catch {
    return failure;
  }
}

/**
 * Back to the Property portal from service mode: point the workspace cookie at the account's own workspace first, so
 * /portal renders it rather than the service workspace the cookie still names.
 */
export async function switchToPropertyPortal(
  workspaceId: string,
  navigate: (href: string) => void = (href) => window.location.assign(href),
): Promise<string | null> {
  try {
    const select = await fetchWithTimeout(
      "/api/workspaces",
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "select", id: workspaceId }),
      },
      TIMEOUT_MS,
    );
    if (!select.ok) return "Could not switch to the Property portal.";
    // The cookie now names the account's own workspace, so a plain manager switch has nothing left to reset.
    await fetchWithTimeout(
      "/api/auth/set-active-portal",
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "manager" }),
      },
      TIMEOUT_MS,
    ).catch(() => undefined);
    navigate("/portal/dashboard");
    return null;
  } catch {
    return "Could not switch to the Property portal.";
  }
}
