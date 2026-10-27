"use client";

/**
 * "Message the host" opens the resident's existing conversation with that home's host team (the tour card, then a box to
 * type in) instead of staging a compose draft. A conversation that is not stored yet, or a failed lookup, lands on the
 * Communication list: the resident is never stranded on a blank compose, and never gets a prefilled message they did not write.
 */
export async function residentTourThreadHref(basePath: string, inquiryId: string): Promise<string> {
  const list = `${basePath}/communication/active`;
  const id = inquiryId.trim();
  if (!id) return list;
  try {
    const res = await fetch(`/api/portal-resident-tours/thread?inquiryId=${encodeURIComponent(id)}`, { credentials: "include" });
    if (!res.ok) return list;
    const data = (await res.json().catch(() => ({}))) as { threadId?: unknown };
    const threadId = typeof data.threadId === "string" ? data.threadId.trim() : "";
    return threadId ? `${list}/${encodeURIComponent(threadId)}` : list;
  } catch {
    return list;
  }
}
