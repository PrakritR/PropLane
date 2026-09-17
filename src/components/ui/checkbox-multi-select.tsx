"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  FIELD_SELECT_CHEVRON_CELL_CLASS,
  FIELD_SELECT_CHEVRON_CLASS,
  FIELD_SELECT_LABEL_CLASS,
  FIELD_SELECT_MENU_OPTION_CLASS,
  FIELD_SELECT_TRIGGER_CELL_CLASS,
  FIELD_SELECT_TRIGGER_CLASS,
  FIELD_SELECT_TRIGGER_INHERITED_CLASS,
  FIELD_SELECT_TRIGGER_PILL_CLASS,
  FIELD_SELECT_TRIGGER_INLINE_CLASS,
  partitionFieldSelectClasses,
} from "@/components/ui/field-select-styles";
import {
  FIELD_SELECT_MENU_DATA_ATTR,
  deferAfterFieldSelectPick,
} from "@/components/ui/field-select-portal-interaction";
import {
  FIELD_SELECT_OPTION_VALUE_ATTR,
  useFieldSelectListboxPointerPick,
} from "@/components/ui/field-select-listbox-pick";
import {
  FIELD_SELECT_MENU_SEARCH_PX,
  FIELD_SELECT_MENU_SHELL_CLASS,
  FIELD_SELECT_MENU_LISTBOX_SCROLL_CLASS,
  FIELD_SELECT_MENU_LISTBOX_FIT_CLASS,
  FIELD_SELECT_MENU_VISIBLE_ITEMS,
  FieldSelectMenuSearch,
  fieldSelectMenuContentPx,
  fieldSelectMenuFitsWithoutScroll,
  fieldSelectMenuListMaxHeightPx,
  fieldSelectMenuMatches,
  fieldSelectMenuZIndex,
  useFieldSelectMenu,
} from "@/components/ui/field-select-menu";

export { FIELD_SELECT_MENU_VISIBLE_ITEMS };

const matchesQuery = fieldSelectMenuMatches;

export type CheckboxMultiSelectOption = {
  value: string;
  label: string;
  /** Closed-trigger caption when it should be shorter than `label` (e.g. "+1"). */
  triggerLabel?: string;
  disabled?: boolean;
  /** Shown under the label — why a disabled option cannot be picked yet. */
  hint?: string;
};
export type CheckboxMultiSelectGroup = { label: string; options: CheckboxMultiSelectOption[] };

function summarizeSelection(
  selected: string[],
  options: CheckboxMultiSelectOption[],
  emptyLabel = "None selected",
): string {
  if (selected.length === 0) return emptyLabel;
  if (selected.length === 1) {
    return options.find((o) => o.value === selected[0])?.label ?? "1 selected";
  }
  // A short selection reads as itself ("Inbox, Email", "1 day, 30 minutes");
  // only a long one collapses to a count. Order follows the option list, not
  // the order the picks were made in, so the trigger is stable.
  const labels = options.filter((o) => selected.includes(o.value)).map((o) => o.label);
  const joined = labels.join(", ");
  if (labels.length === selected.length && joined.length <= 32) return joined;
  return `${selected.length} selected`;
}

export type FieldSelectVariant = "field" | "pill" | "cell";

function triggerClassForVariant(variant: FieldSelectVariant, hideLabel: boolean, extra?: string) {
  const base =
    variant === "pill"
      ? FIELD_SELECT_TRIGGER_PILL_CLASS
      : variant === "cell"
        ? FIELD_SELECT_TRIGGER_CELL_CLASS
        : hideLabel
          ? FIELD_SELECT_TRIGGER_INLINE_CLASS
          : FIELD_SELECT_TRIGGER_CLASS;
  // twMerge so a caller's size override (a 36px toolbar pill) beats the base tokens.
  return cn(base, extra);
}

