"use client";

import { STAY_META_CHANGED, normalizeStayMetaInput, type StayMeta } from "@/lib/channel-calendar/stay-meta";

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.trim()) return body.error;
  } catch {
    // not JSON
  }
  return fallback;
}

export async function fetchStayMetas(): Promise<StayMeta[]> {
  const res = await fetch("/api/portal/bookings/stay-meta", { cache: "no-store", credentials: "include" });
  if (!res.ok) throw new Error(await readError(res, "Could not load stay details."));
  const body = (await res.json()) as { metas?: unknown[] };
  return (body.metas ?? []).map(normalizeStayMetaInput).filter((meta): meta is StayMeta => meta !== null);
}

/** Saves notes/details for a signed-lease or application stay through the authenticated server route. */
export async function saveStayMeta(meta: StayMeta): Promise<void> {
  const res = await fetch("/api/portal/bookings/stay-meta", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(meta),
  });
  if (!res.ok) throw new Error(await readError(res, "Could not save stay details."));
  window.dispatchEvent(new Event(STAY_META_CHANGED));
}
