/**
 * Email nudging an applicant to finish an in-progress rental application.
 */

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export const APPLICATION_COMPLETION_REMINDER_SUBJECT = "Finish your PropLane rental application";

export function buildApplicationCompletionReminderBody(params: {
  applicantName?: string;
  propertyTitle?: string;
  resumeUrl: string;
  signInUrl: string;
}): string {
  const greeting = params.applicantName?.trim() ? `Hi ${params.applicantName.trim()},` : "Hi,";
  const propertyLine = params.propertyTitle?.trim() ? ` for ${params.propertyTitle.trim()}` : "";
  return [
    greeting,
    "",
    `You started a rental application${propertyLine} on PropLane but have not submitted it yet.`,
    "",
    "Sign in with the same email you used when you started, then continue where you left off:",
    params.resumeUrl,
    "",
    "If you do not have a resident account yet, create one first (use the same application email), then open the link above:",
    params.signInUrl,
    "",
    "— PropLane",
  ].join("\n");
}

export function buildApplicationCompletionReminderHtml(params: {
  applicantName?: string;
  propertyTitle?: string;
  resumeUrl: string;
  signInUrl: string;
}): string {
  const greeting = params.applicantName?.trim() ? `Hi ${escapeHtmlText(params.applicantName.trim())},` : "Hi,";
  const propertyLine = params.propertyTitle?.trim()
    ? ` for <strong>${escapeHtmlText(params.propertyTitle.trim())}</strong>`
    : "";
  const resumeHref = escapeHtmlAttr(params.resumeUrl);
  const resumePlain = escapeHtmlText(params.resumeUrl);
  const signInHref = escapeHtmlAttr(params.signInUrl);
  const signInPlain = escapeHtmlText(params.signInUrl);
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;font-family:system-ui,-apple-system,sans-serif;line-height:1.55;color:#0f172a;font-size:15px;background:#f8fafc">
<div style="max-width:36rem;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px;border:1px solid #e2e8f0">
<p style="margin:0 0 12px 0">${greeting}</p>
<p style="margin:0 0 16px 0">You started a rental application${propertyLine} on PropLane but have not submitted it yet.</p>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 16px 0">
<tr><td style="border-radius:10px;background:#2563eb">
<a href="${resumeHref}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">Continue your application</a>
</td></tr></table>
<p style="margin:0 0 8px 0;font-size:13px;color:#64748b">Sign in with the same email you used when you started. If you need an account first:</p>
<p style="margin:0 0 16px 0;font-size:13px"><a href="${signInHref}" style="color:#2563eb">${signInPlain}</a></p>
<p style="margin:0;font-size:13px;color:#64748b">Or copy this link: <span style="word-break:break-all;color:#334155">${resumePlain}</span></p>
<p style="margin:16px 0 0 0;color:#64748b;font-size:14px">— PropLane</p>
</div>
</body>
</html>`;
}

export function buildApplicationCompletionReminderMailtoHref(params: {
  to: string;
  applicantName?: string;
  propertyTitle?: string;
  resumeUrl: string;
  signInUrl: string;
  subject?: string;
  bodyText?: string;
}): string {
  const subject = encodeURIComponent(params.subject?.trim() || APPLICATION_COMPLETION_REMINDER_SUBJECT);
  const body = encodeURIComponent(
    params.bodyText?.trim() ||
      buildApplicationCompletionReminderBody({
        applicantName: params.applicantName,
        propertyTitle: params.propertyTitle,
        resumeUrl: params.resumeUrl,
        signInUrl: params.signInUrl,
      }),
  );
  return `mailto:${encodeURIComponent(params.to.trim())}?subject=${subject}&body=${body}`;
}
