"use client";

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import {
  FIELD_SELECT_CHEVRON_CLASS,
  FIELD_SELECT_LABEL_CLASS,
  FIELD_SELECT_MENU_OPTION_CLASS,
  FIELD_SELECT_TRIGGER_CLASS,
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

export type CheckboxMultiSelectOption = { value: string; label: string; disabled?: boolean };
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
  return `${selected.length} selected`;
}

function triggerClassForVariant(variant: "field" | "pill", hideLabel: boolean, extra?: string) {
  const base =
    variant === "pill"
      ? FIELD_SELECT_TRIGGER_PILL_CLASS
      : hideLabel
        ? FIELD_SELECT_TRIGGER_INLINE_CLASS
        : FIELD_SELECT_TRIGGER_CLASS;
  return extra ? `${base} ${extra}`.trim() : base;
}

/** Compact multi-select dropdown with checkboxes (opaque menu). */
export function CheckboxMultiSelect({
  label,
  options,
  groups,
  selected,
  onChange,
  disabled,
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
  emptyMenuText?: string;
  emptyLabel?: string;
  selectionTriggerLabel?: string;
  searchPlaceholder?: string;
  dataAttr?: string;
  className?: string;
  labelClassName?: string;
  hideLabel?: boolean;
  variant?: "field" | "pill";
  menuFooter?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const pill = variant === "pill";
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
  });

  const toggle = (value: string) => {
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
    const option = flatOptions.find((o) => o.value === value);
    if (!option || option.disabled || disabled) return;
    toggle(value);
  });

  const renderCheckboxOption = (opt: CheckboxMultiSelectOption) => {
    const checked = selected.includes(opt.value);
    const optionDisabled = Boolean(disabled || opt.disabled);
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
        <span className="leading-snug text-foreground">{opt.label}</span>
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
            (filteredGroups ?? []).map((group) => (
              <div key={group.label || "__leading__"}>
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
          <div className={`shrink-0 border-t border-border ${FIELD_SELECT_MENU_OPTION_CLASS}`}>{menuFooter}</div>
        ) : null}
      </div>
    ) : null;

  return (
    <div ref={wrapRef} className={`relative ${pill ? "w-auto shrink-0" : "w-full"} ${wrapperClassName}`.trim()}>
      {!hideLabel && !pill ? (
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
        className={triggerClassForVariant(variant, pill || hideLabel, triggerClassName)}
        onClick={() => setOpenAndReset(!open)}
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
  variant?: "field" | "pill";
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const pill = variant === "pill";
  const partitioned = partitionFieldSelectClasses(className);
  const wrapperClassName = wrapperClassNameProp ?? partitioned.wrapperClassName;
  const triggerClassName = triggerClassNameProp ?? partitioned.triggerClassName;

  const flatOptions = useMemo(() => {
    if (groups?.length) return groups.flatMap((group) => group.options);
    return options ?? [];
  }, [groups, options]);

  const buttonLabel = flatOptions.find((o) => o.value === value)?.label ?? placeholder;
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

  const { listId, isClient, wrapRef, buttonRef, menuRect, portalHost } = useFieldSelectMenu({
    open,
    onOpenChange: setOpenAndReset,
    contentPx,
    matchTriggerWidth: !pill,
    preferOpenDown: !pill,
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

  const listRef = useFieldSelectListboxPointerPick((pickedValue) => {
    const option = flatOptions.find((o) => o.value === pickedValue);
    if (!option || option.disabled || disabled) return;
    onChange(pickedValue);
    deferAfterFieldSelectPick(() => setOpenAndReset(false));
  });

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
        className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm ${FIELD_SELECT_MENU_OPTION_CLASS} text-foreground ${
          optionDisabled ? "cursor-not-allowed opacity-50" : ""
        }`}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-primary" aria-hidden>
          {active ? "✓" : ""}
        </span>
        <span className="whitespace-nowrap leading-snug">{opt.label}</span>
      </button>
    );
  };

  const menu =
    open && menuRect && isClient && portalHost ? (
      <div
        id={listId}
        {...{ [FIELD_SELECT_MENU_DATA_ATTR]: "" }}
        className={`${FIELD_SELECT_MENU_SHELL_CLASS} ${fitsWithoutScroll ? "overflow-visible" : ""} ${pill ? "w-max max-w-[min(18rem,calc(100vw-2rem))]" : ""}`}
        style={{
          position: menuRect.position,
          top: menuRect.top,
          left: menuRect.left,
          minWidth: pill ? menuRect.width : undefined,
          width: pill ? undefined : menuRect.width,
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
      </div>
    ) : null;

  return (
    <div ref={wrapRef} className={`relative ${pill ? "w-auto shrink-0" : "w-full"} ${wrapperClassName}`.trim()}>
      {!hideLabel && !pill ? (
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
        className={triggerClassForVariant(variant, hideLabel || pill, triggerClassName)}
        onClick={() => setOpenAndReset(!open)}
      >
        <span className={`min-w-0 ${pill ? "whitespace-nowrap" : "truncate"} ${value ? "" : "text-muted"}`}>{buttonLabel}</span>
        <ChevronDown className={FIELD_SELECT_CHEVRON_CLASS} aria-hidden />
      </button>

      {menu && portalHost ? createPortal(menu, portalHost) : null}
    </div>
  );
}
