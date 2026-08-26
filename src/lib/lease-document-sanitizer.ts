import { LEASE_TEMPLATE_ROUTE } from "@/lib/lease-template-storage";
/**
 * The generated lease is rendered in an iframe for the resident and may be
 * exported as HTML. Manager edits therefore need a deliberately small HTML
 * language, not a browser's full document language.
 *
 * This module is dependency-free so the same policy runs in the browser store
 * and in the Node route handler before row_data is persisted.
 */

const ALLOWED_TAGS = new Set([
  // `a` and `object` carry the manager's uploaded lease. Their URL-bearing attributes are
  // accepted ONLY for the app's own authorizing lease-template route; see sanitizeAttribute.
  "a",
  "object",
  "html",
  "head",
  "body",
  "title",
  "meta",
  "style",
  "h1",
  "h2",
  "h3",
  "h4",
  "p",
  "div",
  "section",
  "span",
  "strong",
  "em",
  "b",
  "i",
  "br",
  "hr",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "blockquote",
  "sup",
  "sub",
]);

const ALLOWED_ATTRIBUTES = new Set([
  "class",
  "id",
  "lang",
  "dir",
  "style",
  "colspan",
  "rowspan",
  "width",
  "height",
  "scope",
  "charset",
  "name",
  "content",
  // Emitted by the disclosure engine to mark a legally required verbatim clause. It has to
  // survive a save: it is what preserveVerbatimDisclosureClauses uses to find the block.
  "data-disclosure-rule",
  // URL-bearing, and gated to the lease-template route in sanitizeAttribute.
  "href",
  "data",
  "target",
  "rel",
  "type",
]);

const BLOCKED_ELEMENTS = /<(?:script|iframe|embed|link|base|img|image|svg|math|form|input|button|audio|video|source|track|canvas|template)\b[^>]*>[\s\S]*?<\/(?:script|iframe|object|embed|link|base|img|image|svg|math|form|input|button|audio|video|source|track|canvas|template)\s*>/gi;
const BLOCKED_VOID_ELEMENTS = /<\/?(?:script|iframe|embed|link|base|img|image|svg|math|form|input|button|audio|video|source|track|canvas|template)\b[^>]*>/gi;
const TAG_TOKEN = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/g;
const VERBATIM_COMMENT = /^<!--\s*proplane-verbatim-disclosure:(?:start|end)(?::[A-Za-z0-9_-]+)?\s*-->$/i;
const VERBATIM_BLOCK = /<!--\s*proplane-verbatim-disclosure:start(?::([A-Za-z0-9_-]+))?\s*-->([\s\S]*?)<!--\s*proplane-verbatim-disclosure:end(?::\1)?\s*-->/gi;
/**
 * How the disclosure engine ACTUALLY marks a required clause: `<p data-disclosure-rule="id">`.
 * The comment-delimited form above was the anticipated shape and nothing emits it, so without
 * this pattern every statutory clause was freely editable and deletable through the editor.
 */
const DISCLOSURE_PARAGRAPH = /<p\b[^>]*\bdata-disclosure-rule=(?:"([^"]+)"|'([^']+)')[^>]*>[\s\S]*?<\/p\s*>/gi;

