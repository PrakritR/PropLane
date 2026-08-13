import type { GroupRole, RentalWizardFormState } from "./types";

export type { GroupRole } from "./types";

/**
 * Group applications
 * ------------------
 * A "group application" is several *independent* rental applications — each with its
 * own applicant, email, AXIS id, screening, and (once approved) its own resident
 * account and lease — tied together by a shared **Group ID** (`PROPLANE-…`).
 *
 * The first applicant generates the Group ID on submit and shares it; joining
 * applicants paste it in step 1 of the wizard. Nothing here merges the applications
 * into one record: the group is purely a reconciliation view computed by matching
 * `application.groupId` across rows, so each member keeps an independent account
 * while the manager (and the applicants) can see the household as a single bundle.
 *
 * This module is intentionally pure (no DOM / storage / demo imports) so it can be
 * unit-tested and reused from the wizard, the manager applications view, and the
 * resident portal.
 */

export const GROUP_ID_PREFIX = "PROPLANE-";
/** Pre-rebrand group ids; still accepted when pasted or stored on older applications. */
export const LEGACY_GROUP_ID_PREFIX = "AXISGRP-";

export const GROUP_ID_FORMAT_HINT = `${GROUP_ID_PREFIX}…`;

/** 32 unambiguous characters — a byte masked to 5 bits indexes it without modulo bias. */
const GROUP_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const GROUP_ID_RANDOM_LENGTH = 8;

/**
 * Random suffix for a Group ID. `crypto.getRandomValues` is available in insecure
 * contexts (plain-HTTP LAN dev, older WebViews) where `crypto.randomUUID` is not, so
 * an id minted there is still unguessable and collision-resistant rather than a
 * timestamp two simultaneous applicants could both mint.
 */
function randomGroupIdSuffix(): string {
  let out = "";
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(GROUP_ID_RANDOM_LENGTH);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) out += GROUP_ID_ALPHABET[byte & 31];
    return out;
  }
  while (out.length < GROUP_ID_RANDOM_LENGTH) {
    out += GROUP_ID_ALPHABET[Math.floor(Math.random() * GROUP_ID_ALPHABET.length)];
  }
  return out;
}

/**
 * Generate a shareable Group ID for the first applicant of a group application.
 * Format `PROPLANE-XXXXXXXX` — satisfies `validateAxisGroupId`
 * (prefix + length ≥ 12) in `../../app/(public)/rent/apply/apply-validation`.
 */
export function makeApplicationGroupId(): string {
  return `${GROUP_ID_PREFIX}${randomGroupIdSuffix()}`;
}

/** Canonical form for matching/storing a Group ID (case-insensitive, trimmed). */
export function normalizeGroupId(raw: string | null | undefined): string {
  return (raw ?? "").trim().toUpperCase();
}

/** True when this application form declares group membership with a usable shared id. */
export function applicationHasGroup(app: Partial<RentalWizardFormState> | null | undefined): boolean {
  if (!app) return false;
  return app.applyingAsGroup === "yes" && normalizeGroupId(app.groupId).length > 0;
}

/**
 * Resolve (or mint) the Group ID stored on a form at submit time. The first applicant
 * gets a freshly generated id when they have not been assigned one yet; joining
 * applicants keep the id they pasted. Non-group applications resolve to "".
 */
export function resolveSubmitGroupId(
  form: Pick<RentalWizardFormState, "applyingAsGroup" | "groupRole" | "groupId">,
  mint: () => string = makeApplicationGroupId,
): string {
  if (form.applyingAsGroup !== "yes") return "";
  const existing = form.groupId.trim();
  if (existing) return existing;
  if (form.groupRole === "first") return mint();
  return "";
}

/**
 * Resolve the Group ID when an ALREADY SUBMITTED application is re-saved from an editor.
 * The persisted id is the fallback, so a step-1 re-selection that blanks the field cannot
 * silently drop a group member out of their household. A group keeps one id for its
 * lifetime — nothing is re-minted here except for an application that opts into a group
 * as the first applicant and has never had an id at all. Switching `applyingAsGroup` to
 * "no" remains a deliberate opt-out and still clears the id.
 */
