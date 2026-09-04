import { residentAccountCreationUrl } from "@/lib/resident-welcome-email";

export const APPLICATION_SUBMITTED_EMAIL_SUBJECT = "Your PropLane application — create your resident account";
export const APPLICATION_SUBMITTED_CONFIRMATION_SUBJECT = "Your PropLane application was submitted";

export function applicationSubmittedEmailSubject(accountReady: boolean): string {
  return accountReady ? APPLICATION_SUBMITTED_CONFIRMATION_SUBJECT : APPLICATION_SUBMITTED_EMAIL_SUBJECT;
}

export function buildApplicationSubmittedEmailBody(params: {
  applicantName?: string;
  applicantEmail: string;
  axisId: string;
  signupUrl: string;
  propertyTitle?: string;
  accountReady?: boolean;
}): string {
  const greeting = params.applicantName?.trim() ? `Hi ${params.applicantName.trim()},` : "Hi,";
  const propertyLine = params.propertyTitle?.trim() ? ` for ${params.propertyTitle.trim()}` : "";
  if (params.accountReady) {
    return [
      greeting,
      "",
      `Thanks for submitting your rental application${propertyLine}.`,
      "We'll review it and get back to you.",
      "",
      `Your Application ID: ${params.axisId.trim()}`,
      "",
      "Track your application in the resident portal:",
      params.signupUrl,
      "",
      `Application email on file: ${params.applicantEmail.trim()}`,
      "",
      "— PropLane",
    ].join("\n");
  }
  return [
    greeting,
    "",
    `Thanks for submitting your rental application${propertyLine}.`,
    "We'll review it and get back to you.",
    "",
    `Your Application ID: ${params.axisId.trim()}`,
    "",
    "Create your resident portal account with this dedicated setup link (use the same email as your application):",
    params.signupUrl,
    "",
    `Application email on file: ${params.applicantEmail.trim()}`,
    "",
    "Your portal stays limited until your property manager reviews your application and fee. You can still create your account now to save your Application ID.",
    "",
    "— PropLane",
  ].join("\n");
}

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function buildApplicationSubmittedEmailHtml(params: {
  applicantName?: string;
  applicantEmail: string;
  axisId: string;
  signupUrl: string;
  propertyTitle?: string;
  accountReady?: boolean;
}): string {
  const greeting = params.applicantName?.trim()
    ? `Hi ${escapeHtmlText(params.applicantName.trim())},`
    : "Hi,";
  const propertyLine = params.propertyTitle?.trim()
    ? ` for <strong>${escapeHtmlText(params.propertyTitle.trim())}</strong>`
    : "";
  const href = escapeHtmlAttr(params.signupUrl);
  const urlPlain = escapeHtmlText(params.signupUrl);
  const ctaLabel = params.accountReady ? "Open resident portal" : "Create resident account";
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;font-family:system-ui,-apple-system,sans-serif;line-height:1.55;color:#0f172a;font-size:15px;background:#f8fafc">
<div style="max-width:36rem;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px;border:1px solid #e2e8f0">
<p style="margin:0 0 12px 0">${greeting}</p>
<p style="margin:0 0 12px 0">Thanks for submitting your rental application${propertyLine}.</p>
<p style="margin:0 0 12px 0">We'll review it and get back to you.</p>
<p style="margin:0 0 8px 0"><strong>Application ID:</strong> ${escapeHtmlText(params.axisId.trim())}</p>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:16px 0">
<tr><td style="border-radius:10px;background:#2563eb">
<a href="${href}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">${ctaLabel}</a>
</td></tr></table>
<p style="margin:0 0 12px 0;font-size:13px;color:#64748b">Use the same email as your application: ${escapeHtmlText(params.applicantEmail.trim())}</p>
<p style="margin:0;font-size:13px;color:#64748b">If the button does not work, copy this link:<br/><span style="word-break:break-all;color:#334155">${urlPlain}</span></p>
<p style="margin:16px 0 0 0;color:#64748b;font-size:14px">— PropLane</p>
</div>
</body>
</html>`;
}

export function buildApplicationSubmittedMailtoHref(params: {
  to: string;
  applicantName?: string;
  applicantEmail: string;
  axisId: string;
  origin: string;
  propertyTitle?: string;
  setupToken?: string;
  accountReady?: boolean;
}): string {
  const accountReady = Boolean(params.accountReady);
  const signupUrl = accountReady
    ? `${params.origin.replace(/\/$/, "")}/resident/applications`
    : residentAccountCreationUrl(params.origin, params.axisId, params.setupToken);
  const body = buildApplicationSubmittedEmailBody({
    applicantName: params.applicantName,
    applicantEmail: params.applicantEmail,
    axisId: params.axisId,
    signupUrl,
    propertyTitle: params.propertyTitle,
    accountReady,
  });
  return `mailto:${encodeURIComponent(params.to.trim())}?subject=${encodeURIComponent(applicationSubmittedEmailSubject(accountReady))}&body=${encodeURIComponent(body)}`;
}
