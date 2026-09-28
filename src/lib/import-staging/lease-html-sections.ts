/**
 * F016: best-effort recovery of `{title, body}` sections from a lease
 * template's CURRENT rendered HTML, so the import-staging diff has something
 * to compare a freshly parsed import against.
 *
 * Reuses `parseLeaseHtmlSections` (`@/lib/lease-html-sections`) — the same
 * `<h2>`-boundary splitter the lease document's own visual section editor
 * already relies on — rather than re-implementing HTML section splitting.
 * This module only adapts that shape into an `ImportSection` (plain-text
 * body, numbering-stripped title) for the diff.
 */

import { parseLeaseHtmlSections } from "@/lib/lease-html-sections";
import type { ImportSection } from "@/lib/import-staging/section-diff";

const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (match, entity: string) => ENTITY_MAP[entity] ?? match);
}

function htmlToPlainText(html: string): string {
  const withBreaks = html.replace(/<br\s*\/?>/gi, "\n");
  const paragraphs = [...withBreaks.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((match) => match[1]!);
  const source = paragraphs.length > 0 ? paragraphs.join("\n\n") : withBreaks;
  const stripped = source.replace(/<[^>]+>/g, "");
  return decodeEntities(stripped).replace(/[ \t]+\n/g, "\n").trim();
}

/**
 * Splits a lease document's HTML on its top-level `<h2>` headings, dropping
 * any preamble before the first heading (the parser never has a matching
 * concept for it, so it would otherwise show as a permanent, unmatchable
 * "removed" entry every time). A numbered heading ("1. Fees") has its
 * ordinal stripped so it matches the parser's own un-numbered title.
 */
export function extractLeaseSectionsFromHtml(html: string): ImportSection[] {
  return parseLeaseHtmlSections(html)
    .filter((section) => section.headingHtml.trim())
    .map((section) => {
      const title = section.title.replace(/^(?:\d+|[ivxlc]+)[.)]\s*/i, "").trim() || section.title;
      return { key: section.id, title, body: htmlToPlainText(section.bodyHtml) };
    });
}
