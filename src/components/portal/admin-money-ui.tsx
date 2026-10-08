"use client";

import { ChevronLeft, ChevronRight, TriangleAlert } from "lucide-react";
import {
  FilterCollapsibleSection,
  FilterSingleSelectList,
  filterSingleSelectSummary,
  useFilterAccordionClose,
} from "@/components/portal/filter-field-lists";
import { PortalIconAction } from "@/components/portal/portal-icon-action";

/**
 * Small pieces the Money and Subscribers lists share: a single-select field for the Filter sheet, a
 * pager, a month switcher and the test-mode banner. Nothing here owns data.
 */

/** One single-select field inside the shared Filter sheet (a `FilterFieldsAccordion` child). */
export function AdminSingleSelectFilterField<T extends string>({
  sectionId,
  label,
  value,
  options,
  defaultValue,
  defaultSummary,
  onChange,
  dataAttr,
}: {
  sectionId: string;
  label: string;
  value: T;
  options: { value: T; label: string }[];
  defaultValue: T;
  defaultSummary: string;
  onChange: (next: T) => void;
  dataAttr: string;
}) {
  const closeFieldMenu = useFilterAccordionClose();
  return (
    <FilterCollapsibleSection
      sectionId={sectionId}
      label={label}
      summary={filterSingleSelectSummary(value, options, defaultSummary)}
      empty={value === defaultValue}
      menuOptionCount={options.length}
      dataAttr={`${dataAttr}-trigger`}
    >
      <FilterSingleSelectList
        options={options}
        value={value}
        onChange={(next) => onChange(next as T)}
        onPick={closeFieldMenu}
        dataAttr={dataAttr}
      />
    </FilterCollapsibleSection>
  );
}

/** "1-50 of 213" with icon-only previous/next. Draws nothing when everything fits one page. */
export function AdminListPager({
  page,
  pageSize,
  total,
  onPage,
  dataAttr,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (next: number) => void;
  dataAttr: string;
}) {
  if (total <= pageSize) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-end gap-1 px-3.5 py-3" data-attr={dataAttr}>
      <span className="mr-1 text-[13px] tabular-nums text-muted" aria-live="polite">
        {first}-{last} of {total}
      </span>
      <PortalIconAction
        icon={ChevronLeft}
        label="Previous page"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        data-attr={`${dataAttr}-prev`}
      />
      <PortalIconAction
        icon={ChevronRight}
        label="Next page"
        disabled={page >= lastPage}
        onClick={() => onPage(page + 1)}
        data-attr={`${dataAttr}-next`}
      />
    </div>
  );
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "October 2026" from `2026-10`. */
export function adminMonthLabel(month: string): string {
  const [year, m] = month.split("-");
  const name = MONTH_NAMES[Number(m) - 1];
  return name && year ? `${name} ${year}` : month;
}

/** ‹ October 2026 ›. The next arrow stops at the current month. */
export function AdminMonthSwitcher({
  month,
  canGoNext,
  onPrevious,
  onNext,
}: {
  month: string;
  canGoNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex items-center gap-0.5" data-attr="admin-month-switcher">
      <PortalIconAction icon={ChevronLeft} label="Previous month" onClick={onPrevious} data-attr="admin-month-prev" />
      <span className="min-w-[120px] text-center text-[14px] font-semibold text-foreground">{adminMonthLabel(month)}</span>
      <PortalIconAction
        icon={ChevronRight}
        label="Next month"
        disabled={!canGoNext}
        onClick={onNext}
        data-attr="admin-month-next"
      />
    </div>
  );
}

/** Shown above Payments when the platform Stripe key is a test key. */
export function AdminTestModeBanner() {
  return (
    <div
      role="status"
      data-attr="admin-stripe-test-mode"
      className="mb-3 flex items-center gap-2 rounded-lg border border-[var(--status-warning-fg)]/30 bg-[var(--status-warning-fg)]/[0.06] px-3.5 py-2.5 text-[13.5px] font-medium text-[var(--status-warning-fg)]"
    >
      <TriangleAlert className="size-4 shrink-0" strokeWidth={1.8} aria-hidden />
      <span>Stripe is in test mode. These are test payments, not real money.</span>
    </div>
  );
}