/** Compact multi-select dropdown with checkboxes (opaque menu). */
export function CheckboxMultiSelect({
  label,
  options,
  groups,
  selected,
  onChange,
  disabled,
  readOnly = false,
  emptyMenuText = "No options",
  emptyLabel = "None selected",
  /** When set and `selected` is non-empty, shown on the trigger instead of summarizing selected labels. */
  selectionTriggerLabel,
  searchPlaceholder = "Search…",
  dataAttr,
  className,
  labelClassName,
  hideLabel = false,
  /** Toolbar compact width — same visual tokens as form fields. */
  variant = "field",
  menuFooter,
}: {
  label: string;
  options?: CheckboxMultiSelectOption[];
  groups?: CheckboxMultiSelectGroup[];
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** Menu opens and shows the current selection; picks cannot change it. */
  readOnly?: boolean;
  emptyMenuText?: string;
  emptyLabel?: string;
  selectionTriggerLabel?: string;
  searchPlaceholder?: string;
  dataAttr?: string;
  className?: string;
  labelClassName?: string;
  hideLabel?: boolean;
  variant?: FieldSelectVariant;
  /**
   * Footer under the option list. A function form receives `close` so a footer
   * action that leaves the menu (e.g. "Custom…" opening an inline entry) can
   * dismiss it — the menu otherwise only closes on an outside click.
   */
  menuFooter?: React.ReactNode | ((close: () => void) => React.ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // A cell (the listing wizard's card rows) opens and sizes like a pill: the
  // trigger is narrow, so the menu grows to its longest option instead of
  // wrapping every label onto two lines.
  const pill = variant === "pill" || variant === "cell";
  const { wrapperClassName, triggerClassName } = partitionFieldSelectClasses(className);

  const flatOptions = useMemo(() => {
    if (groups?.length) return groups.flatMap((g) => g.options);
    return options ?? [];
  }, [groups, options]);

  const showSearch = flatOptions.length > FIELD_SELECT_MENU_VISIBLE_ITEMS;
  const searchPx = showSearch ? FIELD_SELECT_MENU_SEARCH_PX : 0;
  const groupHeaderPx =
    groups?.length && flatOptions.length > 0
      ? groups.filter((group) => group.label).length * 26
      : 0;
  const visibleOptionRows = Math.min(
    Math.max(flatOptions.length, 1),
    FIELD_SELECT_MENU_VISIBLE_ITEMS,
  );
  const contentPx = fieldSelectMenuContentPx(visibleOptionRows, searchPx + groupHeaderPx);

  const setOpenAndReset = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };

  const { listId, isClient, wrapRef, buttonRef, menuRect, portalHost } = useFieldSelectMenu({
    open,
    onOpenChange: setOpenAndReset,
    contentPx,
    matchTriggerWidth: !pill,
    preferOpenDown: !pill,
    // The pill/cell menu is drawn 18rem wide (see the shell class below); telling
    // the placement that width keeps it inside a 390px phone instead of anchoring
    // a 288px menu to a 150px trigger at the right edge.
    minMenuWidth: pill ? 288 : undefined,
  });

  const toggle = (value: string) => {
    if (readOnly) return;
    const option = flatOptions.find((o) => o.value === value);
    if (option?.disabled) return;
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  };

  // Filtering only hides rows from view; the `selected` array is never mutated, so a
  // search never drops an already-selected option from the selection.
  const filteredGroups = useMemo(() => {
    if (!groups?.length) return null;
    if (!query.trim()) return groups;
    return groups
      .map((g) => ({ ...g, options: g.options.filter((o) => matchesQuery(o.label, query)) }))
      .filter((g) => g.options.length > 0);
  }, [groups, query]);

  const filteredOptions = useMemo(() => {
    if (groups?.length) return [];
    const base = options ?? [];
    if (!query.trim()) return base;
    return base.filter((o) => matchesQuery(o.label, query));
  }, [groups, options, query]);

  const listRef = useFieldSelectListboxPointerPick((value) => {
    if (readOnly) return;
    const option = flatOptions.find((o) => o.value === value);
    if (!option || option.disabled || disabled) return;
    toggle(value);
  });

  const renderCheckboxOption = (opt: CheckboxMultiSelectOption) => {
    const checked = selected.includes(opt.value);
    const optionDisabled = Boolean(disabled || readOnly || opt.disabled);
    return (
      <label
        key={opt.value}
        role="option"
        aria-selected={checked}
        aria-disabled={optionDisabled || undefined}
        {...{ [FIELD_SELECT_OPTION_VALUE_ATTR]: opt.value }}
        className={`flex items-start gap-2.5 px-3 py-2 text-sm ${FIELD_SELECT_MENU_OPTION_CLASS} ${
          optionDisabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
        }`}
      >
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-primary"
          checked={checked}
          disabled={optionDisabled}
          readOnly
          tabIndex={-1}
          aria-hidden
        />
        <span className="leading-snug text-foreground">
          {opt.label}
          {opt.hint ? <span className="mt-0.5 block text-xs text-muted">{opt.hint}</span> : null}
        </span>
      </label>
    );
  };

  const buttonLabel =
    selected.length > 0 && selectionTriggerLabel
      ? selectionTriggerLabel
      : summarizeSelection(selected, flatOptions, emptyLabel);

  const hasVisibleOptions = groups?.length
    ? (filteredGroups?.length ?? 0) > 0
    : filteredOptions.length > 0;

  const menu =
    open && menuRect && isClient && portalHost ? (
      <div
        id={listId}
        {...{ [FIELD_SELECT_MENU_DATA_ATTR]: "" }}
        className={`${FIELD_SELECT_MENU_SHELL_CLASS} ${pill ? "w-[min(18rem,calc(100vw-2rem))]" : ""}`}
        style={{
          position: menuRect.position,
          top: menuRect.top,
          left: menuRect.left,
          width: pill ? undefined : menuRect.width,
          maxHeight: menuRect.maxHeight,
          backgroundColor: "#ffffff",
          zIndex: fieldSelectMenuZIndex(portalHost),
        }}
      >
        {showSearch ? (
          <FieldSelectMenuSearch
            query={query}
            onQueryChange={setQuery}
            placeholder={searchPlaceholder}
            dataAttr={dataAttr ? `${dataAttr}-search` : undefined}
          />
        ) : null}
        <div
          ref={listRef}
          role="listbox"
          aria-multiselectable="true"
          aria-label={label}
          className={FIELD_SELECT_MENU_LISTBOX_SCROLL_CLASS}
          style={{
            touchAction: "pan-y",
            maxHeight: fieldSelectMenuListMaxHeightPx(menuRect.maxHeight, searchPx),
          }}
          onWheel={(event) => event.stopPropagation()}
          onTouchMove={(event) => event.stopPropagation()}
          onTouchStart={(event) => event.stopPropagation()}
        >
          {flatOptions.length === 0 ? (
            <p className="field-dropdown-menu-option px-3 py-2 text-sm text-muted">{emptyMenuText}</p>
          ) : !hasVisibleOptions ? (
            <p className="field-dropdown-menu-option px-3 py-2 text-sm text-muted">No matches</p>
          ) : groups?.length ? (
            // Index-keyed: several unlabeled groups can coexist (a section list
            // split around the people it reveals).
            (filteredGroups ?? []).map((group, groupIndex) => (
              <div key={`${group.label}-${groupIndex}`}>
                {group.label ? (
                  <p className="field-dropdown-menu-option sticky top-0 z-[1] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-muted">
                    {group.label}
                  </p>
                ) : null}
                {group.options.map((opt) => renderCheckboxOption(opt))}
              </div>
            ))
          ) : (
            filteredOptions.map((opt) => renderCheckboxOption(opt))
          )}
        </div>
        {menuFooter ? (
          <div className={`shrink-0 border-t border-border ${FIELD_SELECT_MENU_OPTION_CLASS}`}>
            {typeof menuFooter === "function" ? menuFooter(() => setOpenAndReset(false)) : menuFooter}
          </div>
        ) : null}
      </div>
    ) : null;

  return (
    <div ref={wrapRef} className={`relative ${pill ? "w-auto shrink-0" : /\bw-/.test(wrapperClassName) ? "" : "w-full"} ${wrapperClassName}`.trim()}>
      {!hideLabel && !pill ? (
        <label className={labelClassName ?? FIELD_SELECT_LABEL_CLASS}>{label}</label>
      ) : null}
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled && !readOnly}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        data-attr={dataAttr}
        className={triggerClassForVariant(variant, pill || hideLabel, triggerClassName)}
        onClick={() => {
          if (disabled && !readOnly) return;
          setOpenAndReset(!open);
        }}
      >
        <span className={`min-w-0 truncate ${selected.length === 0 ? "text-muted" : ""}`}>{buttonLabel}</span>
        <ChevronDown className={FIELD_SELECT_CHEVRON_CLASS} aria-hidden />
      </button>

      {menu && portalHost ? createPortal(menu, portalHost) : null}
    </div>
  );
}

