"use client";

/**
 * The empty state of a list tab (Mobbin polish §15): a titled card that says
 * what appears on this tab, points at a sibling tab that does have something
 * ("5 upcoming — next today 4:42 PM"), and offers the one or two real actions.
 * It replaces the bare dashed "Add" box, which said nothing about why the tab
 * was empty or where the rows had gone.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export type PortalListEmptyAction = {
  label: string;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
  dataAttr?: string;
  /** The first action is primary; pass `secondary` for the rest. */
  secondary?: boolean;
};

export type PortalListEmptySibling = {
  /** "5 upcoming — next today 4:42 PM" */
  label: string;
  href: string;
  dataAttr?: string;
};

export function PortalListEmptyCard({
  title,
  description,
  sibling,
  actions = [],
  icon,
  dataAttr = "portal-list-empty-card",
}: {
  title: string;
  description?: string;
  sibling?: PortalListEmptySibling | null;
  actions?: PortalListEmptyAction[];
  icon?: ReactNode;
  dataAttr?: string;
}) {
  return (
    <section
      className="flex flex-col items-center rounded-2xl border border-border bg-card px-6 py-8 text-center shadow-sm sm:py-10"
      data-attr={dataAttr}
    >
      {icon ? <span className="mb-3 grid size-11 place-items-center rounded-2xl bg-accent/60 text-primary">{icon}</span> : null}
      <h3 className="text-[16px] font-semibold tracking-[-0.01em] text-foreground">{title}</h3>
      {description ? <p className="mt-1 max-w-[34rem] text-[13.5px] leading-relaxed text-muted">{description}</p> : null}
      {sibling ? (
        <Link
          href={sibling.href}
          data-attr={sibling.dataAttr ?? "portal-list-empty-sibling"}
          className="mt-3 inline-flex items-center gap-1 text-[13px] font-semibold text-primary hover:underline"
        >
          {sibling.label}
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      ) : null}
      {actions.length > 0 ? (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {actions.slice(0, 2).map((action) =>
            action.href ? (
              <Button key={action.label} asChild variant={action.secondary ? "outline" : "primary"} className="rounded-full">
                <Link href={action.href} data-attr={action.dataAttr}>
                  {action.label}
                </Link>
              </Button>
            ) : (
              <Button
                key={action.label}
                type="button"
                variant={action.secondary ? "outline" : "primary"}
                className="rounded-full"
                onClick={action.onClick}
                disabled={action.disabled}
                data-attr={action.dataAttr}
              >
                {action.label}
              </Button>
            ),
          )}
        </div>
      ) : null}
    </section>
  );
}
