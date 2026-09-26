/** Successful tool results are the only source of links in Luna portal replies. */
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

const URL_TOKEN = /https?:\/\/[^\s<>)\]]+|(?<![\w:/])\/[A-Za-z][^\s<>)\]]*/g;
const UNSUPPORTED_LINK = "I can't verify that link from the available records. Please ask me to check the relevant page or document.";
type MarkdownNode = { type: string; url?: string; children?: MarkdownNode[] };

function linkTargets(value: string): string[] {
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

function collectToolUrls(value: unknown, urls: Set<string>): void {
  if (typeof value === "string") {
    for (const target of linkTargets(value.trim())) urls.add(target);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectToolUrls(item, urls);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectToolUrls(item, urls);
  }
}

export function guardLunaReplyLinks(reply: string, successfulToolOutputs: unknown[]): string {
  const allowed = new Set<string>();
  for (const output of successfulToolOutputs) collectToolUrls(output, allowed);
  const linked = linkTargets(reply);
  if (linked.some((url) => !allowed.has(url))) {
    return UNSUPPORTED_LINK;
  }
  return reply;
}

/** An unresolved read error cannot support a factual answer, including partial reads. */
export function guardLunaFailedLookupClaim(reply: string, hasUnresolvedReadError: boolean): string {
  return hasUnresolvedReadError ? "I couldn't verify that from the available records. Please try again." : reply;
}
