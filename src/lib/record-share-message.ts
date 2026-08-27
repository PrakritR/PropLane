export type RecordShareKind = "lease" | "application";

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function recordShareSubject(kind: RecordShareKind, recordTitle: string): string {
  const label = recordTitle.trim() || (kind === "lease" ? "Lease" : "Application");
  return kind === "lease" ? `Lease document: ${label} — PropLane` : `Application: ${label} — PropLane`;
}

export function recordShareEmailBody(params: {
  kind: RecordShareKind;
  recordTitle: string;
  linkUrl: string;
  recipientName?: string;
  managerNote?: string;
}): string {
  const greeting = params.recipientName?.trim() ? `Hi ${params.recipientName.trim()},` : "Hi,";
  const docLabel = params.kind === "lease" ? "lease document" : "rental application";
  const lines = [
    greeting,
    "",
    `Your property manager shared a ${docLabel} with you on PropLane.`,
    "",
    `View it here: ${params.linkUrl}`,
    "",
    "Anyone with this link can open the document without signing in. The link expires in 14 days.",
  ];
  if (params.managerNote?.trim()) {
    lines.push("", `Note from your manager: ${params.managerNote.trim()}`);
  }
  lines.push("", "— PropLane");
  return lines.join("\n");
}

export function recordShareEmailHtml(params: {
  kind: RecordShareKind;
  recordTitle: string;
  linkUrl: string;
  recipientName?: string;
  managerNote?: string;
}): string {
  const text = recordShareEmailBody(params);
  const link = escapeHtmlText(params.linkUrl);
  const docLabel = params.kind === "lease" ? "lease document" : "rental application";
  const greeting = params.recipientName?.trim()
    ? `Hi ${escapeHtmlText(params.recipientName.trim())},`
    : "Hi,";
  const note = params.managerNote?.trim()
    ? `<p><strong>Note from your manager:</strong> ${escapeHtmlText(params.managerNote.trim())}</p>`
    : "";
  return `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">
<p>${greeting}</p>
<p>Your property manager shared a ${docLabel} with you on PropLane.</p>
<p><a href="${link}">Open the ${docLabel}</a></p>
<p style="font-size:13px;color:#555">Anyone with this link can view it without signing in. The link expires in 14 days.</p>
${note}
<p style="margin-top:24px;color:#777">— PropLane</p>
<pre style="display:none">${escapeHtmlText(text)}</pre>
</body></html>`;
}

export function recordShareSmsText(params: {
  kind: RecordShareKind;
  recordTitle: string;
  linkUrl: string;
  recipientName?: string;
  managerNote?: string;
}): string {
  const docLabel = params.kind === "lease" ? "lease" : "application";
  const greeting = params.recipientName?.trim() ? `Hi ${params.recipientName.trim()}, ` : "";
  const note = params.managerNote?.trim() ? ` ${params.managerNote.trim()}` : "";
  return `${greeting}View this ${docLabel} on PropLane: ${params.linkUrl}${note}`;
}
