/**
 * Shared vendor-invite core: owning-manager check, pending-invite replacement,
 * `vendor_invites` token row, and the Resend email. Extracted from
 * `/api/portal/send-vendor-invite` so the manager UI route and the agent's
 * invite_vendor tool run the exact same pipeline (one implementation, not two).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { track } from "@/lib/analytics/posthog";
import { generateVendorInviteToken } from "@/lib/auth/provision-vendor-account";
import {
  buildVendorInviteEmailBody,
  buildVendorInviteEmailHtml,
  buildVendorInviteMailtoHref,
  vendorInviteSubject,
} from "@/lib/vendor-invite-email";

/**
 * 72 hours, not a week.
 *
 * This token IS an account: whoever opens the link sets a password and inherits
 * the vendor's directory row, offers and work-order history. That is a bearer
 * credential sitting in an inbox, sent to an address a human typed, and a
 * mistyped or auto-forwarded address stays exploitable for the whole window.
 * Three days is comfortable for a real vendor and a manager can re-send.
 */
const VENDOR_INVITE_TTL_MS = 72 * 60 * 60 * 1000;

export type VendorInviteDraft = {
  linkUrl: string;
  subject: string;
  text: string;
  html: string;
  mailtoHref: string;
};

type VendorInviteDraftResult =
  | { ok: true; draft: VendorInviteDraft }
  | { ok: false; status: 403 | 500; error: string };

/**
 * Mint (or replace) a pending vendor invite token and build the onboarding copy.
 * Does not send email — use {@link sendVendorInvite} for delivery.
 */
export async function createVendorInviteDraft(
  db: SupabaseClient,
  opts: {
    managerUserId: string;
    managerName: string;
    vendorId: string;
    vendorEmail: string;
    vendorName: string;
    origin: string;
  },
): Promise<VendorInviteDraftResult> {
  const { data: vendorRow } = await db
    .from("manager_vendor_records")
    .select("id, manager_user_id")
    .eq("id", opts.vendorId)
    .maybeSingle();
  if (!vendorRow || vendorRow.manager_user_id !== opts.managerUserId) {
    return { ok: false, status: 403, error: "Forbidden." };
  }

  await db.from("vendor_invites").delete().eq("vendor_directory_id", opts.vendorId).eq("status", "pending");
  const inviteToken = generateVendorInviteToken();
  const expiresAt = new Date(Date.now() + VENDOR_INVITE_TTL_MS).toISOString();
  const { error: insertError } = await db.from("vendor_invites").insert({
    manager_user_id: opts.managerUserId,
    vendor_directory_id: opts.vendorId,
    vendor_email: opts.vendorEmail,
    vendor_name: opts.vendorName || null,
    invite_token: inviteToken,
    expires_at: expiresAt,
  });
  if (insertError) return { ok: false, status: 500, error: insertError.message };

  const linkUrl = `${opts.origin}/auth/vendor-register?token=${encodeURIComponent(inviteToken)}`;
  const subject = vendorInviteSubject(opts.managerName);
  const text = buildVendorInviteEmailBody({ vendorName: opts.vendorName, managerName: opts.managerName, linkUrl });
  const html = buildVendorInviteEmailHtml({ vendorName: opts.vendorName, managerName: opts.managerName, linkUrl });
  const mailtoHref = buildVendorInviteMailtoHref({
    to: opts.vendorEmail,
    vendorName: opts.vendorName,
    managerName: opts.managerName,
    linkUrl,
  });

  return { ok: true, draft: { linkUrl, subject, text, html, mailtoHref } };
}

export type SendVendorInviteResult =
  | { ok: true; emailId: string | null; linkUrl: string }
  | { ok: false; status: 403 | 500; error: string }
  | { ok: false; status: 502 | 503; error: string; mailtoHref: string; linkUrl: string };

/**
 * Create (or replace) the pending invite for a vendor directory row and email
 * the signup link. `managerUserId` must be the authenticated actor — the
 * ownership check against the directory row happens here, so a caller can
 * never mint an invite for another manager's vendor.
 */
export async function sendVendorInvite(
  db: SupabaseClient,
  opts: {
    managerUserId: string;
    managerName: string;
    vendorId: string;
    vendorEmail: string;
    vendorName: string;
    origin: string;
  },
): Promise<SendVendorInviteResult> {
  const prepared = await createVendorInviteDraft(db, opts);
  if (!prepared.ok) {
    return { ok: false, status: prepared.status, error: prepared.error };
  }
  const { draft } = prepared;

  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    return {
      ok: false,
      status: 503,
      error: "Email delivery is not configured (set RESEND_API_KEY).",
      mailtoHref: draft.mailtoHref,
      linkUrl: draft.linkUrl,
    };
  }

  const from = process.env.RESEND_FROM?.trim() || "PropLane <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [opts.vendorEmail], subject: draft.subject, text: draft.text, html: draft.html }),
  });
  const payload = (await res.json().catch(() => ({}))) as { message?: string; id?: string };
  if (!res.ok) {
    return { ok: false, status: 502, error: payload.message ?? res.statusText, mailtoHref: draft.mailtoHref, linkUrl: draft.linkUrl };
  }

  track("vendor_invite_sent", opts.managerUserId, { vendor_id: opts.vendorId });
  return { ok: true, emailId: payload.id ?? null, linkUrl: draft.linkUrl };
}
