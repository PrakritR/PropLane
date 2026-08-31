"use client";

import { MoreHorizontal } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  PORTAL_DATA_TABLE,
  PORTAL_DATA_TABLE_SCROLL,
  PORTAL_DATA_TABLE_WRAP,
  PORTAL_TABLE_HEAD_ROW,
  PORTAL_TABLE_TD,
  PORTAL_TABLE_TR,
  PortalResponsiveDataView,
  isPortalRowClickIgnored,
} from "@/components/portal/portal-data-table";
import { MANAGER_TABLE_TH } from "@/components/portal/portal-metrics";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type DataListColumn<T> = {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  headerClassName?: string;
  cellClassName?: string;
};

export type DataListRowAction = {
  id: string;
  label: string;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
};

export type DataListRow<T> = {
  id: string;
  data: T;
  primary: string;
  /** Trailing value on line one (amount, status badge, etc.). */
  trailing?: ReactNode;
  /** Single muted metadata line — max one line on mobile. */
  meta?: string;
  onClick?: () => void;
  selected?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  /** Overflow menu actions (secondary + destructive). */
  overflowActions?: DataListRowAction[];
  /** Inline primary action (visible on row). */
  inlineAction?: ReactNode;
  expanded?: boolean;
  expandedContent?: ReactNode;
};

export const DATA_LIST_MOBILE_ROW_CLASS =
  "flex min-h-[56px] max-h-[56px] items-center gap-3 border-b border-border/80 px-3 py-2 last:border-0";

/** Resident portal lists — taller rows, no max height, selection tint (Payments-style). */
export const DATA_LIST_RESIDENT_MOBILE_ROW_CLASS =
  "flex min-h-[56px] items-center gap-3 border-b border-border/80 px-4 py-3 last:border-0 transition-colors";

export const DATA_LIST_DESKTOP_ROW_CLASS = "h-11 max-h-11";

