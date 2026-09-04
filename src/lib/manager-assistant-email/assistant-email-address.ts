import { randomBytes } from "node:crypto";

const ASSISTANT_LOCAL_PREFIX = "assistant";
const TOKEN_PATTERN = /^[a-zA-Z0-9_-]{8,24}$/;

export function assistantEmailDomain(): string {
  return (
    process.env.ASSISTANT_EMAIL_DOMAIN?.trim() ||
    process.env.INBOUND_EMAIL_DOMAIN?.trim() ||
    "prop-lane.space"
  ).toLowerCase();
}

export function assistantEmailAddress(token: string): string {
  return `${ASSISTANT_LOCAL_PREFIX}+${token}@${assistantEmailDomain()}`;
}

/** Extract inbox token from `assistant+<token>@…` in any To/Cc address. */
export function extractAssistantEmailToken(addresses: string[]): string | null {
  for (const raw of addresses) {
    const email = raw.trim().toLowerCase();
    const at = email.lastIndexOf("@");
    if (at <= 0) continue;
    const local = email.slice(0, at);
    const domain = email.slice(at + 1);
    if (domain !== assistantEmailDomain()) continue;
    const plus = local.indexOf("+");
    if (plus === -1) continue;
    const prefix = local.slice(0, plus);
    if (prefix !== ASSISTANT_LOCAL_PREFIX) continue;
    const token = local.slice(plus + 1);
    if (TOKEN_PATTERN.test(token)) return token;
  }
  return null;
}

export function isAssistantEmailAddress(addresses: string[]): boolean {
  return extractAssistantEmailToken(addresses) !== null;
}

export function generateAssistantEmailToken(): string {
  return randomBytes(9).toString("base64url").slice(0, 12);
}

export { TOKEN_PATTERN as ASSISTANT_EMAIL_TOKEN_PATTERN };
