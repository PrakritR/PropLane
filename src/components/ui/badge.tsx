import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const tones: Record<string, string> = {
  neutral: "border-border bg-foreground/5 text-muted",
  success: "border-[color-mix(in_srgb,var(--status-confirmed-fg)_30%,transparent)] bg-[var(--status-confirmed-bg)] text-[var(--status-confirmed-fg)]",
  warning: "border-[color-mix(in_srgb,var(--status-pending-fg)_30%,transparent)] bg-[var(--status-pending-bg)] text-[var(--status-pending-fg)]",
  danger: "border-[color-mix(in_srgb,var(--status-overdue-fg)_30%,transparent)] bg-[var(--status-overdue-bg)] text-[var(--status-overdue-fg)]",
  info: "border-[color-mix(in_srgb,var(--status-approved-fg)_30%,transparent)] bg-[var(--status-approved-bg)] text-[var(--status-approved-fg)]",
  pending: "border-[color-mix(in_srgb,var(--status-pending-fg)_30%,transparent)] bg-[var(--status-pending-bg)] text-[var(--status-pending-fg)]",
  approved: "border-[color-mix(in_srgb,var(--status-approved-fg)_30%,transparent)] bg-[var(--status-approved-bg)] text-[var(--status-approved-fg)]",
  confirmed: "border-[color-mix(in_srgb,var(--status-confirmed-fg)_30%,transparent)] bg-[var(--status-confirmed-bg)] text-[var(--status-confirmed-fg)]",
  overdue: "border-[color-mix(in_srgb,var(--status-overdue-fg)_30%,transparent)] bg-[var(--status-overdue-bg)] text-[var(--status-overdue-fg)]",
};

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: keyof typeof tones;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-bold tracking-[0.02em]",
        tones[tone] ?? tones.neutral,
        className,
      )}
    >
      {children}
    </span>
  );
}