/** Single-select field dropdown — same trigger/menu styling as CheckboxMultiSelect. */
export function FieldSingleSelect({
  label,
  options,
  groups,
  value,
  onChange,
  disabled,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  dataAttr,
  className,
  wrapperClassName: wrapperClassNameProp,
  triggerClassName: triggerClassNameProp,
  labelClassName,
  hideLabel = false,
  variant = "field",
  inherited = false,
  valueClassName,
  menuFooter,
}: {
  label: string;
  options?: CheckboxMultiSelectOption[];
  groups?: CheckboxMultiSelectGroup[];
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  dataAttr?: string;
  /** @deprecated Prefer wrapperClassName + triggerClassName */
  className?: string;
  wrapperClassName?: string;
  triggerClassName?: string;
  labelClassName?: string;
  hideLabel?: boolean;
  variant?: FieldSelectVariant;
  /** The value still follows a shared default (listing editor "every room" rows) — dashed, grey trigger. */
  inherited?: boolean;
  /** Extra classes on the value text (e.g. right padding so an overlaid control never covers it). */
  valueClassName?: string;
  menuFooter?: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const pill = variant === "pill";
  const cell = variant === "cell";
  const partitioned = partitionFieldSelectClasses(className);
  const wrapperClassName = wrapperClassNameProp ?? partitioned.wrapperClassName;
  const triggerClassName = [inherited ? FIELD_SELECT_TRIGGER_INHERITED_CLASS : "", triggerClassNameProp ?? partitioned.triggerClassName]
    .filter(Boolean)
    .join(" ");

  const flatOptions = useMemo(() => {
    if (groups?.length) return groups.flatMap((group) => group.options);
    return options ?? [];
  }, [groups, options]);

  const selectedOption = flatOptions.find((o) => o.value === value);
  const buttonLabel = selectedOption?.triggerLabel ?? selectedOption?.label ?? placeholder;
  const showSearch = flatOptions.length > FIELD_SELECT_MENU_VISIBLE_ITEMS;
  const searchPx = showSearch ? FIELD_SELECT_MENU_SEARCH_PX : 0;
  const groupHeaderPx =
    groups?.length && flatOptions.length > 0
      ? groups.filter((group) => group.label).length * 26
      : 0;
  const visibleOptionRows = Math.min(Math.max(flatOptions.length, 1), FIELD_SELECT_MENU_VISIBLE_ITEMS);
  const fitsWithoutScroll = fieldSelectMenuFitsWithoutScroll(flatOptions.length, searchPx + groupHeaderPx);
  const contentPx = fieldSelectMenuContentPx(visibleOptionRows, searchPx + groupHeaderPx);

  const setOpenAndReset = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };

  // A grid cell is narrow (a 120px Floor column); its menu grows to the longest
  // option instead of wrapping "Shower only" onto two lines, the way a pill does.
  const growToContent = pill || cell;
  const { listId, isClient, wrapRef, buttonRef, menuRect, portalHost } = useFieldSelectMenu({
    open,
    onOpenChange: setOpenAndReset,
    contentPx,
    matchTriggerWidth: !growToContent,
    preferOpenDown: !pill,
    // A grown menu may reach 18rem; placing it as that wide keeps it on screen.
    minMenuWidth: growToContent ? 288 : undefined,
  });

  const filteredGroups = useMemo(() => {
    if (!groups?.length) return null;
    if (!query.trim()) return groups;
    return groups
      .map((group) => ({
        ...group,
        options: group.options.filter((option) => matchesQuery(option.label, query)),
      }))
      .filter((group) => group.options.length > 0);
  }, [groups, query]);

  const filteredOptions = useMemo(() => {
    if (groups?.length) return [];
    const base = options ?? [];
    if (!query.trim()) return base;
    return base.filter((option) => matchesQuery(option.label, query));
  }, [groups, options, query]);

  const hasVisibleOptions = groups?.length
    ? (filteredGroups?.length ?? 0) > 0
    : filteredOptions.length > 0;

  const attachListPick = useFieldSelectListboxPointerPick((pickedValue) => {
    const option = flatOptions.find((o) => o.value === pickedValue);
    if (!option || option.disabled || disabled) return;
    onChange(pickedValue);
    deferAfterFieldSelectPick(() => setOpenAndReset(false));
  });
  const listRef = useCallback(
    (list: HTMLDivElement | null) => {
      attachListPick(list);
      if (!list) return;
      const selected = list.querySelector('[aria-selected="true"]');
      if (selected instanceof HTMLElement) {
        selected.scrollIntoView?.({ block: "center", inline: "nearest" });
      }
    },
    [attachListPick],
  );

  const renderOption = (opt: CheckboxMultiSelectOption) => {
    const active = opt.value === value;
    const optionDisabled = Boolean(disabled || opt.disabled);
    return (
      <button
        key={opt.value}
        type="button"
        role="option"
        aria-selected={active}
        aria-disabled={optionDisabled || undefined}
        disabled={optionDisabled}
        {...{ [FIELD_SELECT_OPTION_VALUE_ATTR]: opt.value }}
        className={`flex w-full items-start gap-2.5 px-3 py-2 text-left text-sm ${FIELD_SELECT_MENU_OPTION_CLASS} text-foreground ${
          optionDisabled ? "cursor-not-allowed opacity-50" : ""
        }`}
      >
        <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-primary" aria-hidden>
          {active ? "✓" : ""}
        </span>
        {/*
          Wraps rather than `whitespace-nowrap`. The menu is width-matched to
          its trigger, so a label longer than the field — an email address, a
          long property name — ran straight out past the menu's own edge
          instead of fitting inside it. `break-words` keeps a long unbroken
          token (an address with no spaces) inside too.
        */}
        <span className="min-w-0 break-words text-left leading-snug">{opt.label}</span>
      </button>
    );
  };

  const menu =
    open && menuRect && isClient && portalHost ? (
      <div
        id={listId}
        {...{ [FIELD_SELECT_MENU_DATA_ATTR]: "" }}
        className={`${FIELD_SELECT_MENU_SHELL_CLASS} ${fitsWithoutScroll ? "overflow-visible" : ""} ${growToContent ? "w-max max-w-[min(18rem,calc(100vw-2rem))]" : ""}`}
        style={{
          position: menuRect.position,
          top: menuRect.top,
          left: menuRect.left,
          minWidth: growToContent ? menuRect.width : undefined,
          width: growToContent ? undefined : menuRect.width,
          ...(fitsWithoutScroll
            ? {}
            : {
                maxHeight: menuRect.maxHeight,
              }),
          backgroundColor: "#ffffff",
          zIndex: fieldSelectMenuZIndex(portalHost),
        }}
      >
        {showSearch ? (
          <FieldSelectMenuSearch
            query={query}
            onQueryChange={setQuery}
            placeholder={searchPlaceholder}
            dataAttr={dataAttr ? `${dataAttr}-search` : undefined}
          />
        ) : null}
        <div
          ref={listRef}
          role="listbox"
          aria-label={label}
          className={fitsWithoutScroll ? FIELD_SELECT_MENU_LISTBOX_FIT_CLASS : FIELD_SELECT_MENU_LISTBOX_SCROLL_CLASS}
          style={
            fitsWithoutScroll
              ? { touchAction: "pan-y" }
              : {
                  touchAction: "pan-y",
                  maxHeight: fieldSelectMenuListMaxHeightPx(menuRect.maxHeight, searchPx),
                }
          }
          onWheel={(event) => event.stopPropagation()}
          onTouchMove={(event) => event.stopPropagation()}
          onTouchStart={(event) => event.stopPropagation()}
        >
          {flatOptions.length === 0 ? (
            <p className="field-dropdown-menu-option px-3 py-2 text-sm text-muted">No options</p>
          ) : !hasVisibleOptions ? (
            <p className="field-dropdown-menu-option px-3 py-2 text-sm text-muted">No matches</p>
          ) : groups?.length ? (
            (filteredGroups ?? []).map((group) => (
              <div key={group.label || "__leading__"}>
                {group.label ? (
                  <p className="field-dropdown-menu-option sticky top-0 z-[1] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-muted">
                    {group.label}
                  </p>
                ) : null}
                {group.options.map((opt) => renderOption(opt))}
              </div>
            ))
          ) : (
            filteredOptions.map((opt) => renderOption(opt))
          )}
        </div>
        {menuFooter ? (
          <div className="border-t border-border px-2 py-1.5">
            {typeof menuFooter === "function" ? menuFooter(() => setOpenAndReset(false)) : menuFooter}
          </div>
        ) : null}
      </div>
    ) : null;

  // Toolbar Selects often pass `w-auto shrink-0` via className → wrapperClassName.
  // Do not force `w-full` on top of that — it crushed sibling search fields (PRP-376).
  const defaultWidthClass = pill
    ? "w-auto shrink-0"
    : /\bw-/.test(wrapperClassName)
      ? ""
      : "w-full";

  return (
    <div ref={wrapRef} className={`relative ${defaultWidthClass} ${wrapperClassName}`.trim()}>
      {!hideLabel && !pill && !cell ? (
        <label className={labelClassName ?? FIELD_SELECT_LABEL_CLASS}>{label}</label>
      ) : null}
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        data-attr={dataAttr}
        className={triggerClassForVariant(variant, hideLabel || pill || cell, triggerClassName)}
        onClick={() => setOpenAndReset(!open)}
      >
        <span className={`min-w-0 ${pill ? "whitespace-nowrap" : "truncate"} ${value ? "" : "text-muted"} ${valueClassName ?? ""}`.trim()}>{buttonLabel}</span>
        <ChevronDown className={cell ? FIELD_SELECT_CHEVRON_CELL_CLASS : FIELD_SELECT_CHEVRON_CLASS} aria-hidden />
      </button>

      {menu && portalHost ? createPortal(menu, portalHost) : null}
    </div>
  );
}
