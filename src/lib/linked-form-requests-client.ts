import { resolveShareableAppOrigin } from "@/lib/app-url";
import type { LinkedFormRequestView } from "@/lib/application-linked-form-requests";

/**
 * Browser half of the linked-form routes. None of these ever sees a stored token: the only secret a response
 * carries is the one fresh share link a share/send action just minted, which the caller shows once.
 */

type Json = Record<string, unknown>;

async function call(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: Json }> {
  try {
    const res = await fetch(url, { credentials: "include", cache: "no-store", ...init });
    const body = ((await res.json().catch(() => ({}))) ?? {}) as Json;
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: {} };
  }
}

function errorOf(body: Json, fallback: string): string {
  return typeof body.error === "string" && body.error ? body.error : fallback;
}

export async function fetchLinkedFormsForApplication(applicationId: string): Promise<LinkedFormRequestView[]> {
  const res = await call(`/api/linked-form-requests?applicationId=${encodeURIComponent(applicationId)}`);
  return res.ok && Array.isArray(res.body.requests) ? (res.body.requests as LinkedFormRequestView[]) : [];
}

export type MyLinkedForms = { own: LinkedFormRequestView[]; helping: LinkedFormRequestView[] };

export async function fetchMyLinkedForms(): Promise<MyLinkedForms> {
  const res = await call("/api/linked-form-requests");
  if (!res.ok) return { own: [], helping: [] };
  return {
    own: Array.isArray(res.body.own) ? (res.body.own as LinkedFormRequestView[]) : [],
    helping: Array.isArray(res.body.helping) ? (res.body.helping as LinkedFormRequestView[]) : [],
  };
}

async function post(id: string, payload: Json) {
  return call(`/api/linked-form-requests/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/**
 * A link for one form, as a full URL on the canonical app origin (never the preview or lane host the
 * author happens to be on - the person who receives this link is not on it).
 *
 * `newLink` is the explicit "get a new link": it revokes whoever already holds one. The ordinary
 * share keeps the current helper's access, so re-showing the link never strands someone mid-form.
 */
export async function mintLinkedFormShareUrl(
  id: string,
  opts: { newLink?: boolean } = {},
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const res = await post(id, { action: "share", ...(opts.newLink ? { newLink: true } : {}) });
  if (!res.ok || typeof res.body.path !== "string") return { ok: false, error: errorOf(res.body, "Could not create a link.") };
  return { ok: true, url: `${resolveShareableAppOrigin(window.location.origin)}${res.body.path}` };
}

export async function sendLinkedFormByEmail(id: string, to: string): Promise<{ ok: boolean; error?: string }> {
  const res = await post(id, { action: "send_email", to });
  return res.ok ? { ok: true } : { ok: false, error: errorOf(res.body, "The email could not be sent.") };
}

export async function markLinkedFormNotNeededClient(id: string): Promise<{ ok: boolean; error?: string }> {
  const res = await post(id, { action: "not_needed" });
  return res.ok ? { ok: true } : { ok: false, error: errorOf(res.body, "Could not update this form.") };
}

export async function startLinkedFormFeeCheckout(id: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const res = await post(id, { action: "fee_checkout" });
  if (!res.ok || typeof res.body.url !== "string") return { ok: false, error: errorOf(res.body, "Could not start payment.") };
  return { ok: true, url: res.body.url };
}

export async function verifyLinkedFormFee(id: string, sessionId: string): Promise<{ ok: boolean; paid: boolean; error?: string }> {
  const res = await post(id, { action: "fee_verify", sessionId });
  if (!res.ok) return { ok: false, paid: false, error: errorOf(res.body, "Could not confirm payment.") };
  return { ok: true, paid: res.body.paid === true };
}

export type RedeemOutcome =
  | { kind: "ok"; path: string; formLabel: string }
  | { kind: "signin" }
  | { kind: "refused" };

/** The share page's one call. Every unusable link comes back as `refused`, with nothing about why. */
export async function redeemLinkedFormLink(token: string): Promise<RedeemOutcome> {
  const res = await call("/api/linked-form-requests/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (res.status === 401) return { kind: "signin" };
  if (!res.ok || typeof res.body.path !== "string") return { kind: "refused" };
  return { kind: "ok", path: res.body.path, formLabel: typeof res.body.formLabel === "string" ? res.body.formLabel : "Form" };
}

export async function fetchLinkedFormForFill(id: string): Promise<
  | {
      ok: true;
      request: LinkedFormRequestView;
      form: {
        signerAppId: string;
        signerFullName: string;
        templateId?: string;
        templateVersion?: number;
        config: unknown;
      } | null;
    }
  | { ok: false; status: number }
> {
  const res = await call(`/api/linked-form-requests/${encodeURIComponent(id)}`);
  if (!res.ok || !res.body.request) return { ok: false, status: res.status };
  return {
    ok: true,
    request: res.body.request as LinkedFormRequestView,
    form: (res.body.form as never) ?? null,
  };
}
