/**
 * Apply-invite email for new resident accounts — server-side send (Resend).
 */

import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { managerOutboundFromHeader, sharedPortalFromAddress } from "@/lib/manager-outbound-identity.server";

export const RESIDENT_APPLY_INVITE_EMAIL_SUBJECT = "Complete your PropLane housing application";

export function residentApplyPortalUrl(applyPath?: string): string {
  const base = resolveEmailLinkBaseUrl();
  if (applyPath?.startsWith("/resident/")) {
    return `${base}${applyPath}`;
  }
  return `${base}/resident/applications`;
}

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function buildResidentApplyInviteEmailBody(params: {
  residentName?: string;
  applyUrl: string;
}): string {
  const greeting = params.residentName?.trim() ? `Hi ${params.residentName.trim()},` : "Hi,";
  return [
    greeting,
    "",
    "Welcome to PropLane. Your resident account is ready — complete your housing application to unlock your portal.",
    "",
    "Start your application here:",
    params.applyUrl,
    "",
    "You can browse available listings and choose a property and room as part of the application.",
    "",
    "— PropLane",
  ].join("\n");
}

export function buildResidentApplyInviteEmailHtml(params: {
  residentName?: string;
  applyUrl: string;
}): string {
  const greeting = params.residentName?.trim()
    ? `Hi ${escapeHtmlText(params.residentName.trim())},`
    : "Hi,";
  const href = escapeHtmlAttr(params.applyUrl);
  const urlPlain = escapeHtmlText(params.applyUrl);
  const ctaButton = `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:20px 0 8px 0">
<tr>
<td style="border-radius:10px;background:#2563eb">
<a href="${href}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 28px;font-family:system-ui,-apple-system,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;line-height:1.2">Complete your application</a>
</td>
</tr>
</table>
<p style="margin:0 0 16px 0;font-size:13px;color:#64748b">If the button does not work, copy this link into your browser:<br/><span style="word-break:break-all;color:#334155">${urlPlain}</span></p>`;
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;font-family:system-ui,-apple-system,sans-serif;line-height:1.55;color:#0f172a;font-size:15px;background:#f8fafc">
<div style="max-width:36rem;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px 28px 32px;border:1px solid #e2e8f0">
<p style="margin:0 0 12px 0">${greeting}</p>
<p style="margin:0 0 12px 0">Welcome to PropLane. Your resident account is ready — complete your housing application to unlock your portal.</p>
${ctaButton}
<p style="margin:0 0 12px 0">Browse available listings and choose a property and room as part of your application.</p>
<p style="margin:16px 0 0 0;color:#64748b;font-size:14px">— PropLane</p>
</div>
</body>
</html>`;
}

export async function sendResidentApplyInviteEmail(params: {
  to: string;
  residentName?: string;
  applyPath?: string;
  db?: SupabaseClient;
  managerUserId?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const to = params.to.trim().toLowerCase();
  if (!to.includes("@")) return { ok: false, error: "Invalid email." };

  const applyUrl = residentApplyPortalUrl(params.applyPath);
  const text = buildResidentApplyInviteEmailBody({
    residentName: params.residentName,
    applyUrl,
  });
  const html = buildResidentApplyInviteEmailHtml({
    residentName: params.residentName,
    applyUrl,
  });

  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, error: "Email delivery is not configured (set RESEND_API_KEY)." };
  }

  const from =
    params.db && params.managerUserId
      ? await managerOutboundFromHeader(params.db, params.managerUserId)
      : sharedPortalFromAddress();
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: RESIDENT_APPLY_INVITE_EMAIL_SUBJECT,
      text,
      html,
    }),
  });

  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { message?: string };
    return { ok: false, error: payload.message ?? res.statusText ?? "Resend request failed." };
  }

  return { ok: true };
}
