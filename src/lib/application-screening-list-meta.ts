import type { DemoApplicantRow } from "@/data/demo-portal";
import { applicationShowsBackgroundCheck } from "@/lib/application-background-check";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import { cosignerShowsBackgroundCheck } from "@/lib/cosigner-screening";

export type ScreeningListTrailTone = "pending" | "ready" | "running" | "complete" | "muted";

export function screeningListTrailForApplicant(row: DemoApplicantRow): {
  label: string;
  sub: string;
  tone: ScreeningListTrailTone;
} {
  if (!applicationShowsBackgroundCheck(row)) {
    return { label: "—", sub: "Not required", tone: "muted" };
  }
  if (!row.application?.consentCredit) {
    return { label: "Pending", sub: "Awaiting resident consent", tone: "pending" };
  }
  if (row.backgroundCheck?.status === "complete") {
    return { label: "Complete", sub: "Report available", tone: "complete" };
  }
  if (row.backgroundCheck?.status === "pending") {
    return { label: "Running", sub: "Checkr is processing", tone: "running" };
  }
  return { label: "Get check", sub: "Ready to run", tone: "ready" };
}

export function screeningListTrailForCosigner(sub: CosignerSubmission): {
  label: string;
  sub: string;
  tone: ScreeningListTrailTone;
} {
  if (!cosignerShowsBackgroundCheck(sub)) {
    return { label: "—", sub: "Not required", tone: "muted" };
  }
  if (!sub.consentCredit) {
    return { label: "Pending", sub: "Awaiting co-signer consent", tone: "pending" };
  }
  if (sub.backgroundCheck?.status === "complete") {
    return { label: "Complete", sub: "Report available", tone: "complete" };
  }
  if (sub.backgroundCheck?.status === "pending") {
    return { label: "Running", sub: "Checkr is processing", tone: "running" };
  }
  return { label: "Get check", sub: "Ready to run", tone: "ready" };
}

export function screeningTrailToneClassName(tone: ScreeningListTrailTone): string {
  switch (tone) {
    case "pending":
    case "running":
      return "text-amber-600";
    case "ready":
      return "text-primary";
    case "complete":
      return "text-foreground";
    case "muted":
    default:
      return "text-muted";
  }
}
