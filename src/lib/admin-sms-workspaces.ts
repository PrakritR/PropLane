/**
 * Admin Communication's PropLane Service workspace placement of texts (client-safe).
 *
 * The text stream (`GET /api/admin/sms-conversations`) names every service workspace it can place a thread in and puts
 * each thread on one of them ("Unassigned" when none yet). The Filter popover's Workspace field reads that list from
 * here, so the inbox needs no second request for it.
 */
import { useSyncExternalStore } from "react";

export type AdminSmsWorkspace = { id: string; name: string };

export { ADMIN_SMS_UNASSIGNED_FILTER } from "@/lib/admin-sms-filter";

const ADMIN_SMS_ENDPOINT = "/api/admin/sms-conversations";

/** The text-stream URL for a Workspace filter value ("" = every workspace). */
export function adminSmsConversationsUrl(workspaceFilter: string): string {
  const value = workspaceFilter.trim();
  return value ? `${ADMIN_SMS_ENDPOINT}?workspaceId=${encodeURIComponent(value)}` : ADMIN_SMS_ENDPOINT;
}

/** Where a service workspace's own Communication opens a thread (the workspace cookie is set first by the Open action). */
export function adminWorkspaceThreadHref(conversationKey: string | null | undefined): string {
  const key = String(conversationKey ?? "").trim();
  return key ? `/portal/communication/active/${encodeURIComponent(key)}` : "/portal/communication/active";
}

let workspaces: AdminSmsWorkspace[] = [];
const listeners = new Set<() => void>();

export function publishAdminSmsWorkspaces(next: unknown): void {
  const list = Array.isArray(next)
    ? next
        .filter((w): w is AdminSmsWorkspace => Boolean(w) && typeof (w as AdminSmsWorkspace).id === "string" && typeof (w as AdminSmsWorkspace).name === "string")
        .map((w) => ({ id: w.id, name: w.name }))
    : [];
  if (JSON.stringify(list) === JSON.stringify(workspaces)) return;
  workspaces = list;
  for (const listener of listeners) listener();
}

const EMPTY: AdminSmsWorkspace[] = [];

export function useAdminSmsWorkspaces(): AdminSmsWorkspace[] {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    () => workspaces,
    () => EMPTY,
  );
}

type OpenFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * "Open in workspace": the same Open action Admin > Service uses (it checks the operator's standing and sets the
 * workspace cookie), then the property portal's Communication for that thread. Resolves to the href on success.
 */
export async function openAdminWorkspaceThread(
  args: { workspaceId: string; conversationKey?: string | null },
  deps: { fetch?: OpenFetch; navigate?: (href: string) => void } = {},
): Promise<{ ok: true; href: string } | { ok: false; error: string }> {
  const doFetch: OpenFetch = deps.fetch ?? ((input, init) => fetch(input, init));
  try {
    const res = await doFetch("/api/admin/service-workspaces", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "open", id: args.workspaceId }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) return { ok: false, error: body.error ?? "Could not open this workspace." };
    // A multi-role account would otherwise stop at the portal chooser; best effort, re-checked server-side.
    await doFetch("/api/auth/set-active-portal", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "manager" }),
    }).catch(() => undefined);
    const href = adminWorkspaceThreadHref(args.conversationKey);
    (deps.navigate ?? ((to: string) => window.location.assign(to)))(href);
    return { ok: true, href };
  } catch {
    return { ok: false, error: "Could not open this workspace." };
  }
}

/** Assign an unassigned PropLane-line lead to one service workspace (admin only; the route audits it). */
export async function assignLeadToServiceWorkspace(
  args: { leadId: string; workspaceId: string },
  deps: { fetch?: OpenFetch } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const doFetch: OpenFetch = deps.fetch ?? ((input, init) => fetch(input, init));
  try {
    const res = await doFetch(`/api/admin/unassigned-leads/${encodeURIComponent(args.leadId)}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "assign", workspaceId: args.workspaceId }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return res.ok ? { ok: true } : { ok: false, error: body.error ?? "Could not assign this lead." };
  } catch {
    return { ok: false, error: "Could not assign this lead." };
  }
}
