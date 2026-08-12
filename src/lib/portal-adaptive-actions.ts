import type { ReactNode } from "react";

export type PortalAdaptiveAction = {
  id: string;
  node: ReactNode;
  menuItem: ReactNode;
  /** Higher priority stays visible longer when horizontal space is tight. */
  keepPriority?: number;
  /** Never tuck into the … menu — always rendered inline. */
  alwaysVisible?: boolean;
  /** When alwaysVisible, pin to the leading edge (Filter) or trailing edge (primary CTA). */
  pinEdge?: "start" | "end";
};

/** @deprecated Use {@link PortalAdaptiveAction}. */
export type PortalAdaptiveHeaderAction = PortalAdaptiveAction;

export function splitAdaptiveActions(actions: PortalAdaptiveAction[]) {
  const leading: PortalAdaptiveAction[] = [];
  const optional: PortalAdaptiveAction[] = [];
  const trailing: PortalAdaptiveAction[] = [];
  for (const action of actions) {
    if (action.alwaysVisible) {
      if (action.pinEdge === "end") trailing.push(action);
      else leading.push(action);
    } else {
      optional.push(action);
    }
  }
  return { leading, optional, trailing };
}

/** @deprecated Use {@link splitAdaptiveActions}. */
export const splitAdaptiveHeaderActions = splitAdaptiveActions;

export function pickVisibleActions(actions: PortalAdaptiveAction[], fitCount: number): PortalAdaptiveAction[] {
  const { leading, optional, trailing } = splitAdaptiveActions(actions);
  if (fitCount >= optional.length) return [...leading, ...optional, ...trailing];
  if (fitCount <= 0) return [...leading, ...trailing];

  const ranked = [...optional].sort((a, b) => {
    const priorityDelta = (b.keepPriority ?? 0) - (a.keepPriority ?? 0);
    if (priorityDelta !== 0) return priorityDelta;
    return optional.indexOf(a) - optional.indexOf(b);
  });
  const visibleOptionalIds = new Set(ranked.slice(0, fitCount).map((action) => action.id));
  const visibleOptional = optional.filter((action) => visibleOptionalIds.has(action.id));
  return [...leading, ...visibleOptional, ...trailing];
}

export function pickAdaptiveActions(
  actions: PortalAdaptiveAction[],
  optionalFitCount: number,
): { visible: PortalAdaptiveAction[]; overflow: PortalAdaptiveAction[] } {
  const { leading, optional, trailing } = splitAdaptiveActions(actions);
  if (optionalFitCount >= optional.length) {
    return { visible: [...leading, ...optional, ...trailing], overflow: [] };
  }
  if (optionalFitCount <= 0) {
    return { visible: [...leading, ...trailing], overflow: optional };
  }

  const ranked = [...optional].sort((a, b) => {
    const priorityDelta = (b.keepPriority ?? 0) - (a.keepPriority ?? 0);
    if (priorityDelta !== 0) return priorityDelta;
    return optional.indexOf(a) - optional.indexOf(b);
  });
  const visibleOptionalIds = new Set(ranked.slice(0, optionalFitCount).map((action) => action.id));
  const visibleOptional = optional.filter((action) => visibleOptionalIds.has(action.id));
  const overflow = optional.filter((action) => !visibleOptionalIds.has(action.id));
  return { visible: [...leading, ...visibleOptional, ...trailing], overflow };
}

/** @deprecated Use {@link pickAdaptiveActions}. */
export const pickAdaptiveHeaderActions = pickAdaptiveActions;

function segmentWidth(widths: number[], gap: number): number {
  if (widths.length === 0) return 0;
  return widths.reduce((sum, width, index) => sum + width + (index > 0 ? gap : 0), 0);
}

