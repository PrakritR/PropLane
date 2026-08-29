/**
 * Vendor invite email content — a manager inviting a vendor to create their PropLane
 * vendor account and link to the manager's vendor directory row.
 */

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function vendorInviteSubject(managerName: string): string {
  const name = managerName.trim() || "A property manager";
  return `Sign up for PropLane — vendor invite from ${name}`;
}

export function vendorRemovedSubject(managerName: string): string {
  const name = managerName.trim() || "A property manager";
  return `Vendor roster update from ${name}`;
}

export function buildVendorRemovedEmailBody(params: {
  vendorName?: string;
  managerName: string;
}): string {
  const greeting = params.vendorName?.trim() ? `Hi ${params.vendorName.trim()},` : "Hi,";
  const managerName = params.managerName.trim() || "A property manager";
  const lines = [
    greeting,
    "",
    `${managerName} removed you from their vendor roster on PropLane.`,
    "",
    "You will no longer receive new work orders from this manager through PropLane. If you have questions, reply to this message.",
    "",
    "— PropLane",
  ];
  return lines.join("\n");
}

export function buildVendorInviteEmailBody(params: {
  vendorName?: string;
  managerName: string;
  linkUrl: string;
}): string {
  const greeting = params.vendorName?.trim() ? `Hi ${params.vendorName.trim()},` : "Hi,";
  const managerName = params.managerName.trim() || "A property manager";
  const lines = [
    greeting,
    "",
    `${managerName} invited you to sign up for PropLane as a vendor so you can see work orders offered to you, track scheduled visits, and message them directly.`,
    "",
    "Sign up for PropLane here:",
    params.linkUrl,
    "",
    "— PropLane",
  ];
  return lines.join("\n");
}

export function buildVendorInviteEmailHtml(params: {
  vendorName?: string;
  managerName: string;
  linkUrl: string;
}): string {
  const greeting = params.vendorName?.trim() ? `Hi ${escapeHtmlText(params.vendorName.trim())},` : "Hi,";
  const managerName = escapeHtmlText(params.managerName.trim() || "A property manager");
  const href = escapeHtmlAttr(params.linkUrl);
  const urlPlain = escapeHtmlText(params.linkUrl);
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;font-family:system-ui,-apple-system,sans-serif;line-height:1.55;color:#0f172a;font-size:15px;background:#f8fafc">
<div style="max-width:36rem;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px;border:1px solid #e2e8f0">
<p style="margin:0 0 12px 0">${greeting}</p>
<p style="margin:0 0 16px 0"><strong>${managerName}</strong> invited you to <strong>sign up for PropLane</strong> as a vendor so you can see work orders offered to you, track scheduled visits, and message them directly.</p>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:8px 0 16px 0">
<tr><td style="border-radius:10px;background:#2563eb">
<a href="${href}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">Sign up for PropLane</a>
</td></tr></table>
<p style="margin:0;font-size:13px;color:#64748b">Or copy this link: <span style="word-break:break-all;color:#334155">${urlPlain}</span></p>
<p style="margin:16px 0 0 0;color:#64748b;font-size:14px">— PropLane</p>
</div>
</body>
</html>`;
}

export function buildVendorInviteMailtoHref(params: {
  to: string;
  vendorName?: string;
  managerName: string;
  linkUrl: string;
}): string {
  const subject = encodeURIComponent(vendorInviteSubject(params.managerName));
  const body = encodeURIComponent(
    buildVendorInviteEmailBody({ vendorName: params.vendorName, managerName: params.managerName, linkUrl: params.linkUrl }),
  );
  return `mailto:${encodeURIComponent(params.to.trim())}?subject=${subject}&body=${body}`;
}
