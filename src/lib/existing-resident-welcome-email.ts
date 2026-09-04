/**
 * Welcome email for manager-added existing residents (not application approval).
 */

import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { residentAccountCreationUrl } from "@/lib/resident-welcome-email";
import { formatProplaneIdForDisplay } from "@/lib/manager-id";
import {
  appendManagerReachabilityToWelcomeBody,
  managerReachabilityWelcomeHtmlBlock,
  type ManagerReachabilityLines,
} from "@/lib/manager-reachability-for-resident";

export const EXISTING_RESIDENT_WELCOME_EMAIL_SUBJECT =
  "Your PropLane resident portal — pay rent and manage your home";

export function buildExistingResidentWelcomeEmailBody(params: {
  residentName?: string;
  axisId: string;
  signupUrl: string;
  propertyLabel?: string;
  managerReachability?: ManagerReachabilityLines;
}): string {
  const greeting = params.residentName?.trim() ? `Hi ${params.residentName.trim()},` : "Hi,";
  const id = formatProplaneIdForDisplay(params.axisId);
  const propertyLine = params.propertyLabel?.trim()
    ? `You're set up for ${params.propertyLabel.trim()} on PropLane.`
    : "You're set up on PropLane as a resident.";
  const base = [
    greeting,
    "",
    propertyLine,
    "",
    "PropLane is your resident portal for day-to-day living at your property:",
    "",
    "• Payments — view rent and charges, pay through PropLane when your property accepts online payments, and track payment history.",
    "• Maintenance — submit service requests and follow updates from your property manager.",
    "• Documents — access your lease and other files your manager shares with you.",
    "• Move-in details — parking, access, and house information when your listing includes them.",
    "",
    "Your lease is already on file with your property manager — you do not need to complete an application or e-sign a lease in PropLane.",
    "",
    `Your PropLane ID: ${id}`,
    "",
    "Create your resident portal account here:",
    params.signupUrl,
    "",
    "Use the same email address on your lease or application when you sign in. Continue with Google usually works when that email is a Gmail account.",
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

export function buildExistingResidentWelcomeEmailHtml(params: {
  residentName?: string;
  axisId: string;
  signupUrl: string;
  propertyLabel?: string;
  managerReachability?: ManagerReachabilityLines;
}): string {
  const greeting = params.residentName?.trim()
    ? `Hi ${escapeHtmlText(params.residentName.trim())},`
    : "Hi,";
  const id = escapeHtmlText(formatProplaneIdForDisplay(params.axisId));
  const href = escapeHtmlAttr(params.signupUrl);
  const urlPlain = escapeHtmlText(params.signupUrl);
  const propertyLine = params.propertyLabel?.trim()
    ? `You're set up for <strong>${escapeHtmlText(params.propertyLabel.trim())}</strong> on PropLane.`
    : "You're set up on PropLane as a resident.";
  const reachBlock = managerReachabilityWelcomeHtmlBlock(params.managerReachability ?? {});
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
<p style="margin:0 0 12px 0">${propertyLine}</p>
<p style="margin:0 0 12px 0">Use PropLane to <strong>pay rent and charges</strong>, submit <strong>maintenance requests</strong>, and view <strong>documents</strong> your manager shares with you.</p>
<p style="margin:0 0 12px 0">Your lease is already on file — no application or e-sign step is required in the portal.</p>
<p style="margin:0 0 8px 0"><strong>Your PropLane ID:</strong> ${id}</p>
${reachBlock}
${ctaButton}
<p style="margin:0 0 12px 0">Use the same email address shown on your lease when you create your account.</p>
<p style="margin:16px 0 0 0;color:#64748b;font-size:14px">— PropLane</p>
</div>
</body>
</html>`;
}

export function buildExistingResidentWelcomeMailtoHref(params: {
  residentEmail: string;
  residentName?: string;
  axisId: string;
  origin: string;
  setupToken?: string;
  propertyLabel?: string;
  managerReachability?: ManagerReachabilityLines;
}): string {
  const signupUrl = residentAccountCreationUrl(
    params.origin || resolveEmailLinkBaseUrl(),
    params.axisId,
    params.setupToken,
  );
  const body = buildExistingResidentWelcomeEmailBody({
    residentName: params.residentName,
    axisId: params.axisId,
    signupUrl,
    propertyLabel: params.propertyLabel,
    managerReachability: params.managerReachability,
  });
  const subject = encodeURIComponent(EXISTING_RESIDENT_WELCOME_EMAIL_SUBJECT);
  return `mailto:${encodeURIComponent(params.residentEmail)}?subject=${subject}&body=${encodeURIComponent(body)}`;
}
