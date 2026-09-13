import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { houseInfoRenderSections, houseInfoToPlainText, type HouseInfoV1 } from "@/lib/house-info";

export const MOVE_IN_REMINDER_SUBJECT = "Your move-in is tomorrow — here's what you need to know";

function residentPortalUrl(): string {
  return `${resolveEmailLinkBaseUrl()}/resident/dashboard`;
}
function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function buildMoveInReminderText(params: {
  residentName?: string;
  propertyLabel: string;
  addressLine: string;
  moveInDateLabel: string;
  instructions: string | null;
  generalHouseInfo: string | null;
  /** Structured house details. When present these replace the free-text dump. */
  houseInfo?: HouseInfoV1 | null;
}): string {
  const greeting = params.residentName?.trim() ? `Hi ${params.residentName.trim()},` : "Hi,";
  const lines = [
    greeting,
    "",
    `Your move-in at ${params.propertyLabel} is tomorrow, ${params.moveInDateLabel}.`,
  ];

  if (params.addressLine) {
    lines.push("", `Address: ${params.addressLine}`);
  }

  if (params.instructions) {
    lines.push("", "Move-in instructions:", params.instructions);
  }

  const houseInfoText = houseInfoToPlainText(params.houseInfo);
  if (houseInfoText) {
    lines.push("", houseInfoText);
  } else if (params.generalHouseInfo) {
    lines.push("", "House info:", params.generalHouseInfo);
  }

  lines.push(
    "",
    "Visit your resident portal to review your lease, charges, and any additional details:",
    residentPortalUrl(),
    "",
    "See you soon!",
    "",
    "— PropLane",
  );

  return lines.join("\n");
}

export function buildMoveInReminderHtml(params: {
  residentName?: string;
  propertyLabel: string;
  addressLine: string;
  moveInDateLabel: string;
  instructions: string | null;
  generalHouseInfo: string | null;
  /** Structured house details. When present these replace the free-text dump. */
  houseInfo?: HouseInfoV1 | null;
}): string {
  const greeting = params.residentName?.trim()
    ? `Hi ${escapeHtmlText(params.residentName.trim())},`
    : "Hi,";

  const addressRow = params.addressLine
    ? `<p style="margin:0 0 12px 0"><strong>Address:</strong> ${escapeHtmlText(params.addressLine)}</p>`
    : "";

  const instructionsSection = params.instructions
    ? `<p style="margin:0 0 4px 0"><strong>Move-in instructions:</strong></p>
<p style="margin:0 0 12px 0;white-space:pre-wrap">${escapeHtmlText(params.instructions)}</p>`
    : "";

  // Labelled rows beat a pasted paragraph: the door code and the Wi-Fi password
  // are what the resident is opening this email to find.
  const structuredSections = houseInfoRenderSections(params.houseInfo);
  const structuredHtml = structuredSections
    .map(
      (section) =>
        `<p style="margin:0 0 4px 0"><strong>${escapeHtmlText(section.label)}:</strong></p>
<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 12px 0;width:100%">${section.rows
          .map(
            (row) =>
              `<tr><td style="padding:2px 12px 2px 0;color:#64748b;font-size:14px;vertical-align:top;white-space:nowrap">${escapeHtmlText(row.label)}</td><td style="padding:2px 0;font-size:14px${row.copyable ? ";font-family:ui-monospace,Menlo,monospace" : ""}">${escapeHtmlText(row.value)}</td></tr>`,
          )
          .join("")}</table>`,
    )
    .join("");
  const otherHtml = params.houseInfo?.other.trim()
    ? `<p style="margin:0 0 12px 0;white-space:pre-wrap">${escapeHtmlText(params.houseInfo.other.trim())}</p>`
    : "";
  const legacyHtml = params.generalHouseInfo
    ? `<p style="margin:0 0 4px 0"><strong>House info:</strong></p>
<p style="margin:0 0 12px 0;white-space:pre-wrap">${escapeHtmlText(params.generalHouseInfo)}</p>`
    : "";
  const houseInfoSection = structuredHtml || otherHtml ? `${structuredHtml}${otherHtml}` : legacyHtml;

  const ctaButton = `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:20px 0 8px 0">
<tr>
<td style="border-radius:10px;background:#2563eb">
<a href="${escapeHtmlAttr(residentPortalUrl())}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 28px;font-family:system-ui,-apple-system,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;line-height:1.2">Open resident portal</a>
</td>
</tr>
</table>`;

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;font-family:system-ui,-apple-system,sans-serif;line-height:1.55;color:#0f172a;font-size:15px;background:#f8fafc">
<div style="max-width:36rem;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px 28px 32px;border:1px solid #e2e8f0">
<p style="margin:0 0 12px 0">${greeting}</p>
<p style="margin:0 0 12px 0">Your move-in at <strong>${escapeHtmlText(params.propertyLabel)}</strong> is tomorrow, <strong>${escapeHtmlText(params.moveInDateLabel)}</strong>.</p>
${addressRow}${instructionsSection}${houseInfoSection}${ctaButton}
<p style="margin:0 0 12px 0">Visit your resident portal to review your lease, charges, and any additional details.</p>
<p style="margin:16px 0 0 0;color:#64748b;font-size:14px">See you soon! — PropLane</p>
</div>
</body>
</html>`;
}
