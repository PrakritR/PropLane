/**
 * Auto-assign + priority heuristics for PropLane Linear issues.
 * Used by linear-triage.mjs and linear-file-ticket.mjs.
 */

import { ASSIGNEE_AKHIL, ASSIGNEE_M, COMMUNICATION_PROJECT } from "./assignees.mjs";

/** Linear priority: 0=none 1=urgent 2=high 3=medium 4=low */
export const PRIORITY = {
  none: 0,
  urgent: 1,
  high: 2,
  medium: 3,
  low: 4,
};

const HAPPY_PATH_BREAK = /\b(crash|404|blocked|redirect|sign-?up|sign-?in|login|onboarding|apply|payment|pay\b|stuck|spinner|hangs?\b|hanging|error|regression|data loss|cannot|can't|won't|broken|wrong charge|ghost data)\b/i;
const PRODUCTION_DOWN = /\b(production down|prod down|all crons dark|email dark|security critical|privilege escalation)\b/i;
const COMMUNICATION_TEXT = /\b(sms|inbox|email|messaging|thread|communication|twilio|resend|a2p)\b/i;
const FREQUENT_SURFACE = /\b(properties|residents|payments|applications|listing|browse|calendar|tour|dashboard|lease|charges)\b/i;
/** Cosmetic UI — default Low unless paired with UI_UNUSABLE or HAPPY_PATH_BREAK. */
const UI_POLISH = /\b(rename|rebrand|colour-contrast|color contrast|ui audit|polish|cosmetic|spacing|align(ment)?|wording|typo|minor ui|duplicate copy|add row styling)\b/i;
/** UI that blocks completing a task (not mere polish). */
const UI_UNUSABLE = /\b(unusable|cannot (click|submit|save|continue|complete)|dead click|white screen|invisible|unreadable|overlay blocks|modal trap|entire (tab|page) (broken|blank))\b/i;
/** Dev/agent ergonomics — Low unless it blocks shipping. */
const DEV_ONLY = /\b(playwright mcp|seed:dev|dev server|port-per-lane|test account|localstorage|qa epic|agent branch|worktree)\b/i;
const LOW_SURFACE = /\b(typo|polish|marketing|admin-only|dev tooling|coordination|minor)\b/i;

function labelNames(issue) {
  return (issue.labels?.nodes ?? issue.labels ?? []).map((l) =>
    typeof l === "string" ? l : l.name,
  );
}

export function isCommunicationIssue(issue) {
  const project = issue.project?.name ?? issue.project ?? "";
  const labels = labelNames(issue);
  const text = `${issue.title ?? ""} ${issue.description ?? ""}`;
  if (project === COMMUNICATION_PROJECT) return true;
  if (labels.some((l) => l.toLowerCase() === "area:communication")) return true;
  if (COMMUNICATION_TEXT.test(text) && !/\b(auth\/login|create-account|get-started)\b/i.test(text)) {
    return true;
  }
  return false;
}

export function inferAssigneeId(issue) {
  return isCommunicationIssue(issue) ? ASSIGNEE_AKHIL : ASSIGNEE_M;
}

export function inferPriority(issue) {
  const text = `${issue.title ?? ""} ${issue.description ?? ""}`;
  const project = issue.project?.name ?? issue.project ?? "";
  const labels = labelNames(issue);
  const isBug = labels.some((l) => l.toLowerCase() === "bug") || /\bbug\b/i.test(text);

  if (PRODUCTION_DOWN.test(text) || (project.startsWith("01 —") && /production env|crons dark/i.test(text))) {
    return PRIORITY.urgent;
  }

  if (isCommunicationIssue(issue)) return PRIORITY.high;

  // Flow-breaking bugs beat cosmetic UI.
  if (UI_UNUSABLE.test(text)) return PRIORITY.high;
  if (isBug && HAPPY_PATH_BREAK.test(text)) return PRIORITY.high;
  if (HAPPY_PATH_BREAK.test(text) && /auth|portal|resident|manager|signup|sign-in/i.test(text)) {
    return PRIORITY.high;
  }

  // Money / billing correctness on a frequent surface.
  if (/\b(wrong charge|double charge|fee|billing|ledger)\b/i.test(text) && isBug) return PRIORITY.high;

  // Cosmetic UI, renames, audits, dev-only tooling — Low unless unusable (handled above).
  if (UI_POLISH.test(text) && !HAPPY_PATH_BREAK.test(text)) return PRIORITY.low;
  if (DEV_ONLY.test(text) && !PRODUCTION_DOWN.test(text)) return PRIORITY.low;
  if (LOW_SURFACE.test(text) || project.startsWith("12 —")) return PRIORITY.low;
  if (project.startsWith("05 —") && !HAPPY_PATH_BREAK.test(text)) return PRIORITY.low;
  if (project.startsWith("09 —") && !HAPPY_PATH_BREAK.test(text)) return PRIORITY.low;

  if (FREQUENT_SURFACE.test(text) || /0[23] —|10 —|11 —/.test(project)) return PRIORITY.medium;

  return PRIORITY.medium;
}

export function triageReason(issue) {
  const assignee = isCommunicationIssue(issue) ? "Communication Hub → Akhil" : "Default → M";
  const p = inferPriority(issue);
  const priorityLabel =
    p === PRIORITY.urgent
      ? "Urgent — production/security"
      : p === PRIORITY.high
        ? "High — comms or happy-path break"
        : p === PRIORITY.medium
          ? "Medium — frequent surface"
          : "Low — polish, dev-only, or cosmetic UI";
  return `${assignee}; ${priorityLabel}`;
}
