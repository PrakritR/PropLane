/**
 * Browser-side calls for Automations and the escalations inbox. Plain fetches (no shared GET cache):
 * a Send / Resolve must show the next state, never a cached one.
 */
import { fetchWithTimeout, PORTAL_READ_TIMEOUT_MS } from "@/lib/auth/fetch-with-timeout";
import type { EscalationItem, EscalationStatus } from "./escalations";
import type { AutomationAudience, AutomationMode, AutomationPresetId } from "./presets";

const JSON_HEADERS = { "Content-Type": "application/json" };

async function readJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export type AutomationRowView = {
  id: AutomationPresetId;
  label: string;
  audience: AutomationAudience;
  engine: "existing" | "automation";
  hasOwnText: boolean;
  modes: AutomationMode[];
  mode: AutomationMode;
  template: string;
  isDefaultTemplate: boolean;
  variables: Array<{ id: string; label: string }>;
};

export type HeldRunView = {
  id: string;
  preset: AutomationPresetId;
  audience: AutomationAudience;
  propertyId: string | null;
  body: string;
  createdAt: string;
};

export type AutomationsView = {
  canEdit: boolean;
  presets: AutomationRowView[];
  held: HeldRunView[];
  houses: Array<{ id: string; label: string }>;
};

export async function fetchAutomations(): Promise<AutomationsView | null> {
  try {
    const res = await fetchWithTimeout("/api/portal/automations", { credentials: "include" }, PORTAL_READ_TIMEOUT_MS);
    return res.ok ? await readJson<AutomationsView>(res) : null;
  } catch {
    return null;
  }
}

export async function saveAutomation(body: {
  preset: AutomationPresetId;
  mode?: AutomationMode;
  template?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetchWithTimeout(
      "/api/portal/automations",
      { method: "PUT", credentials: "include", headers: JSON_HEADERS, body: JSON.stringify(body) },
      PORTAL_READ_TIMEOUT_MS,
    );
    if (res.ok) return { ok: true };
    return { ok: false, error: (await readJson<{ error?: string }>(res))?.error ?? "Could not save." };
  } catch {
    return { ok: false, error: "Could not save." };
  }
}

export async function previewAutomation(
  preset: AutomationPresetId,
  template?: string,
): Promise<{ ok: true; text: string; usedRealData: boolean } | { ok: false; error: string }> {
  try {
    const res = await fetchWithTimeout(
      "/api/portal/automations/preview",
      { method: "POST", credentials: "include", headers: JSON_HEADERS, body: JSON.stringify({ preset, template }) },
      PORTAL_READ_TIMEOUT_MS,
    );
    const data = await readJson<{ text?: string; usedRealData?: boolean; error?: string }>(res);
    if (res.ok && data?.text !== undefined) return { ok: true, text: data.text, usedRealData: Boolean(data.usedRealData) };
    return { ok: false, error: data?.error ?? "Could not preview." };
  } catch {
    return { ok: false, error: "Could not preview." };
  }
}

export async function decideHeldRun(id: string, action: "send" | "dismiss"): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetchWithTimeout(
      `/api/portal/automations/runs/${encodeURIComponent(id)}`,
      { method: "POST", credentials: "include", headers: JSON_HEADERS, body: JSON.stringify({ action }) },
      PORTAL_READ_TIMEOUT_MS,
    );
    if (res.ok) return { ok: true };
    return { ok: false, error: (await readJson<{ error?: string }>(res))?.error ?? "Could not do that." };
  } catch {
    return { ok: false, error: "Could not do that." };
  }
}

export async function sendAnnouncement(body: {
  text: string;
  houseIds: string[] | "all";
  announcementId: string;
}): Promise<{ ok: true; sent: number; held: number; off: boolean } | { ok: false; error: string }> {
  try {
    const res = await fetchWithTimeout(
      "/api/portal/automations/announce",
      { method: "POST", credentials: "include", headers: JSON_HEADERS, body: JSON.stringify(body) },
      PORTAL_READ_TIMEOUT_MS,
    );
    const data = await readJson<{ error?: string; houses?: Array<{ outcome: string }> }>(res);
    if (!res.ok) return { ok: false, error: data?.error ?? "Could not send." };
    const houses = data?.houses ?? [];
    return {
      ok: true,
      sent: houses.filter((h) => h.outcome === "sent").length,
      held: houses.filter((h) => h.outcome === "held").length,
      off: houses.some((h) => h.outcome === "off"),
    };
  } catch {
    return { ok: false, error: "Could not send." };
  }
}

export async function fetchEscalations(status: EscalationStatus): Promise<EscalationItem[] | null> {
  try {
    const res = await fetchWithTimeout(
      `/api/portal/one-number/escalations?status=${status}`,
      { credentials: "include" },
      PORTAL_READ_TIMEOUT_MS,
    );
    if (!res.ok) return null;
    return (await readJson<{ items: EscalationItem[] }>(res))?.items ?? null;
  } catch {
    return null;
  }
}

export async function decideEscalation(id: string, action: "resolve" | "reopen"): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(
      "/api/portal/one-number/escalations",
      { method: "PATCH", credentials: "include", headers: JSON_HEADERS, body: JSON.stringify({ id, action }) },
      PORTAL_READ_TIMEOUT_MS,
    );
    return res.ok;
  } catch {
    return false;
  }
}
