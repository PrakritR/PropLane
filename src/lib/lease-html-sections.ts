const H2_HEADING_RE = /<h2\b[^>]*>[\s\S]*?<\/h2>/gi;

export type LeaseHtmlSection = {
  id: string;
  title: string;
  headingHtml: string;
  bodyHtml: string;
};

const LEASE_DOCUMENT_HEADER_ID = "lease-document-header";

/** Pull embedded `<style>` rules so section visual editors match the lease PDF. */
export function extractLeaseDocumentStyles(html: string): string {
  const match = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  return match?.[1]?.trim() ?? "";
}

/**
 * Prefix lease document CSS so it can be embedded in the portal without leaking `body` / `html` rules.
 * Every selector (including those nested in `@media`) is prefixed with `scopeSelector`; `body`, `html`
 * and `*`-only roots become the scope itself. With `dropRootLayout`, a root rule keeps its typography
 * and colour but loses `max-width` / `margin` / `padding`, so the document look can be applied to a
 * fragment (a clause body) instead of a whole printed page.
 */
export function scopeLeaseDocumentStyles(
  css: string,
  scopeSelector: string,
  options: { dropRootLayout?: boolean } = {},
): string {
  const trimmed = css.trim();
  if (!trimmed) return "";

  const isRoot = (selector: string) => selector === "body" || selector === "html";
  const scopeOne = (raw: string): string => {
    const selector = raw.trim();
    if (!selector) return selector;
    if (isRoot(selector)) return scopeSelector;
    if (selector.startsWith("body ") || selector.startsWith("html ")) {
      return `${scopeSelector} ${selector.replace(/^(body|html)\s+/, "")}`;
    }
    return `${scopeSelector} ${selector}`;
  };

  const walk = (source: string): string => {
    let out = "";
    let i = 0;
    const n = source.length;
    while (i < n) {
      const open = source.indexOf("{", i);
      if (open === -1) break;
      const prelude = source.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < n && depth > 0) {
        if (source[j] === "{") depth += 1;
        else if (source[j] === "}") depth -= 1;
        j += 1;
      }
      const inner = source.slice(open + 1, depth === 0 ? j - 1 : j);
      i = j;
      if (prelude.startsWith("@")) {
        // @media / @supports nest rules; every other at-rule (@font-face, @page, @keyframes, @import)
        // is global by nature and has no place in an embedded fragment.
        if (/^@(media|supports)\b/i.test(prelude)) out += `${prelude} { ${walk(inner)} } `;
        continue;
      }
      const selectors = prelude.split(",").map((part) => part.trim()).filter(Boolean);
      if (!selectors.length) continue;
      let declarations = inner.trim();
      if (options.dropRootLayout && selectors.some(isRoot)) {
        declarations = declarations
          .split(";")
          .filter((decl) => decl.trim() && !/^\s*(max-width|margin|padding)\b/i.test(decl))
          .join(";");
        if (declarations) declarations += ";";
      }
      if (!declarations) continue;
      out += `${selectors.map(scopeOne).join(", ")} { ${declarations} } `;
    }
    return out;
  };

  return walk(trimmed).trim();
}

/**
 * Drop the document shell (`<!doctype>`, `<html>`, `<head>`, `<title>`, `<style>`, `<script>`, `<body>`
 * tags) from lease HTML before it is placed in the portal's own DOM. A `<style>` that survives
 * injection applies to the whole page, which is how the lease's serif / uppercase / underlined look
 * reached the step rail and every other surface around the editor. The document's rules reach the
 * editor only through {@link scopeLeaseDocumentStyles}.
 */
