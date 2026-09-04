/**
 * Welcome email for approved applicants — server-side send (Resend) and optional mailto fallback.
 */

import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { residentSetupAccountUrl } from "@/lib/auth/resident-setup-token";
import { formatProplaneIdForDisplay } from "@/lib/manager-id";
import {
  appendManagerReachabilityToWelcomeBody,
  managerReachabilityWelcomeHtmlBlock,
  type ManagerReachabilityLines,
} from "@/lib/manager-reachability-for-resident";

export const RESIDENT_WELCOME_EMAIL_SUBJECT = "Your PropLane resident portal — account setup";

/**
 * Resident account / setup URL for emails.
 * Uses resolveEmailLinkBaseUrl so local/dev emails point at localhost while
 * production/preview still land on the canonical domain (never *.vercel.app).
 */
export function residentAccountCreationUrl(_origin: string, axisId: string, setupToken?: string): string {
  const base = resolveEmailLinkBaseUrl();
  const displayId = formatProplaneIdForDisplay(axisId);
  if (setupToken?.trim()) {
    return residentSetupAccountUrl(base, setupToken, displayId);
  }
  const id = displayId.trim();
  const params = new URLSearchParams({ proplane_id: id });
  return `${base}/auth/resident-setup?${params.toString()}`;
}

/** Full invitation text (e.g. copy/paste); too long for reliable mailto URLs in most clients. */
export function buildResidentWelcomeEmailBody(params: {
  residentName?: string;
  axisId: string;
  signupUrl: string;
  managerReachability?: ManagerReachabilityLines;
}): string {
  const greeting = params.residentName?.trim() ? `Hi ${params.residentName.trim()},` : "Hi,";
  const id = formatProplaneIdForDisplay(params.axisId);
  const base = [
    greeting,
    "",
    "Welcome to PropLane. Your rental application has been approved.",
    "",
    `Your PropLane ID: ${id}`,
    "",
    "Create your resident portal account here:",
    params.signupUrl,
    "",
    "What you can do in the resident portal:",
    "• Lease signing — review and sign your lease when your property sends it for signature.",
    "• Payments — see rent and charges, payment amounts, and any fines or fees your manager records.",
    "• Services — submit requests and work orders, and follow updates.",
    "• Move-in — your earliest move-in date, access instructions, parking, and other details for your room (once your listing includes them).",
    "",
    "Use the same email address you used on your rental application when you sign in. Continue with Google usually works when that email is a Gmail account.",
    "",
    "— PropLane",
  ];
  return appendManagerReachabilityToWelcomeBody(base, params.managerReachability ?? {}).join("\n");
}

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** HTML version for transactional email providers. */
export function buildResidentWelcomeEmailHtml(params: {
  residentName?: string;
  axisId: string;
  signupUrl: string;
  managerReachability?: ManagerReachabilityLines;
}): string {
  const greeting = params.residentName?.trim()
    ? `Hi ${escapeHtmlText(params.residentName.trim())},`
    : "Hi,";
  const id = escapeHtmlText(formatProplaneIdForDisplay(params.axisId));
  const href = escapeHtmlAttr(params.signupUrl);
  const urlPlain = escapeHtmlText(params.signupUrl);
  const reachBlock = managerReachabilityWelcomeHtmlBlock(params.managerReachability ?? {});
  /* Table-based CTA: best support across Gmail, Outlook, Apple Mail. */
  const ctaButton = `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:20px 0 8px 0">
<tr>
<td style="border-radius:10px;background:#2563eb">
<a href="${href}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 28px;font-family:system-ui,-apple-system,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;line-height:1.2">Create your resident portal account</a>
</td>
</tr>
</table>
<p style="margin:0 0 16px 0;font-size:13px;color:#64748b">If the button does not work, copy this link into your browser:<br/><span style="word-break:break-all;color:#334155">${urlPlain}</span></p>`;
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;font-family:system-ui,-apple-system,sans-serif;line-height:1.55;color:#0f172a;font-size:15px;background:#f8fafc">
<div style="max-width:36rem;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px 28px 32px;border:1px solid #e2e8f0">
<p style="margin:0 0 12px 0">${greeting}</p>
<p style="margin:0 0 12px 0">Welcome to PropLane. Your rental application has been approved.</p>
<p style="margin:0 0 8px 0"><strong>Your PropLane ID:</strong> ${id}</p>
${reachBlock}
${ctaButton}
<p style="margin:0 0 12px 0">You can use the portal for lease signing, payments, maintenance and add-on service requests, and move-in details your property shares with you.</p>
<p style="margin:0 0 12px 0">Use the same email address you used on your rental application when you create your account.</p>
<p style="margin:16px 0 0 0;color:#64748b;font-size:14px">— PropLane</p>
</div>
</body>
</html>`;
}

/** Shorter body so mailto: stays under typical browser/mail-client URL limits. */
function buildResidentWelcomeMailtoBody(params: {
  residentName?: string;
  axisId: string;
  signupUrl: string;
  managerReachability?: ManagerReachabilityLines;
}): string {
  const greeting = params.residentName?.trim() ? `Hi ${params.residentName.trim()},` : "Hi,";
  const id = formatProplaneIdForDisplay(params.axisId);
  const base = [
    greeting,
    "",
    "Your rental application was approved. Create your resident portal account using this link:",
    "",
    params.signupUrl,
    "",
    `Your PropLane ID: ${id}`,
    "",
    "Use the same email address you used on your rental application when you sign up.",
    "",
    "— PropLane",
  ];
  return appendManagerReachabilityToWelcomeBody(base, params.managerReachability ?? {}).join("\n");
}

export function buildResidentWelcomeMailtoHref(params: {
  residentEmail: string;
  residentName?: string;
  axisId: string;
  origin: string;
  setupToken?: string;
  managerReachability?: ManagerReachabilityLines;
}): string {
  const signupUrl = residentAccountCreationUrl(params.origin, params.axisId, params.setupToken);
  const body = buildResidentWelcomeMailtoBody({
    residentName: params.residentName,
    axisId: params.axisId,
    signupUrl,
    managerReachability: params.managerReachability,
  });
  const subject = encodeURIComponent(RESIDENT_WELCOME_EMAIL_SUBJECT);
  const encBody = encodeURIComponent(body);
  const to = encodeURIComponent(params.residentEmail.trim());
  return `mailto:${to}?subject=${subject}&body=${encBody}`;
}

/**
 * Opens the default mail client. Uses a real <a> click so SPA navigators do not swallow mailto:
 * the way `window.location.href = mailto` sometimes can in client-rendered apps.
 */
export function openMailtoHref(href: string): void {
  if (typeof document === "undefined") return;
  try {
    const a = document.createElement("a");
    a.href = href;
    a.rel = "noopener noreferrer";
    a.style.position = "fixed";
    a.style.left = "-9999px";
    a.setAttribute("aria-hidden", "true");
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch {
    if (typeof window !== "undefined") window.location.assign(href);
  }
}

export function openResidentWelcomeMailto(params: {
  residentEmail: string;
  residentName?: string;
  axisId: string;
  origin: string;
}): void {
  openMailtoHref(buildResidentWelcomeMailtoHref(params));
}
