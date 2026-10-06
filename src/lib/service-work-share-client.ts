import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { PublicBoardServiceView, PublicServiceView } from "@/lib/public-service-projection";
import type { VendorJobChoiceId } from "@/lib/vendor-job-choice";
import { syncManagerWorkOrdersFromServer } from "@/lib/manager-work-orders-storage";

/**
 * Browser-side callers for the vendor work share routes (vendor-work-share-1006). Each returns
 * `{ ok, ... }` with a plain error string - never throws - so a component can toast the message.
 */
type Fail = { ok: false; status: number; error: string };

async function postJson<T extends object>(url: string, body: unknown): Promise<({ ok: true } & T) | Fail> {
  try {
    const res = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) return { ok: false, status: res.status, error: data.error ?? "Something went wrong." };
    return { ok: true, ...(data as T) };
  } catch {
    return { ok: false, status: 0, error: "Could not reach PropLane. Check your connection." };
  }
}

export type PublishPatch = Pick<
  DemoManagerWorkOrderRow,
  "published" | "publishedAt" | "publishRef" | "publishBudgetCents" | "publishSharePhotos" | "biddingOpen" | "biddingOpenedAt"
>;

/** Manager: publish a service to the vendor work board. The patch is mirrored onto the local row by the caller. */
export function publishServiceToVendors(input: { workOrderId: string; budgetCents?: number | null; sharePhotos?: boolean }) {
  return postJson<{ published: true; patch: PublishPatch }>("/api/portal/service-publish", { ...input, action: "publish" });
}

export function unpublishServiceFromVendors(workOrderId: string) {
  return postJson<{ published: false }>("/api/portal/service-publish", { workOrderId, action: "unpublish" });
}

/** Manager: text a service link to a vendor's phone from the work number. */
export function sendServiceToPhone(input: {
  workOrderId: string;
  phone: string;
  recipientName?: string;
  sharePhotos?: boolean;
  attestWorksWithVendor: boolean;
}) {
  return postJson<{ expiresAt: string; sandbox?: { to: string; text: string; link: string; captured: number } }>(
    "/api/portal/service-share-link/send",
    input,
  );
}

/** Manager: kill every live link on a service. */
export function revokeServiceLinks(workOrderId: string) {
  return postJson<{ revoked: number }>("/api/portal/service-share-link/send", { workOrderId, revoke: true });
}

/** Vendor: Find work. */
export async function fetchBoardServices(filters: { trade?: string; radiusMi?: number } = {}): Promise<
  { ok: true; services: PublicBoardServiceView[] } | Fail
> {
  const params = new URLSearchParams();
  if (filters.trade) params.set("trade", filters.trade);
  if (filters.radiusMi) params.set("radiusMi", String(filters.radiusMi));
  try {
    const res = await fetch(`/api/vendor/work-board${params.size ? `?${params}` : ""}`, { credentials: "include", cache: "no-store" });
    const data = (await res.json().catch(() => ({}))) as { services?: PublicBoardServiceView[]; error?: string };
    if (!res.ok) return { ok: false, status: res.status, error: data.error ?? "Could not load work." };
    return { ok: true, services: Array.isArray(data.services) ? data.services : [] };
  } catch {
    return { ok: false, status: 0, error: "Could not reach PropLane. Check your connection." };
  }
}

/** Vendor: request a published job; `choice` only decides where the UI goes next. */
export async function requestBoardJob(ref: string, choice: VendorJobChoiceId) {
  const result = await postJson<{ workOrderId: string; choice: VendorJobChoiceId }>("/api/vendor/work-board", { ref, choice });
  // The offer now exists server-side; refresh the vendor's service cache so the job page the caller
  // navigates to next finds it instead of reading a stale list.
  if (result.ok) await syncManagerWorkOrdersFromServer({ force: true });
  return result;
}

/** Vendor (signed in): redeem a texted link. */
export async function redeemServiceLink(token: string, choice?: VendorJobChoiceId) {
  const result = await postJson<{ workOrderId: string; choice: VendorJobChoiceId; alreadyHeld: boolean }>("/api/vendor/service-link/redeem", {
    token,
    choice,
  });
  if (result.ok) await syncManagerWorkOrdersFromServer({ force: true });
  return result;
}

/** Public: the allowlist view behind a token. */
export async function fetchPublicService(token: string): Promise<
  { ok: true; service: PublicServiceView; state: "open" | "closed" } | Fail
> {
  try {
    const res = await fetch(`/api/public/service-link/${encodeURIComponent(token)}`, { cache: "no-store" });
    const data = (await res.json().catch(() => ({}))) as { service?: PublicServiceView; state?: "open" | "closed"; error?: string };
    if (!res.ok || !data.service) return { ok: false, status: res.status, error: data.error ?? "This link has expired or is no longer valid." };
    return { ok: true, service: data.service, state: data.state === "closed" ? "closed" : "open" };
  } catch {
    return { ok: false, status: 0, error: "Could not load this job." };
  }
}
