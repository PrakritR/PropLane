import { cookies } from "next/headers";

import { ASSISTANT_DOCK_COLLAPSED_COOKIE } from "@/lib/assistant-dock-cookie";

export { ASSISTANT_DOCK_COLLAPSED_COOKIE };

/** Persists the desktop assistant side-panel collapsed state for SSR (default collapsed). */
export async function getAssistantDockCollapsed(): Promise<boolean> {
  const store = await cookies();
  const raw = store.get(ASSISTANT_DOCK_COLLAPSED_COOKIE)?.value;
  if (raw === undefined) return true;
  return raw === "1";
}
