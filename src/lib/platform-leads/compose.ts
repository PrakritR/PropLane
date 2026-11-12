import type { PlatformSource } from "@/lib/prospect-spine/contracts";
import { CHANNEL_CAPABILITIES } from "@/lib/platform-leads/capabilities";
import { normalizeE164 } from "@/lib/phone-e164";

const URL_PATTERN = /(?:https?:\/\/|www\.)\S+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|ai|io|co|us|app|me|info|biz|ly|link|uk|ca)\b(?:\/\S*)?/gi;
const EMAIL_PATTERN = /[a-z0-9._%+-]+\s?(?:@|\[at\]|\(at\))\s?[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
const PHONE_PATTERN = /(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b/g;

function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").replace(/\s+([,.!?;:])/g, "$1").trim())
    .filter((line, index, all) => line !== "" || (index > 0 && all[index - 1] !== ""))
    .join("\n")
    .trim();
}

/**
 * The reply as the site allows it (design-1112 §3.4). Strips what the site forbids and says what was removed, then adds the
 * property's details and, where a phone is allowed, "Please TEXT (206) 678-1909 and mention <CODE>". Pure.
 *
 *   - an email address is always removed (no site allows one in a message);
 *   - a link is removed where `allowsLinkInMessage` is false (Craigslist, Facebook, Roomster), and the listing link is
 *     added where it is true;
 *   - a phone number other than PropLane's own is removed everywhere; PropLane's own is kept (and added) only where
 *     `allowsPhoneInMessage` is true.
 */
export function composePlatformReply(input: {
  site: PlatformSource;
  answer: string;
  propertyLabel: string;
  roomLabel?: string | null;
  listingUrl: string | null;
  textNumberDisplay: string;
  stitchCode: string | null;
}): { body: string; removed: string[] } {
  const capability = CHANNEL_CAPABILITIES[input.site];
  const removed: string[] = [];
  const ownDigits = (normalizeE164(input.textNumberDisplay) ?? "").replace(/\D/g, "").slice(-10);
  let text = (input.answer ?? "").replace(/\r\n/g, "\n");

  if (EMAIL_PATTERN.test(text)) removed.push("email");
  text = text.replace(EMAIL_PATTERN, "");
  EMAIL_PATTERN.lastIndex = 0;

  const hadLink = URL_PATTERN.test(text);
  URL_PATTERN.lastIndex = 0;
  if (hadLink && !capability.allowsLinkInMessage) {
    removed.push("link");
    text = text.replace(URL_PATTERN, "");
  }
  URL_PATTERN.lastIndex = 0;

  text = text.replace(PHONE_PATTERN, (match) => {
    const digits = match.replace(/\D/g, "").slice(-10);
    if (capability.allowsPhoneInMessage && ownDigits && digits === ownDigits) return match;
    if (!removed.includes("phone")) removed.push("phone");
    return "";
  });
  text = tidy(text);

  const place = [input.propertyLabel.trim(), input.roomLabel?.trim()].filter(Boolean).join(", ");
  const lines: string[] = [text];
  if (place && !text.toLowerCase().includes(input.propertyLabel.trim().toLowerCase())) lines.push(`About: ${place}.`);
  if (capability.allowsLinkInMessage && input.listingUrl && !text.includes(input.listingUrl)) lines.push(`Listing: ${input.listingUrl}`);
  if (capability.allowsPhoneInMessage && input.textNumberDisplay.trim() && !text.includes(input.textNumberDisplay)) {
    lines.push(`Please TEXT ${input.textNumberDisplay.trim()}${input.stitchCode ? ` and mention ${input.stitchCode}` : ""} so we can answer quickly.`);
  } else if (capability.allowsPhoneInMessage && input.stitchCode && !text.includes(input.stitchCode)) {
    lines.push(`When you text, mention ${input.stitchCode}.`);
  }
  return { body: tidy(lines.filter(Boolean).join("\n")), removed };
}
