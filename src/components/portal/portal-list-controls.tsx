"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  portalListGroupSortCatalog,
  readPortalListGroupSortParams,
  readStoredPortalListGroupSort,
  withPortalListGroupSortParams,
  writeStoredPortalListGroupSort,
  type PortalListGroupSortState,
  type PortalListKey,
} from "@/lib/portals/list-grouping";

/**
 * `useRouter()` throws ("invariant expected app router to be mounted") when
 * no app router is mounted above this component — a plain component test,
 * a Storybook-style harness, or any other non-router host. The call always
 * happens on every render (only the `try`/`catch` outcome varies), so hook
 * call order stays unconditional and stable; the result is `null` instead
 * of a thrown render.
 */
function usePortalRouterOrNull(): ReturnType<typeof useRouter> | null {
  try {
    return useRouter();
  } catch {
    return null;
  }
}

/**
 * The Group/Sort state for one list: read from the URL first, falling back
 * to the viewer's remembered choice, falling back to the list's default —
 * and every change writes back to both the URL and local storage
 * (`docs/agents/record-page.md` "Lists").
 *
 * Outside an app router (`router`/`pathname` unavailable — see
 * `usePortalRouterOrNull` above) there is no URL to read or navigate: this
 * falls back to the viewer's remembered choice, then the list's default, and
 * every `setGroup`/`setSort` becomes a no-op rather than throwing.
 */
export function usePortalListGroupSort(listKey: PortalListKey): PortalListGroupSortState & {
  setGroup: (group: string) => void;
  setSort: (sort: string) => void;
} {
  const router = usePortalRouterOrNull();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const hasUrlState = Boolean(router) && Boolean(searchParams) && (searchParams!.has("group") || searchParams!.has("sort"));
  const remembered = hasUrlState ? null : readStoredPortalListGroupSort(listKey);
  const effectiveParams = hasUrlState ? searchParams! : new URLSearchParams();
  if (!hasUrlState) {
    if (remembered?.group) effectiveParams.set("group", remembered.group);
    if (remembered?.sort) effectiveParams.set("sort", remembered.sort);
  }
  const resolved = readPortalListGroupSortParams(listKey, effectiveParams);

  // Not memoized: `resolved` already reads fresh off `searchParams`/storage every
  // render, and this hook is only ever called from the one list-header control, so
  // there is no fan-out to protect against a fresh closure each render.
  const navigate = (next: Partial<PortalListGroupSortState>) => {
    if (!router || !pathname) return;
    const merged = { ...resolved, ...next };
    writeStoredPortalListGroupSort(listKey, merged);
    const params = withPortalListGroupSortParams(searchParams ?? new URLSearchParams(), merged);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  return {
    ...resolved,
    setGroup: (group: string) => navigate({ group }),
    setSort: (sort: string) => navigate({ sort }),
  };
}

function PortalListMenuButton({
  label,
  value,
  options,
  onChange,
  dataAttr,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  dataAttr?: string;
}) {
  const current = options.find((option) => option.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-attr={dataAttr}
          className="inline-flex h-9 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2 text-[13px] font-medium text-foreground hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 max-md:px-1.5"
        >
          <span className="text-muted">{label}</span>
          <span className="font-semibold">{current?.label ?? value}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="truncate text-xs font-semibold text-muted">{label}</DropdownMenuLabel>
        {options.map((option) => (
          <DropdownMenuItem key={option.value} onSelect={() => onChange(option.value)} className="justify-between gap-2">
            <span>{option.label}</span>
            {option.value === value ? <Check className="size-4 shrink-0 text-primary" aria-hidden /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The Group and Sort menus that ride in a list's command bar
 * (`docs/portal-list-section-layout.md` "Command bar"), styled like the
 * band's other icon-adjacent controls — never a pill on a row. A list whose
 * catalog entry has only a "None" group option skips the Group menu
 * entirely (Properties).
 */
export function PortalListControls({
  listKey,
  group,
  sort,
  onGroupChange,
  onSortChange,
  className,
}: {
  listKey: PortalListKey;
  group: string;
  sort: string;
  onGroupChange: (group: string) => void;
  onSortChange: (sort: string) => void;
  className?: string;
}) {
  const catalog = portalListGroupSortCatalog(listKey);
  const showGroup = catalog.groupOptions.length > 1;
  return (
    <div className={cn("flex items-center gap-0.5 sm:gap-1", className)} data-attr="portal-list-controls">
      {showGroup ? (
        <PortalListMenuButton
          label="Group"
          value={group}
          options={catalog.groupOptions}
          onChange={onGroupChange}
          dataAttr={`${listKey}-list-group-control`}
        />
      ) : null}
      <PortalListMenuButton
        label="Sort"
        value={sort}
        options={catalog.sortOptions}
        onChange={onSortChange}
        dataAttr={`${listKey}-list-sort-control`}
      />
    </div>
  );
}
