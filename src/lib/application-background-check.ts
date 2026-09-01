import type { ApplicationBackgroundCheck } from "@/lib/checkr/types";

export type ApplicationBackgroundCheckStatus = "pending_review" | "passed" | "flagged" | "not_applicable";

export const APPLICATION_BACKGROUND_CHECK_STATUSES: ApplicationBackgroundCheckStatus[] = [
  "pending_review",
  "passed",
  "flagged",
  "not_applicable",
];

export function backgroundCheckStatusLabel(status: ApplicationBackgroundCheckStatus): string {
  switch (status) {
    case "passed":
      return "Background check passed";
    case "flagged":
      return "Flagged — needs attention";
    case "not_applicable":
      return "Not applicable";
    case "pending_review":
    default:
      return "Pending review";
  }
}

export function backgroundCheckStatusTone(
  status: ApplicationBackgroundCheckStatus,
): "neutral" | "success" | "warning" | "muted" {
  switch (status) {
    case "passed":
      return "success";
    case "flagged":
      return "warning";
    case "not_applicable":
      return "muted";
    case "pending_review":
    default:
      return "neutral";
  }
}

export function backgroundCheckStatusClassName(status: ApplicationBackgroundCheckStatus): string {
  const ring = "ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]";
  switch (backgroundCheckStatusTone(status)) {
    case "success":
      return `portal-badge-success ${ring}`;
    case "warning":
      return `portal-badge-pending ${ring}`;
    case "muted":
      return `bg-foreground/5 text-muted ${ring}`;
    case "neutral":
    default:
      return `portal-badge-info ${ring}`;
  }
}

export function normalizeBackgroundCheckStatus(value: unknown): ApplicationBackgroundCheckStatus | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return APPLICATION_BACKGROUND_CHECK_STATUSES.includes(trimmed as ApplicationBackgroundCheckStatus)
    ? (trimmed as ApplicationBackgroundCheckStatus)
    : undefined;
}

/** Default status for newly submitted rental applications (automation hooks in later). */
export function defaultBackgroundCheckStatusForRow(row: {
  manuallyAdded?: boolean;
  application?: unknown;
}): ApplicationBackgroundCheckStatus {
  if (row.manuallyAdded || !row.application) return "not_applicable";
  return "pending_review";
}

export function resolveBackgroundCheckStatus(row: {
  manuallyAdded?: boolean;
  application?: unknown;
  backgroundCheckStatus?: ApplicationBackgroundCheckStatus;
}): ApplicationBackgroundCheckStatus {
  return (
    normalizeBackgroundCheckStatus(row.backgroundCheckStatus) ?? defaultBackgroundCheckStatusForRow(row)
  );
}

export function backgroundCheckStatusPill(row: {
  manuallyAdded?: boolean;
  application?: unknown;
  backgroundCheckStatus?: ApplicationBackgroundCheckStatus;
}): { label: string; tone: "info" | "warning" | "muted" | "success" } {
  const status = resolveBackgroundCheckStatus(row);
  const tone = backgroundCheckStatusTone(status);
  const label =
    status === "passed"
      ? "Passed"
      : status === "flagged"
        ? "Flagged"
        : status === "not_applicable"
          ? "N/A"
          : "Pending";
  const mappedTone: "info" | "warning" | "muted" | "success" =
    tone === "success" ? "success" : tone === "warning" ? "warning" : tone === "muted" ? "muted" : "info";
  return { label, tone: mappedTone };
}

export function applicationShowsBackgroundCheck(row: {
  manuallyAdded?: boolean;
  application?: unknown;
  backgroundCheckStatus?: ApplicationBackgroundCheckStatus;
}): boolean {
  return resolveBackgroundCheckStatus(row) !== "not_applicable";
}

/** Map a Checkr order/report state onto the manager-facing background-check badge. */
export function backgroundCheckStatusFromCheckr(
  bc: ApplicationBackgroundCheck | null | undefined,
): ApplicationBackgroundCheckStatus {
  if (!bc) return "pending_review";
  if (bc.status !== "complete") return "pending_review";
  if (bc.result === "clear") return "passed";
  // consider (or a canceled/failed order) needs a human look.
  return "flagged";
}
