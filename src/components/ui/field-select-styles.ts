/** Canonical field dropdown trigger/menu tokens — matches `Select` in `input.tsx`. */

/** With built-in uppercase label above the control. */
export const FIELD_SELECT_TRIGGER_CLASS =
  "mt-1 flex min-h-[44px] w-full items-center justify-between gap-2 rounded-2xl border border-border bg-auth-input-bg px-4 text-left text-[16px] text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.03)] outline-none transition-[border-color,background-color,box-shadow] duration-200 hover:border-primary/25 focus:border-primary/40 focus:ring-4 focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm";

/** Parent label supplies the field caption (Select, hideLabel, modals). */
export const FIELD_SELECT_TRIGGER_INLINE_CLASS =
  "flex min-h-[44px] w-full items-center justify-between gap-2 rounded-2xl border border-border bg-auth-input-bg px-4 text-left text-[16px] text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.03)] outline-none transition-[border-color,background-color,box-shadow] duration-200 hover:border-primary/25 focus:border-primary/40 focus:ring-4 focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm";

/** Compact width for toolbar/filter rows — same visual tokens as the form field trigger. */
export const FIELD_SELECT_TRIGGER_PILL_CLASS =
  "inline-flex min-h-[44px] w-auto max-w-full items-center justify-between gap-2 rounded-2xl border border-border bg-auth-input-bg px-4 text-left text-sm text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.03)] outline-none transition-[border-color,background-color,box-shadow] duration-200 hover:border-primary/25 focus:border-primary/40 focus:ring-4 focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-50";

/** Page-header pill (dashboard / finances period) — 36px, fully round, semibold — layered over the pill base. */
export const FIELD_SELECT_TRIGGER_TOOLBAR_PILL_CLASS = "min-h-9 rounded-full bg-card px-3 text-[12.5px] font-semibold";

export const FIELD_SELECT_TRIGGER_COMPACT_CLASS =
  "flex min-h-[44px] min-w-[9.5rem] max-w-full w-full items-center justify-between gap-2 rounded-2xl border border-border bg-auth-input-bg px-4 text-left text-sm text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.03)] outline-none transition-[border-color,background-color,box-shadow] duration-200 hover:border-primary/25 focus:border-primary/40 focus:ring-4 focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Grid-row cell — the listing editor, fee cadence, quiet hours. Sized to sit
 * beside a 36px text input (same radius, 13px text) so the row keeps one
 * height; opens the same white portaled menu as every other field.
 */
export const FIELD_SELECT_TRIGGER_CELL_CLASS =
  "flex min-h-[36px] w-full items-center justify-between gap-1.5 rounded-lg border border-border bg-auth-input-bg py-1 pl-2.5 pr-2 text-left text-[13px] text-foreground outline-none transition-[border-color,background-color,box-shadow] duration-200 hover:border-primary/25 focus:border-primary/40 focus:ring-4 focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-60 [html[data-native]_&]:min-h-[44px]";

/** A cell that still follows its "every row" default — dashed and grey until it takes its own value. */
export const FIELD_SELECT_TRIGGER_INHERITED_CLASS = "border-dashed bg-accent/15 text-muted";

export const FIELD_SELECT_MENU_CLASS =
  "field-dropdown-menu max-h-64 overflow-auto rounded-2xl border border-border py-1 shadow-[0_16px_40px_-12px_rgba(15,23,42,0.35)]";

/** Opaque row surface — backgrounds owned by `.field-dropdown-menu-option` in globals.css. */
export const FIELD_SELECT_MENU_OPTION_CLASS = "field-dropdown-menu-option";

export const FIELD_SELECT_LABEL_CLASS = "text-[11px] font-bold uppercase tracking-[0.12em] text-muted";

export const FIELD_SELECT_CHEVRON_CLASS = "h-4 w-4 shrink-0 text-muted";

export const FIELD_SELECT_CHEVRON_CELL_CLASS = "h-3.5 w-3.5 shrink-0 text-muted";

const DROP_EXACT = new Set([
  "border",
  "border-border",
  "outline-none",
  "appearance-none",
  "text-foreground",
  "text-sm",
  "text-xs",
  "font-semibold",
  "bg-card",
  "bg-auth-input-bg",
]);

const DROP_PREFIXES = [
  "rounded-",
  "bg-",
  "shadow-",
  "ring-",
  "focus:",
  "hover:border",
  "px-",
  "py-",
  "pr-8",
  "pr-9",
  "pr-10",
  "transition",
  "duration-",
];

function shouldDropLegacyVisualToken(token: string): boolean {
  if (DROP_EXACT.has(token)) return true;
  return DROP_PREFIXES.some((prefix) => token.startsWith(prefix));
}

function isLayoutToken(token: string): boolean {
  return /^(w-|min-w-|max-w-|shrink|grow|flex-|col-span-|self-|basis-|mt-|mb-|ml-|mr-)/.test(token);
}

/** Split legacy Select className so visual tokens stay on the trigger only (single box). */
export function partitionFieldSelectClasses(className = ""): {
  wrapperClassName: string;
  triggerClassName: string;
} {
  const wrapper: string[] = [];
  const trigger: string[] = [];

  for (const token of className.split(/\s+/).filter(Boolean)) {
    if (shouldDropLegacyVisualToken(token)) continue;
    if (token.startsWith("h-") || token.startsWith("min-h-") || token.startsWith("max-h-")) {
      trigger.push(token);
      continue;
    }
    if (isLayoutToken(token)) {
      wrapper.push(token);
      continue;
    }
    if (token.startsWith("disabled:")) {
      trigger.push(token);
      continue;
    }
  }

  return { wrapperClassName: wrapper.join(" "), triggerClassName: trigger.join(" ") };
}