/** Width of the row exactly as rendered for a given optional fit count. */
export function renderedAdaptiveRowWidth(
  actions: PortalAdaptiveAction[],
  optionalFitCount: number,
  widthFor: (action: PortalAdaptiveAction) => number,
  moreWidth: number,
  gap: number,
  options?: { reserveMore?: boolean },
): number {
  const { visible, overflow } = pickAdaptiveActions(actions, optionalFitCount);
  const { leading, optional: middle, trailing } = splitAdaptiveActions(visible);
  const widths: number[] = [];
  for (const action of leading) widths.push(widthFor(action));
  for (const action of middle) widths.push(widthFor(action));
  for (const action of trailing) widths.push(widthFor(action));
  if (overflow.length > 0 || options?.reserveMore) widths.push(moreWidth);
  return segmentWidth(widths, gap);
}

/** Pick the largest optional count whose rendered row still fits — partial inline rows, not all-or-nothing. */
export function resolveAdaptiveOptionalFitCount(
  actions: PortalAdaptiveAction[],
  widthFor: (action: PortalAdaptiveAction) => number,
  moreWidth: number,
  containerWidth: number,
  gap: number,
  options?: { reserveMore?: boolean },
): number {
  const { optional } = splitAdaptiveActions(actions);
  if (optional.length === 0) return 0;
  if (containerWidth <= 0) return optional.length;

  for (let count = optional.length; count >= 0; count--) {
    if (
      renderedAdaptiveRowWidth(actions, count, widthFor, moreWidth, gap, options) <= containerWidth
    ) {
      return count;
    }
  }
  return 0;
}

function totalRowWidth({
  leadingWidth,
  optionalWidths,
  optionalCount,
  trailingWidth,
  moreWidth,
  gap,
  reserveMore,
}: {
  leadingWidth: number;
  optionalWidths: number[];
  optionalCount: number;
  trailingWidth: number;
  moreWidth: number;
  gap: number;
  reserveMore: boolean;
}): number {
  const overflow = optionalWidths.length - optionalCount;
  const chunks: number[] = [];
  if (leadingWidth > 0) chunks.push(leadingWidth);
  const optionalUsed = segmentWidth(optionalWidths.slice(0, optionalCount), gap);
  if (optionalUsed > 0) chunks.push(optionalUsed);
  if (reserveMore && overflow > 0) chunks.push(moreWidth);
  if (trailingWidth > 0) chunks.push(trailingWidth);
  return segmentWidth(chunks, gap);
}

/**
 * When a filter chip shares {@link data-portal-action-slot}, subtract sibling widths
 * so the action row budget matches the flex child, not the whole slot.
 */
export function computeSharedSlotActionBudget(
  slotWidth: number,
  siblingWidths: number[],
  gapPx: number,
): number {
  if (slotWidth <= 0) return 0;
  const occupied = siblingWidths.reduce((sum, width) => sum + width, 0);
  const gapTotal = siblingWidths.length > 0 ? gapPx : 0;
  return Math.max(0, slotWidth - occupied - gapTotal);
}

export function fitOptionalBetweenEdges(
  leadingWidth: number,
  optionalWidths: number[],
  trailingWidth: number,
  containerWidth: number,
  moreWidth: number,
  gap: number,
): number {
  if (optionalWidths.length === 0) return 0;

  const syntheticActions: PortalAdaptiveAction[] = [
    ...(leadingWidth > 0
      ? [{ id: "__leading__", node: null, menuItem: null, alwaysVisible: true, pinEdge: "start" as const }]
      : []),
    ...optionalWidths.map((_, index) => ({
      id: `__optional_${index}__`,
      node: null,
      menuItem: null,
      keepPriority: optionalWidths.length - index,
    })),
    ...(trailingWidth > 0
      ? [{ id: "__trailing__", node: null, menuItem: null, alwaysVisible: true, pinEdge: "end" as const }]
      : []),
  ];

  const widthFor = (action: PortalAdaptiveAction) => {
    if (action.id === "__leading__") return leadingWidth;
    if (action.id === "__trailing__") return trailingWidth;
    const index = Number(action.id.replace("__optional_", "").replace("__", ""));
    return optionalWidths[index] ?? 0;
  };

  return resolveAdaptiveOptionalFitCount(syntheticActions, widthFor, moreWidth, containerWidth, gap);
}
