/** Successful tool results are the only source of links in Luna portal replies. */
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

const URL_TOKEN = /https?:\/\/[^\s<>)\]]+|(?<![\w:/])\/[A-Za-z][^\s<>)\]]*/g;
export const UNSUPPORTED_LINK = "I can't verify that link from the available records. Please ask me to check the relevant page or document.";
type MarkdownNode = { type: string; url?: string; children?: MarkdownNode[] };

export function linkTargets(value: string): string[] {
  const linked = Array.from(value.matchAll(URL_TOKEN), (match) => cleanUrl(match[0]));
  const visit = (node: MarkdownNode): void => {
    if ((node.type === "link" || node.type === "image" || node.type === "definition") && node.url) linked.push(node.url);
    for (const child of node.children ?? []) visit(child);
  };
  visit(fromMarkdown(value, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }));
  return linked;
}

function cleanUrl(value: string): string {
  return value.replace(/[.,;:!?]+$/, "");
}

function isResearchResult(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (value as Record<string, unknown>).kind === "property_location_research";
}

function collectResearchUrls(research: Record<string, unknown>, urls: Set<string>): void {
  for (const source of research.verified === true && Array.isArray(research.sources) ? research.sources : []) {
    if (!source || typeof source !== "object") continue;
    const url = (source as { url?: unknown }).url;
    if (typeof url !== "string") continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" && !parsed.username && !parsed.password && parsed.href === url) urls.add(url);
    } catch { /* Invalid citations provide no link authority. */ }
  }
  const transit = research.mappedTransit;
  if (transit && typeof transit === "object" &&
    (transit as { verified?: unknown }).verified === true &&
    (transit as { source?: unknown }).source === "OpenStreetMap" &&
    (transit as { sourceUrl?: unknown }).sourceUrl === "https://www.openstreetmap.org/copyright") {
    urls.add("https://www.openstreetmap.org/copyright");
  }
}

function collectToolUrls(value: unknown, urls: Set<string>): void {
  if (isResearchResult(value)) {
    collectResearchUrls(value, urls);
    return;
  }
  if (typeof value === "string") {
    for (const target of linkTargets(value.trim())) urls.add(target);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectToolUrls(item, urls);
  } else if (value && typeof value === "object") {
    const output = value as Record<string, unknown>;
    if (isResearchResult(output.research)) {
      collectResearchUrls(output.research, urls);
      return;
    }
    for (const item of Object.values(output)) collectToolUrls(item, urls);
  }
}

/** Every link the tool results of this turn vouch for. */
export function allowedLinksFromToolOutputs(successfulToolOutputs: unknown[]): Set<string> {
  const allowed = new Set<string>();
  for (const output of successfulToolOutputs) collectToolUrls(output, allowed);
  return allowed;
}

/** The links in `reply` that no tool result (or `extraAllowed`) vouches for. Empty = the reply may be sent. */
export function unsupportedReplyLinks(reply: string, successfulToolOutputs: unknown[], extraAllowed: Iterable<string> = []): string[] {
  const allowed = allowedLinksFromToolOutputs(successfulToolOutputs);
  for (const url of extraAllowed) allowed.add(url);
  return linkTargets(reply).filter((url) => !allowed.has(url));
}

export function guardLunaReplyLinks(reply: string, successfulToolOutputs: unknown[], extraAllowed: Iterable<string> = []): string {
  if (unsupportedReplyLinks(reply, successfulToolOutputs, extraAllowed).length > 0) {
    return UNSUPPORTED_LINK;
  }
  return reply;
}

/** An unresolved read error cannot support a factual answer, including partial reads. */
export function guardLunaFailedLookupClaim(reply: string, hasUnresolvedReadError: boolean): string {
  return hasUnresolvedReadError ? "I couldn't verify that from the available records. Please try again." : reply;
}