export function stripLeaseDocumentShell(fragment: string): string {
  // Run to a true fixpoint, like {@link stripHtmlTags}: removing a whole element can join the text
  // around it back into the tag it just split (`<scr` + `ipt>`), so a capped number of passes would
  // leave a reconstructed `<script` in the output (CodeQL js/incomplete-multi-character-sanitization).
  // Every replacement here only deletes, so the string shrinks on each pass and the loop terminates.
  //
  // Each removal that can rebuild a dangerous tag gets its own loop, compared against that one
  // replacement. Sharing a single loop across all four is not a complete sanitizer: the exit test
  // then sees the string only after the three later replacements have also run, so no individual
  // replacement is provably repeated until it stops matching.
  let out = fragment;
  let previous: string;
  let outerPrevious: string;
  do {
    outerPrevious = out;

    // Whole elements, contents included.
    do {
      previous = out;
      out = out.replace(/<(style|script|title|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
    } while (out !== previous);

    // Neither of these can re-form a tag on its own, but deleting one can: `<scr<html>ipt>` becomes
    // a fresh `<script>`, so the outer loop hands it back to the removals around them. Their position
    // between the two fixpoint loops is load-bearing - moving them changes what the stray-tag pass
    // below is able to consume in one bite.
    out = out.replace(/<!doctype[^>]*>/gi, "");
    out = out.replace(/<\/?(?:html|body)\b[^>]*>/gi, "");

    // Stray shell tags, including an unterminated trailing `<script`.
    do {
      previous = out;
      out = out.replace(/<\/?(?:style|script|head)\b[^>]*>?/gi, "");
    } while (out !== previous);
  } while (out !== outerPrevious);
  return out;
}

/**
 * Lease HTML made safe to drop into the portal's own DOM (never an iframe): every `<style>` block is
 * re-emitted scoped under `scopeSelector` and the document shell is removed. Display only - callers
 * hash and persist the original string, never this one.
 */
export function leaseHtmlForScopedDomDisplay(html: string, scopeSelector: string, options?: { dropRootLayout?: boolean }): string {
  const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map((m) => m[1] ?? "").join("\n");
  const scoped = css.trim() ? scopeLeaseDocumentStyles(css, scopeSelector, options) : "";
  return `${scoped ? `<style>${scoped}</style>` : ""}${stripLeaseDocumentShell(html)}`;
}

function stripHtmlTags(value: string): string {
  // `>?` so an unterminated `<script` is dropped too: `<[^>]+>` alone left it in
  // the "plain text". Run to a fixpoint rather than once: a single removal pass
  // over nested markup can re-form the tag it just split, so the loop is what
  // makes the strip sound (CodeQL js/incomplete-multi-character-sanitization).
  let stripped = value;
  let previous: string;
  do {
    previous = stripped;
    stripped = stripped.replace(/<[^>]*>?/g, "");
  } while (stripped !== previous);
  return stripped.replace(/\s+/g, " ").trim();
}

function decodeBasicEntities(value: string): string {
  // `&amp;` last: decoding it first turns `&amp;lt;` into `&lt;` and then into a
  // real `<` — a double unescape (CodeQL js/double-escaping).
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function slugifySectionTitle(title: string): string {
  return decodeBasicEntities(stripHtmlTags(title))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeLeaseHeadingText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Remove one `<h2>` section (and its body) by parsed section id. */
export function removeLeaseHtmlSection(html: string, sectionId: string): string {
  const sections = parseLeaseHtmlSections(html);
  if (!sections.length) return html;
  const next = sections.filter((s) => s.id !== sectionId);
  if (next.length === sections.length) return html;
  return rebuildLeaseHtmlFromSections(html, next);
}

/** Insert a new section immediately after `afterSectionId` (append when id is null or missing). */
export function insertLeaseHtmlSectionAfter(
  html: string,
  afterSectionId: string | null,
  { title, bodyHtml }: { title: string; bodyHtml: string },
): string {
  const trimmedTitle = title.trim();
  if (!html.trim() || !trimmedTitle) return html;
  const sections = parseLeaseHtmlSections(html);
  if (!sections.length) {
    return prependLeaseHtmlSection(html, { title: trimmedTitle, bodyHtml });
  }
  const headingHtml = `<h2>${escapeLeaseHeadingText(trimmedTitle)}</h2>`;
  const block = `${headingHtml}${bodyHtml}`;
  const idx =
    afterSectionId != null
      ? sections.findIndex((s) => s.id === afterSectionId)
      : sections.length - 1;
  if (idx < 0) return `${html}${block}`;
  const next = sections[idx + 1];
  if (next?.headingHtml) {
    const at = html.indexOf(next.headingHtml);
    if (at >= 0) return `${html.slice(0, at)}${block}${html.slice(at)}`;
  }
  return `${html}${block}`;
}

/** Replace the visible title in a section's `<h2>` while keeping body html. */
export function renameLeaseHtmlSectionTitle(html: string, sectionId: string, nextTitle: string): string {
  const sections = parseLeaseHtmlSections(html);
  const target = sections.find((s) => s.id === sectionId);
  if (!target || target.id === LEASE_DOCUMENT_HEADER_ID) return html;
  const title = nextTitle.trim();
  if (!title) return html;
  const nextHeading = `<h2>${escapeLeaseHeadingText(title)}</h2>`;
  return html.replace(target.headingHtml, nextHeading);
}

/** Insert a new `<h2>` section immediately before the first existing heading. */
export function prependLeaseHtmlSection(
  html: string,
  { title, bodyHtml }: { title: string; bodyHtml: string },
): string {
  const trimmedTitle = title.trim();
  if (!html.trim() || !trimmedTitle) return html;

  const sectionHtml = `<h2>${escapeLeaseHeadingText(trimmedTitle)}</h2>${bodyHtml}`;
  const firstHeadingIndex = html.search(/<h2\b/i);
  if (firstHeadingIndex < 0) return `${html}${sectionHtml}`;

  return `${html.slice(0, firstHeadingIndex)}${sectionHtml}${html.slice(firstHeadingIndex)}`;
}

/** Split generated lease HTML into editable sections (preamble + each `<h2>` block). */
export function parseLeaseHtmlSections(html: string): LeaseHtmlSection[] {
  if (!html.trim()) return [];

  const headings: Array<{ headingHtml: string; index: number }> = [];
  for (const match of html.matchAll(H2_HEADING_RE)) {
    if (match.index == null) continue;
    headings.push({ headingHtml: match[0], index: match.index });
  }
  if (!headings.length) return [];

  const firstHeadingIndex = headings[0]!.index;
  const sections: LeaseHtmlSection[] = [];
  const preamble = html.slice(0, firstHeadingIndex).trim();
  if (preamble) {
    sections.push({
      id: LEASE_DOCUMENT_HEADER_ID,
      title: "Lease header & summary",
      headingHtml: "",
      bodyHtml: html.slice(0, firstHeadingIndex),
    });
  }

  const slugCounts = new Map<string, number>();
  headings.forEach((heading, idx) => {
    const bodyStart = heading.index + heading.headingHtml.length;
    const bodyEnd = headings[idx + 1]?.index ?? html.length;
    const bodyHtml = html.slice(bodyStart, bodyEnd);
    const title = decodeBasicEntities(stripHtmlTags(heading.headingHtml));
    const baseSlug = slugifySectionTitle(title) || `section-${idx + 1}`;
    const seen = slugCounts.get(baseSlug) ?? 0;
    slugCounts.set(baseSlug, seen + 1);
    const id = seen === 0 ? baseSlug : `${baseSlug}-${seen + 1}`;
    sections.push({
      id,
      title,
      headingHtml: heading.headingHtml,
      bodyHtml,
    });
  });
  return sections;
}

/** Rebuild full lease HTML from the document head plus edited section bodies. */
export function rebuildLeaseHtmlFromSections(
  originalHtml: string,
  sections: readonly Pick<LeaseHtmlSection, "id" | "headingHtml" | "bodyHtml">[],
): string {
  const parsed = parseLeaseHtmlSections(originalHtml);
  if (!parsed.length || parsed.length !== sections.length) {
    return originalHtml;
  }

  let preamble = "";
  let offset = 0;
  if (parsed[0]?.id === LEASE_DOCUMENT_HEADER_ID) {
    preamble = sections[0]?.bodyHtml ?? "";
    offset = 1;
  } else {
    const firstHeadingIndex = originalHtml.search(/<h2\b/i);
    preamble = firstHeadingIndex >= 0 ? originalHtml.slice(0, firstHeadingIndex) : "";
  }

  const body = sections
    .slice(offset)
    .map((section, idx) => `${parsed[offset + idx]!.headingHtml}${section.bodyHtml}`)
    .join("");
  return `${preamble}${body}`;
}

export function applyLeaseSectionBodyEdits(
  originalHtml: string,
  edits: Readonly<Record<string, string>>,
): string {
  const parsed = parseLeaseHtmlSections(originalHtml);
  if (!parsed.length) return originalHtml;
  const next = parsed.map((section) =>
    edits[section.id] !== undefined ? { ...section, bodyHtml: edits[section.id]! } : section,
  );
  return rebuildLeaseHtmlFromSections(originalHtml, next);
}

const LEASE_VISUAL_EDIT_EXTRA_STYLE = `
.lease-visual-section-active { outline: 2px solid rgba(47, 107, 255, 0.75) !important; outline-offset: 4px; background: rgba(47, 107, 255, 0.06) !important; }
body[contenteditable="true"] { outline: none; }
body[contenteditable="true"]:focus { outline: none; }
p[data-disclosure-rule] {
  border-left: 3px solid #c2410c;
  padding: 0.35rem 0 0.35rem 0.65rem;
  margin: 0.6rem 0;
  background: rgba(255, 247, 237, 0.85);
  user-select: text;
}
p[data-disclosure-rule][contenteditable="false"] { cursor: default; }
`;

const LEASE_VISUAL_EDIT_SCRIPT = `
<script>
(function () {
  function bind() {
    document.querySelectorAll("[data-lease-section-id]").forEach(function (el) {
      if (el.getAttribute("data-lease-bound") === "1") return;
      el.setAttribute("data-lease-bound", "1");
      el.setAttribute("title", "Double-click to edit this section");
      el.addEventListener("dblclick", function () {
        var sectionId = el.getAttribute("data-lease-section-id");
        if (!sectionId) return;
        document.querySelectorAll("[data-lease-section-id]").forEach(function (node) {
          node.classList.toggle("lease-visual-section-active", node.getAttribute("data-lease-section-id") === sectionId);
        });
        el.scrollIntoView({ block: "nearest", behavior: "smooth" });
        parent.postMessage({ type: "lease-visual-section-focus", sectionId: sectionId }, "*");
      });
    });
    document.querySelectorAll("p[data-disclosure-rule]").forEach(function (el) {
      el.setAttribute("contenteditable", "false");
      el.setAttribute("title", "Required disclosure — edit the surrounding text only");
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }
})();
</script>`;

function injectLeaseSectionMarkers(
  html: string,
  options: { extraStyle: string; script: string },
): string {
  const sections = parseLeaseHtmlSections(html);
  if (!sections.length) return html;

  const styleBlock = options.extraStyle;
  const styledHtml = html.includes("</head>")
    ? html.replace("</head>", `<style>${styleBlock}</style></head>`)
    : `<style>${styleBlock}</style>${html}`;

  let preamble = "";
  let offset = 0;
  if (sections[0]?.id === LEASE_DOCUMENT_HEADER_ID) {
    preamble = `<section class="lease-preview-section" data-lease-section-id="${sections[0]!.id}">${sections[0]!.bodyHtml}</section>`;
    offset = 1;
  } else {
    const firstHeadingIndex = styledHtml.search(/<h2\b/i);
    preamble = firstHeadingIndex >= 0 ? styledHtml.slice(0, firstHeadingIndex) : "";
  }

  const body = sections
    .slice(offset)
    .map(
      (section) =>
        `${section.headingHtml}<section class="lease-preview-section" data-lease-section-id="${section.id}">${section.bodyHtml}</section>`,
    )
    .join("");

  const merged = `${preamble}${body}`;
  return merged.includes("</body>")
    ? merged.replace("</body>", `${options.script}</body>`)
    : `${merged}${options.script}`;
}

/** Serialize a live editor document back to stored lease HTML. */
export function serializeLeaseEditorDocument(doc: Document): string {
  const doctype = doc.doctype;
  const prefix = doctype
    ? `<!DOCTYPE ${doctype.name}${doctype.publicId ? ` PUBLIC "${doctype.publicId}"` : ""}${doctype.systemId ? ` "${doctype.systemId}"` : ""}>\n`
    : "<!DOCTYPE html>\n";
  return `${prefix}${doc.documentElement.outerHTML}`;
}

/** Full-document visual editor: section click posts focus; entire body is contentEditable in the host iframe. */
export function injectLeaseVisualEditDocument(html: string): string {
  return injectLeaseSectionMarkers(html, {
    extraStyle: LEASE_VISUAL_EDIT_EXTRA_STYLE,
    script: LEASE_VISUAL_EDIT_SCRIPT,
  });
}