export function resolveEditGroupId(
  form: Pick<RentalWizardFormState, "applyingAsGroup" | "groupRole" | "groupId">,
  persistedGroupId: string | null | undefined,
  mint: () => string = makeApplicationGroupId,
): string {
  const existing = form.groupId.trim() || (persistedGroupId ?? "").trim();
  return resolveSubmitGroupId({ ...form, groupId: existing }, mint);
}

export type ApplicationGroupMemberStatus =
  | "in_progress"
  | "submitted"
  | "screening"
  | "flagged"
  | "screened"
  | "approved"
  | "rejected";

/** One application row reduced to what group reconciliation needs. */
export type GroupRowInput = {
  id: string;
  name: string;
  email: string;
  role: GroupRole;
  /** Raw `application.groupId`. */
  groupId: string;
  /** Raw `application.groupSize` (only the first applicant sets a meaningful value). */
  groupSize: string;
  status: ApplicationGroupMemberStatus;
};

export type ApplicationGroupMember = {
  id: string;
  name: string;
  email: string;
  role: GroupRole;
  status: ApplicationGroupMemberStatus;
};

export type ApplicationGroup = {
  /** Normalized (uppercase) Group ID. */
  groupId: string;
  /** Household size declared by the first applicant, when known. */
  expectedSize: number | null;
  members: ApplicationGroupMember[];
  /** Members that have actually submitted (past `in_progress`). */
  submittedCount: number;
  /** Rows present in the group (submitted or still in progress). */
  totalCount: number;
  /** Expected members still missing (`expectedSize - totalCount`), or null when the size is unknown. */
  missingCount: number | null;
  /** True when at least one member declared themselves the first applicant. */
  hasFirst: boolean;
  /**
   * More applications carry this id than the first applicant declared. Nothing is
   * rejected — the count is simply reported raw instead of as a misleading ratio.
   */
  isOverSubscribed: boolean;
  /**
   * All expected members are present and none is still in progress. A group can never
   * *block* on completeness — approvals stay per-member — but this drives the "waiting
   * on N" / "all in" copy so a stalled member is visible rather than silently deadlocked.
   * An over-subscribed group is never "complete": the declared size no longer describes it.
   */
  isComplete: boolean;
};

function parseGroupSize(raw: string): number | null {
  const n = parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(n) && n >= 2 ? n : null;
}

const ROLE_ORDER: Record<Exclude<GroupRole, null> | "none", number> = {
  first: 0,
  joining: 1,
  none: 2,
};

/**
 * Group the given rows by their shared Group ID. Rows without a group id are ignored.
 * Returns a map keyed by the normalized Group ID.
 */
export function buildApplicationGroups(rows: GroupRowInput[]): Map<string, ApplicationGroup> {
  const byId = new Map<string, GroupRowInput[]>();
  for (const row of rows) {
    const gid = normalizeGroupId(row.groupId);
    if (!gid) continue;
    const list = byId.get(gid);
    if (list) list.push(row);
    else byId.set(gid, [row]);
  }

  const groups = new Map<string, ApplicationGroup>();
  for (const [gid, list] of byId) {
    // De-duplicate by application id (a row can appear once); keep first occurrence.
    const seen = new Set<string>();
    const deduped = list.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));

    const members: ApplicationGroupMember[] = deduped
      .map((r) => ({ id: r.id, name: r.name, email: r.email, role: r.role, status: r.status }))
      .sort((a, b) => {
        const ra = ROLE_ORDER[a.role ?? "none"];
        const rb = ROLE_ORDER[b.role ?? "none"];
        if (ra !== rb) return ra - rb;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      });

    // Expected size is declared by the first applicant; take the largest declared value.
    const expectedSize = deduped.reduce<number | null>((acc, r) => {
      if (r.role !== "first") return acc;
      const size = parseGroupSize(r.groupSize);
      if (size == null) return acc;
      return acc == null ? size : Math.max(acc, size);
    }, null);

    const totalCount = members.length;
    const submittedCount = members.filter((m) => m.status !== "in_progress").length;
    const missingCount = expectedSize == null ? null : Math.max(0, expectedSize - totalCount);
    const hasFirst = members.some((m) => m.role === "first");
    const isOverSubscribed = expectedSize != null && totalCount > expectedSize;
    const isComplete = expectedSize != null && !isOverSubscribed && submittedCount >= expectedSize;

    groups.set(gid, {
      groupId: gid,
      expectedSize,
      members,
      submittedCount,
      totalCount,
      missingCount,
      hasFirst,
      isOverSubscribed,
      isComplete,
    });
  }

  return groups;
}

