/**
 * F004/F016: pure section-level diff between a template's CURRENT content and
 * a freshly-PARSED (not yet applied) import. Shared by the application
 * template editor and the lease template editor so "N sections found · N
 * changed" and the changed-sections-only compare view can never drift between
 * the two.
 *
 * Deliberately dependency-free and side-effect-free: it never reads or writes
 * component state, storage, or the network. Callers resolve BOTH sides
 * (current + incoming) into this shape themselves, from whatever structure
 * their own domain already uses (resolved application fields grouped by
 * section, or a lease document's `{title, body}` sections).
 */

export type ImportSection = {
  /** Stable match key. Callers should pass a real id when they have one
   * (e.g. a `RentalApplicationSectionId`); otherwise omit it and the title
   * is normalized into one. Two sections with the same key are the "same"
   * section across current/incoming for diffing purposes. */
  key?: string;
  title: string;
  /** Stable text representation of the section's content. Any two calls
   * that would render the human the same content must produce the same
   * string, or a truly unchanged section will be reported as changed. */
  body: string;
};

export type SectionDiffStatus = "added" | "removed" | "changed" | "unchanged";

export type SectionDiffEntry = {
  key: string;
  title: string;
  status: SectionDiffStatus;
  currentBody: string | null;
  incomingBody: string | null;
};

export type SectionDiffSummary = {
  /** Sections the parse found — the "N sections found" half of the summary. */
  totalIncoming: number;
  /** added + removed + changed. A new/removed section always counts as changed. */
  changedCount: number;
  entries: SectionDiffEntry[];
};

function normalizeKey(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

function keyFor(section: ImportSection): string {
  const explicit = section.key?.trim();
  return explicit ? explicit : normalizeKey(section.title);
}

/**
 * Diff `current` (what the template holds today) against `incoming` (a
 * freshly parsed, not-yet-applied import). Matching is by `key` (or a
 * normalized title when no key is given) — never by array position, since an
 * inserted or removed section would otherwise misalign every section after it.
 */
export function diffImportSections(current: readonly ImportSection[], incoming: readonly ImportSection[]): SectionDiffSummary {
  const currentByKey = new Map<string, ImportSection>();
  for (const section of current) {
    // First occurrence wins on a duplicate key — callers are expected to pass
    // distinct keys, but a diff must still be deterministic if they do not.
    if (!currentByKey.has(keyFor(section))) currentByKey.set(keyFor(section), section);
  }

  const entries: SectionDiffEntry[] = [];
  const seenKeys = new Set<string>();

  for (const incomingSection of incoming) {
    const key = keyFor(incomingSection);
    seenKeys.add(key);
    const currentSection = currentByKey.get(key);
    if (!currentSection) {
      entries.push({ key, title: incomingSection.title, status: "added", currentBody: null, incomingBody: incomingSection.body });
    } else if (currentSection.body.trim() !== incomingSection.body.trim()) {
      entries.push({ key, title: incomingSection.title, status: "changed", currentBody: currentSection.body, incomingBody: incomingSection.body });
    } else {
      entries.push({ key, title: incomingSection.title, status: "unchanged", currentBody: currentSection.body, incomingBody: incomingSection.body });
    }
  }

  for (const [key, currentSection] of currentByKey) {
    if (seenKeys.has(key)) continue;
    entries.push({ key, title: currentSection.title, status: "removed", currentBody: currentSection.body, incomingBody: null });
  }

  const changedCount = entries.filter((entry) => entry.status !== "unchanged").length;
  return { totalIncoming: incoming.length, changedCount, entries };
}

/** The entries a "Compare" view should render — changed/added/removed only. */
export function changedSectionEntries(summary: SectionDiffSummary): SectionDiffEntry[] {
  return summary.entries.filter((entry) => entry.status !== "unchanged");
}