function isSafeCss(value: string): boolean {
  // CSS escapes would turn a string-only denylist into an external-load bypass.
  // The generated lease CSS uses neither escapes nor URL-bearing declarations.
  return !/\\|\0|<|>|https?:|\/\/|url\s*\(|(?:-webkit-)?image-set\s*\(|cross-fade\s*\(|@(?:import|font-face|namespace|document|page)\b|(?:expression|behavior|-moz-binding)\b|(?:javascript|vbscript|data)\s*:/i.test(
    value,
  );
}

function stripUnclosedStyleTail(value: string): string {
  const opens = [...value.matchAll(/<style\b[^>]*>/gi)];
  const lastOpen = opens.at(-1)?.index ?? -1;
  const closes = [...value.matchAll(/<\/style\s*>/gi)];
  const lastClose = closes.at(-1)?.index ?? -1;
  return lastOpen > lastClose ? value.slice(0, lastOpen) : value;
}

/**
 * A URL is acceptable only when it is the app's own lease-template route, root-relative and
 * anchored. Anchoring matters: a substring test would accept
 * `https://evil.example/?x=/api/portal/lease-template?path=…`.
 */
function isLeaseTemplateUrl(value: string): boolean {
  return value.startsWith(`${LEASE_TEMPLATE_ROUTE}?`);
}

function sanitizeAttribute(name: string, value: string, tagName: string): string | null {
  const normalized = name.toLowerCase();
  if (!ALLOWED_ATTRIBUTES.has(normalized) || normalized.startsWith("on")) return null;
  if (normalized === "charset" || normalized === "name" || normalized === "content") {
    if (tagName !== "meta") return null;
  }
  if (normalized === "href" || normalized === "data") {
    if (tagName !== "a" && tagName !== "object") return null;
    if (!isLeaseTemplateUrl(value)) return null;
  }
  if (normalized === "target" || normalized === "rel") {
    if (tagName !== "a") return null;
  }
  if (normalized === "type" && tagName !== "object") return null;
  if (normalized === "style") {
    return isSafeCss(value) ? ` style="${escapeAttribute(value)}"` : null;
  }
  return value ? ` ${normalized}="${escapeAttribute(value)}"` : ` ${normalized}`;
}

function escapeAttribute(value: string): string {
  // Only escape a bare `&`, never one that already begins an entity. Sanitizing is applied on
  // read AND on write, so a blind replace grew `&amp;` by one level on every cycle.
  return value
    .replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

/**
 * Per-pass tag sanitizer. `a` and `object` are dropped when their URL attribute did not
 * survive, so their closing tags must drop with them and ONLY with them: a valid template
 * link has to stay balanced. The count is per pass, which is why this is a factory.
 */
function makeTagSanitizer(): (token: string) => string {
  const urlTagDepth = { a: 0, object: 0 };
  return function sanitizeTag(token: string): string {
  if (token.startsWith("<!--")) return VERBATIM_COMMENT.test(token) ? token : "";
  const closing = /^<\//.test(token);
  const match = token.match(/^<\/?\s*([A-Za-z0-9-]+)/);
  const tagName = match?.[1]?.toLowerCase();
  if (!tagName || !ALLOWED_TAGS.has(tagName)) return "";
  if (closing) {
    if (tagName === "a" || tagName === "object") {
      const key = tagName as "a" | "object";
      if (urlTagDepth[key] <= 0) return "";
      urlTagDepth[key] -= 1;
      return `</${tagName}>`;
    }
    return `</${tagName}>`;
  }

  const rawAttributes = token.slice(match![0].length, token.endsWith("/>") ? -2 : -1);
  const attributes: string[] = [];
  const attributePattern = /([^\s="'<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const attribute of rawAttributes.matchAll(attributePattern)) {
    const name = attribute[1] ?? "";
    const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
    const safe = sanitizeAttribute(name, value, tagName);
    if (safe) attributes.push(safe);
  }
  // `a` and `object` exist here ONLY to carry the manager's uploaded lease through the
  // authorizing route. One whose URL attribute did not survive validation has no purpose, so
  // it is dropped rather than left behind as an inert shell. Its closing tag drops with it.
  if (tagName === "a" || tagName === "object") {
    if (!attributes.some((attr) => / (?:href|data)=/.test(attr))) return "";
    urlTagDepth[tagName as "a" | "object"] += 1;
  }
  return `<${tagName}${attributes.join("")}>`;
  };
}

/**
 * HTML ends a comment at `<!-->`, `<!--->` and `--!>` as well as at `-->`. A `<!--[\s\S]*?-->`
 * tokenizer does not model those, so a browser treats everything after one as LIVE MARKUP
 * while the tokenizer still sees a single opaque comment. That carried an event handler
 * straight through the allowlist. Rewrite them into ordinary terminators before tokenizing,
 * so whatever follows is sanitized like any other markup.
 */
function normalizeCommentTerminators(value: string): string {
  return value
    .replace(/<!--->/g, "<!---->")
    .replace(/<!-->/g, "<!---->")
    .replace(/--!>/g, "-->");
}

/** Whether the input already fits the document allowlist without byte changes. */
function isAlreadySafeLeaseDocument(value: string): boolean {
  if (BLOCKED_VOID_ELEMENTS.test(value)) return false;
  BLOCKED_VOID_ELEMENTS.lastIndex = 0;
  const styleBlocks = [...value.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)];
  const styleOpenCount = [...value.matchAll(/<style\b[^>]*>/gi)].length;
  if (styleBlocks.length !== styleOpenCount) return false;
  if (styleBlocks.some((match) => !isSafeCss(match[1] ?? ""))) return false;
  for (const token of value.matchAll(TAG_TOKEN)) {
    const source = token[0];
    if (source.startsWith("<!--")) {
      if (VERBATIM_COMMENT.test(source)) continue;
      // A comment carrying angle brackets is markup smuggling, not a comment.
      if (/[<>]/.test(source.slice(4, -3))) return false;
      continue;
    }
    const sanitized = makeTagSanitizer()(source);
    if (!sanitized) return false;
    // Normalise only insignificant whitespace and a self-closing slash while
    // comparing. Returning the original below preserves the exact signed bytes.
    const normalizedSource = source.replace(/\s+/g, " ").replace(/\s*\/?>$/, ">");
    const normalizedSanitized = sanitized.replace(/\s+/g, " ");
    if (normalizedSource !== normalizedSanitized) return false;
  }
  return true;
}

/** Remove executable markup, event handlers, URLs, and resource-loading tags. */
export function sanitizeLeaseDocumentHtml(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = normalizeCommentTerminators(value);
  // Byte preservation is only sound when normalization changed nothing. If it did, the
  // original still carries the abrupt terminator, so it must go through the rewrite.
  if (normalized === value && isAlreadySafeLeaseDocument(value)) return value;
  const withoutBlockedElements = stripUnclosedStyleTail(normalized)
    .replace(BLOCKED_ELEMENTS, "")
    .replace(BLOCKED_VOID_ELEMENTS, "")
    .replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, (block, css: string) => (isSafeCss(css) ? block : ""));
  const sanitized = withoutBlockedElements.replace(TAG_TOKEN, makeTagSanitizer());
  return sanitized.trim() || null;
}

type VerbatimClauseResult = { ok: true; html: string } | { ok: false; error: string };

/**
 * P7 supplies immutable clauses inside these comments. A manager may edit the
 * surrounding document but cannot remove or rewrite a marked clause. P7 has
 * not landed yet, so unmarked generated leases remain editable today.
 */
function preserveDisclosureParagraphs(originalHtml: string, editedHtml: string): VerbatimClauseResult {
  const originals = [...originalHtml.matchAll(DISCLOSURE_PARAGRAPH)];
  if (originals.length === 0) return { ok: true, html: editedHtml };

  // Keyed by rule id, so reordering the surrounding text is fine but losing a clause is not.
  const byRule = new Map<string, string>();
  for (const match of originals) byRule.set((match[1] ?? match[2])!.toLowerCase(), match[0]);

  const seen = new Set<string>();
  const restored = editedHtml.replace(DISCLOSURE_PARAGRAPH, (whole, dq: string, sq: string) => {
    const key = String(dq ?? sq ?? "").toLowerCase();
    const original = byRule.get(key);
    if (!original) return whole; // A forged id the original never had; the count check rejects it.
    seen.add(key);
    return original; // Restore the exact statutory bytes, whatever was typed over them.
  });

  for (const key of byRule.keys()) {
    if (!seen.has(key)) {
      return {
        ok: false,
        error: "Required disclosure clauses cannot be removed. Edit the surrounding text only.",
      };
    }
  }
  return { ok: true, html: restored };
}

/**
 * Re-insert disclosure paragraphs the visual editor accidentally deleted. The sanitizer then
 * restores their exact statutory bytes when the tag survived but the text changed.
 */
export function reinsertMissingDisclosureParagraphs(originalHtml: string, editedHtml: string): string {
  const originals = [...originalHtml.matchAll(DISCLOSURE_PARAGRAPH)];
  if (originals.length === 0) return editedHtml;

  let result = editedHtml;
  for (const match of originals) {
    const ruleId = (match[1] ?? match[2] ?? "").toLowerCase();
    if (!ruleId) continue;
    const present = new RegExp(`data-disclosure-rule=["']${ruleId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`, "i").test(
      result,
    );
    if (present) continue;
    const paragraph = match[0];
    if (/<\/body>/i.test(result)) {
      result = result.replace(/<\/body>/i, () => `${paragraph}\n</body>`);
    } else {
      result = `${result}\n${paragraph}`;
    }
  }
  return result;
}

export function preserveVerbatimDisclosureClauses(originalHtml: string, editedHtml: string): VerbatimClauseResult {
  const paragraphs = preserveDisclosureParagraphs(originalHtml, editedHtml);
  if (!paragraphs.ok) return paragraphs;
  editedHtml = paragraphs.html;
  const originals = [...originalHtml.matchAll(VERBATIM_BLOCK)];
  if (originals.length === 0) return { ok: true, html: editedHtml };
  const edited = [...editedHtml.matchAll(VERBATIM_BLOCK)];
  if (edited.length !== originals.length) {
    return { ok: false, error: "Required disclosure clauses cannot be removed. Edit the surrounding text only." };
  }
  const originalKeys = originals.map((match, index) => match[1] || String(index));
  const editedKeys = edited.map((match, index) => match[1] || String(index));
  if (originalKeys.some((key, index) => key !== editedKeys[index])) {
    return { ok: false, error: "Required disclosure clauses must remain in place and unchanged." };
  }
  let index = 0;
  const restored = editedHtml.replace(VERBATIM_BLOCK, () => originals[index++]![0]);
  return { ok: true, html: restored };
}

/** Apply the persisted allowlist after restoring any P7 immutable disclosure blocks. */
export function sanitizeManagerLeaseDocumentEdit(originalHtml: string, editedHtml: string): VerbatimClauseResult {
  // ORDER MATTERS, and getting it wrong reopened the hole twice.
  //
  // Checking clauses BEFORE sanitizing let a blocked wrapper (<form>, unclosed <style>) delete
  // a clause that had just been restored. Checking after, but matching with a regex while the
  // sanitizer NORMALIZES attributes, let a decoy `data-disclosure-rule = "x"` be invisible
  // going in and visible coming out, satisfying the check while the real clause was deleted.
  //
  // Sanitizing FIRST removes that discrepancy at the source: both sides are then in the
  // sanitizer's own normal form, so the regex sees exactly what the sanitizer produced.
  const sanitizedOriginal = sanitizeLeaseDocumentHtml(originalHtml) ?? "";
  const sanitizedEdit = sanitizeLeaseDocumentHtml(editedHtml);
  if (!sanitizedEdit) return { ok: false, error: "Lease HTML must contain allowed document content." };

  const protectedClauses = preserveVerbatimDisclosureClauses(sanitizedOriginal, sanitizedEdit);
  if (!protectedClauses.ok) return protectedClauses;
  const html = protectedClauses.html;

  // Re-verify AFTER sanitizing, not only before. Sanitizing deletes a blocked element and
  // everything inside it, so wrapping a protected clause in one (<form>, <button>, <template>,
  // an unclosed <style>, ...) let it be restored and then deleted, and the save was accepted.
  // Checking the FINAL bytes is the only check that cannot be routed around this way.
  // Verify the FINAL bytes carry each required clause's TEXT, not merely its id. Comparing id
  // sets let an empty decoy paragraph supply the id while the real clause was deleted.
  for (const match of sanitizedOriginal.matchAll(DISCLOSURE_PARAGRAPH)) {
    if (!html.includes(match[0])) {
      return {
        ok: false,
        error: "Required disclosure clauses cannot be removed. Edit the surrounding text only.",
      };
    }
  }
  return { ok: true, html };
}