/** The group a specific row belongs to, or null when the row is not part of a group. */
export function groupForRow<T extends ApplicationGroup>(
  groups: Map<string, T>,
  row: { groupId: string },
): T | null {
  const gid = normalizeGroupId(row.groupId);
  if (!gid) return null;
  return groups.get(gid) ?? null;
}

/**
 * Short human summary of a group's completion — used by manager rows, the applicant
 * finish screen, and the resident portal. `tone` maps to a Badge tone.
 */
export function summarizeGroupProgress(group: ApplicationGroup): { label: string; tone: "confirmed" | "pending" | "info" } {
  if (group.expectedSize == null) {
    const noun = group.totalCount === 1 ? "applicant" : "applicants";
    return { label: `${group.totalCount} ${noun}`, tone: "info" };
  }
  if (group.isOverSubscribed) {
    const noun = group.totalCount === 1 ? "applicant" : "applicants";
    return { label: `${group.totalCount} ${noun} · ${group.expectedSize} declared`, tone: "pending" };
  }
  if (group.isComplete) {
    return { label: `All ${group.expectedSize} applied`, tone: "confirmed" };
  }
  const waiting = group.missingCount ?? Math.max(0, group.expectedSize - group.totalCount);
  const pendingInProgress = group.totalCount - group.submittedCount;
  const remaining = waiting + pendingInProgress;
  const shown = group.submittedCount;
  const suffix = remaining > 0 ? ` · waiting on ${remaining}` : "";
  return { label: `${shown} of ${group.expectedSize} applied${suffix}`, tone: "pending" };
}

export type GroupBadgeDescriptor = {
  label: string;
  tone: "confirmed" | "pending" | "info";
  /** Longer hover text — carries the Group ID and any reconciliation warning. */
  title: string;
};

/**
 * Compact badge for an application row. A ratio is only shown when the denominator is
 * real: an unknown or exceeded declared size renders the raw member count instead. The
 * "organizer not visible" case is stated as an observation about THIS viewer's rows —
 * groups are reconciled only over the applications a manager can see, so an organizer
 * scoped to another portfolio is a legitimate case, not applicant error.
 */
export function describeGroupBadge(group: ApplicationGroup): GroupBadgeDescriptor {
  const idText = `Group ID ${group.groupId}`;
  if (!group.hasFirst) {
    return {
      label: `Group ${group.totalCount} · organizer not shown`,
      tone: "info",
      title: `${idText} · no organizer application using this code is visible in your applications`,
    };
  }
  if (group.expectedSize == null) {
    return { label: `Group ${group.totalCount}`, tone: "info", title: idText };
  }
  if (group.isOverSubscribed) {
    return {
      label: `Group ${group.totalCount} · ${group.expectedSize} declared`,
      tone: "pending",
      title: `${idText} · more applications carry this code than the ${group.expectedSize} the organizer declared`,
    };
  }
  return {
    label: `Group ${group.submittedCount}/${group.expectedSize}`,
    tone: group.isComplete ? "confirmed" : "info",
    title: idText,
  };
}

/** Human-readable status for group rosters and application PDF/HTML documents. */
export function applicationGroupMemberStatusLabel(status: ApplicationGroupMemberStatus): string {
  switch (status) {
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "in_progress":
      return "Incomplete";
    case "flagged":
      return "Flagged";
    case "screened":
      return "Screened";
    case "screening":
      return "Screening";
    default:
      return "New";
  }
}