function DataListOverflowMenu({ actions }: { actions: DataListRowAction[] }) {
  if (!actions.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        type="button"
        aria-label="Row actions"
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-portal-row-ignore
      >
        <MoreHorizontal className="h-5 w-5" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.id}
            disabled={action.disabled}
            onSelect={(e) => {
              e.preventDefault();
              action.onSelect();
            }}
            className={action.destructive ? "text-red-600 focus:text-red-600" : undefined}
          >
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DataListMobileRow<T>({
  row,
  selectable,
  variant = "default",
}: {
  row: DataListRow<T>;
  selectable?: boolean;
  variant?: "default" | "resident";
}) {
  const clickable = Boolean(row.onClick);
  const rowClass = cn(
    variant === "resident" ? DATA_LIST_RESIDENT_MOBILE_ROW_CLASS : DATA_LIST_MOBILE_ROW_CLASS,
    clickable && variant === "resident" ? "hover:bg-accent/30" : clickable ? "hover:bg-accent/40" : "",
    variant === "resident" && row.selected ? "bg-primary/[0.06]" : "",
  );
  const body = (
    <>
      {selectable && row.onSelectedChange ? (
        <input
          type="checkbox"
          className="h-4 w-4 shrink-0 rounded border-border"
          checked={row.selected ?? false}
          onChange={(e) => row.onSelectedChange?.(e.target.checked)}
          onClick={(e) => e.stopPropagation()}
          data-portal-row-ignore
          aria-label={`Select ${row.primary}`}
        />
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{row.primary}</p>
          {row.trailing ? <div className="shrink-0">{row.trailing}</div> : null}
        </div>
        {row.meta ? <p className="truncate text-xs text-muted">{row.meta}</p> : null}
      </div>
      {row.inlineAction ? <div className="shrink-0" data-portal-row-ignore>{row.inlineAction}</div> : null}
      {row.overflowActions ? <DataListOverflowMenu actions={row.overflowActions} /> : null}
    </>
  );

  if (!clickable) {
    return (
      <div className={rowClass} data-slot="data-list-mobile-row">
        {body}
      </div>
    );
  }

  // Nested buttons (inline actions, overflow menus) cannot live inside a row <button>.
  if (row.inlineAction || row.overflowActions?.length) {
    return (
      <div
        role="button"
        tabIndex={0}
        className={cn(rowClass, "w-full text-left")}
        onClick={(e) => {
          if (!row.onClick || isPortalRowClickIgnored(e.target)) return;
          row.onClick();
        }}
        onKeyDown={(e) => {
          if (!row.onClick || isPortalRowClickIgnored(e.target)) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            row.onClick();
          }
        }}
        data-slot="data-list-mobile-row"
      >
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={cn(rowClass, "w-full text-left")}
      onClick={() => row.onClick?.()}
      data-slot="data-list-mobile-row"
    >
      {body}
    </button>
  );
}

function DataListDesktopRow<T>({
  row,
  columns,
  selectable,
}: {
  row: DataListRow<T>;
  columns: DataListColumn<T>[];
  selectable?: boolean;
}) {
  return (
    <tr
      className={cn(PORTAL_TABLE_TR, DATA_LIST_DESKTOP_ROW_CLASS, row.onClick && "cursor-pointer")}
      onClick={(e) => {
        if (!row.onClick || isPortalRowClickIgnored(e.target)) return;
        row.onClick();
      }}
      data-slot="data-list-desktop-row"
    >
      {selectable && row.onSelectedChange ? (
        <td className={cn(PORTAL_TABLE_TD, "w-10 px-3")}>
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-border"
            checked={row.selected ?? false}
            onChange={(e) => row.onSelectedChange?.(e.target.checked)}
            onClick={(e) => e.stopPropagation()}
            data-portal-row-ignore
            aria-label={`Select ${row.primary}`}
          />
        </td>
      ) : null}
      {columns.map((col, index) => (
        <td
          key={col.id}
          className={cn(
            PORTAL_TABLE_TD,
            "py-2.5",
            index === 0 && "font-medium text-foreground",
            col.cellClassName,
          )}
        >
          {col.cell(row.data)}
        </td>
      ))}
      {(row.inlineAction || row.overflowActions) ? (
        <td className={cn(PORTAL_TABLE_TD, "w-0 py-2.5 text-right")}>
          <div className="flex items-center justify-end gap-1">
            {row.inlineAction}
            {row.overflowActions ? <DataListOverflowMenu actions={row.overflowActions} /> : null}
          </div>
        </td>
      ) : null}
    </tr>
  );
}

export function DataList<T>({
  rows,
  columns,
  selectable = false,
  hideColumnHeaders = false,
  variant = "default",
  emptyState,
  className,
}: {
  rows: DataListRow<T>[];
  columns: DataListColumn<T>[];
  selectable?: boolean;
  /** Hide the desktop column header row (resident portal lists). */
  hideColumnHeaders?: boolean;
  /** `resident` — single card shell + Payments-style row density (all breakpoints). */
  variant?: "default" | "resident";
  emptyState?: ReactNode;
  className?: string;
}) {
  if (rows.length === 0 && emptyState) {
    return <div data-slot="data-list-empty">{emptyState}</div>;
  }

  const mobileRows = rows.map((row) => (
    <div key={row.id}>
      <DataListMobileRow row={row} selectable={selectable} variant={variant} />
      {row.expanded && row.expandedContent ? (
        <div
          className={cn(
            "border-b border-border/80 bg-accent/20 px-4 py-3 last:border-0",
            variant === "resident" ? "" : "px-3",
          )}
        >
          {row.expandedContent}
        </div>
      ) : null}
    </div>
  ));

  const residentListBody = (
    <div
      className="overflow-hidden rounded-2xl border border-border bg-card"
      data-variant="resident"
    >
      {mobileRows}
    </div>
  );

  const desktopTable = (
    <div className={PORTAL_DATA_TABLE_WRAP}>
      <div className={PORTAL_DATA_TABLE_SCROLL}>
        <table className={PORTAL_DATA_TABLE}>
          {!hideColumnHeaders ? (
          <thead>
            <tr className={PORTAL_TABLE_HEAD_ROW}>
              {selectable ? (
                <th className={cn(MANAGER_TABLE_TH, "w-10 px-3")} scope="col" />
              ) : null}
              {columns.map((col) => (
                <th
                  key={col.id}
                  scope="col"
                  className={cn(MANAGER_TABLE_TH, col.headerClassName)}
                >
                  {col.header}
                </th>
              ))}
              <th className={cn(MANAGER_TABLE_TH, "w-0")} scope="col" aria-label="Actions" />
            </tr>
          </thead>
          ) : null}
          <tbody>
            {rows.map((row) => (
              <Fragment key={row.id}>
                <DataListDesktopRow
                  row={row}
                  columns={columns}
                  selectable={selectable}
                />
                {row.expanded && row.expandedContent ? (
                  <tr className="border-b border-border/80 bg-accent/20">
                    <td
                      colSpan={columns.length + (selectable ? 1 : 0) + 1}
                      className="px-4 py-4 sm:px-5"
                    >
                      {row.expandedContent}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div className={cn("min-w-0", className)} data-slot="data-list">
      {hideColumnHeaders ? (
        // Resident-cluster lists are card rows, not spreadsheets — skip desktop tables.
        variant === "resident" ? (
          residentListBody
        ) : (
          <div className="space-y-2">{mobileRows}</div>
        )
      ) : (
        <PortalResponsiveDataView mobile={mobileRows} desktop={desktopTable} />
      )}
    </div>
  );
}
