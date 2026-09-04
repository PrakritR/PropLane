/**
 * How a resident reaches their manager's PropLane work line and assistant email.
 * Shared formatting for welcome emails and the resident Communication tab.
 */

export type ManagerReachabilityLines = {
  workPhoneLabel: string | null;
  assistantEmail: string | null;
};

export function hasManagerReachability(lines: ManagerReachabilityLines): boolean {
  return Boolean(lines.workPhoneLabel?.trim() || lines.assistantEmail?.trim());
}

export function managerReachabilityWelcomeParagraphs(lines: ManagerReachabilityLines): string[] {
  if (!hasManagerReachability(lines)) return [];
  const out = ["Reach your property manager:"];
  if (lines.workPhoneLabel?.trim()) out.push(`• Text: ${lines.workPhoneLabel.trim()}`);
  if (lines.assistantEmail?.trim()) out.push(`• Email: ${lines.assistantEmail.trim()}`);
  return out;
}

export function appendManagerReachabilityToWelcomeBody(
  bodyLines: string[],
  lines: ManagerReachabilityLines,
): string[] {
  const reach = managerReachabilityWelcomeParagraphs(lines);
  if (reach.length === 0) return bodyLines;
  const signupIdx = bodyLines.findIndex((line) => line.startsWith("Create your resident portal account"));
  if (signupIdx === -1) {
    return [...bodyLines, "", ...reach];
  }
  return [...bodyLines.slice(0, signupIdx), "", ...reach, "", ...bodyLines.slice(signupIdx)];
}

export function managerReachabilityWelcomeHtmlBlock(lines: ManagerReachabilityLines): string {
  if (!hasManagerReachability(lines)) return "";
  const items: string[] = [];
  if (lines.workPhoneLabel?.trim()) {
    items.push(`<li>Text: <strong>${escapeHtml(lines.workPhoneLabel.trim())}</strong></li>`);
  }
  if (lines.assistantEmail?.trim()) {
    const email = escapeHtml(lines.assistantEmail.trim());
    items.push(
      `<li>Email: <a href="mailto:${escapeHtmlAttr(lines.assistantEmail.trim())}" style="color:#2563eb;text-decoration:none"><strong>${email}</strong></a></li>`,
    );
  }
  return `<p style="margin:0 0 8px 0"><strong>Reach your property manager</strong></p><ul style="margin:0 0 16px 0;padding-left:1.25rem">${items.join("")}</ul>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
