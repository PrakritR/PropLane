"use client";

import type { ReactNode } from "react";
import { AxisHeaderMarkTile } from "@/components/brand/axis-logo";

export const PORTAL_EMPTY_STATE_WRAP =
  "flex flex-col items-center justify-center rounded-2xl border border-border bg-accent/25 px-4 py-16 text-center sm:py-20";

/** Empty state card connected below an inline unlock notice (shared top border). */
export const PORTAL_EMPTY_STATE_STACKED_WRAP = `${PORTAL_EMPTY_STATE_WRAP} rounded-t-none border-t-0`;

export type PortalEmptyIconKind =
  | "inbox"
  | "residents"
  | "lease"
  | "payment"
  | "service"
  | "work-order"
  | "vendor"
  | "document"
  | "finance"
  | "feedback"
  | "team"
  | "application"
  | "data"
  | "default";

function svgProps(className: string) {
  return {
    className,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
}

export function PortalEmptyIcon({
  kind,
  className = "h-[26px] w-[26px]",
}: {
  kind: PortalEmptyIconKind;
  className?: string;
}) {
  const p = svgProps(className);
  switch (kind) {
    case "inbox":
      return (
        <svg {...p}>
          <rect width="20" height="16" x="2" y="4" rx="2" />
          <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
        </svg>
      );
    case "residents":
      return (
        <svg {...p}>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      );
    case "lease":
      return (
        <svg {...p}>
          <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
          <path d="M14 2v4a2 2 0 0 0 2 2h4" />
          <path d="M10 9H8" />
          <path d="M16 13H8" />
          <path d="M16 17H8" />
        </svg>
      );
    case "payment":
      return (
        <svg {...p}>
          <rect width="20" height="14" x="2" y="5" rx="2" />
          <path d="M2 10h20" />
        </svg>
      );
    case "service":
      return (
        <svg {...p}>
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
      );
    case "work-order":
      return (
        <svg {...p}>
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
      );
    case "vendor":
      return (
        <svg {...p}>
          <path d="M10 17h4V5H2v12h3" />
          <path d="M20 17h2v-3.34a4 4 0 0 0-1.17-2.83L19 9h-5" />
          <path d="M14 17h1" />
          <circle cx="7.5" cy="17.5" r="2.5" />
          <circle cx="17.5" cy="17.5" r="2.5" />
        </svg>
      );
    case "document":
      return (
        <svg {...p}>
          <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
          <path d="M14 2v4a2 2 0 0 0 2 2h4" />
          <path d="M10 9H8" />
          <path d="M16 13H8" />
          <path d="M16 17H8" />
        </svg>
      );
    case "finance":
      return (
        <svg {...p}>
          <path d="M3 3v18h18" />
          <path d="M18 17V9" />
          <path d="M13 17V5" />
          <path d="M8 17v-3" />
        </svg>
      );
    case "feedback":
      return (
        <svg {...p}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      );
    case "team":
      return (
        <svg {...p}>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      );
    case "application":
      return (
        <svg {...p}>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M19 8v6" />
          <path d="M22 11h-6" />
        </svg>
      );
    case "data":
    case "default":
    default:
      return (
        <svg {...p}>
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M3 5v14a9 3 0 0 0 18 0V5" />
          <path d="M3 12a9 3 0 0 0 18 0" />
        </svg>
      );
  }
}

export function PortalEmptyState({
  title,
  icon = "default",
  variant = "card",
  description,
  action,
}: {
  title: string;
  icon?: PortalEmptyIconKind | ReactNode;
  /** `plain` drops the border; `compact` keeps an empty queue from dominating the page. */
  variant?: "card" | "plain" | "stacked" | "compact";
  description?: string;
  action?: ReactNode;
}) {
  const iconNode =
    typeof icon === "string" ? <PortalEmptyIcon kind={icon as PortalEmptyIconKind} /> : icon;
  const wrapClass =
    variant === "plain"
      ? "flex flex-col items-center justify-center px-4 py-16 text-center sm:py-20"
      : variant === "stacked"
        ? PORTAL_EMPTY_STATE_STACKED_WRAP
        : variant === "compact"
          ? "flex flex-col items-center justify-center rounded-xl border border-border bg-card/60 px-4 py-10 text-center sm:py-12"
        : PORTAL_EMPTY_STATE_WRAP;
  return (
    <div className={wrapClass}>
      <AxisHeaderMarkTile>{iconNode}</AxisHeaderMarkTile>
      <p className="mt-4 text-sm font-semibold text-foreground">{title}</p>
      {description ? <p className="mt-1 max-w-md text-sm text-muted">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
