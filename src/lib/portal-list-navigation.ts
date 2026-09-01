export type PortalListNavigation = {
  positionLabel: string;
  prevHref?: string;
  nextHref?: string;
};

/** Prev/next controls for a filtered portal list (applications, residents, …). */
export function buildPortalListNavigation<T>(
  items: readonly T[],
  currentIndex: number,
  hrefFor: (item: T) => string,
): PortalListNavigation | undefined {
  if (items.length <= 1 || currentIndex < 0) return undefined;
  return {
    positionLabel: `${currentIndex + 1} of ${items.length}`,
    prevHref: currentIndex > 0 ? hrefFor(items[currentIndex - 1]!) : undefined,
    nextHref: currentIndex < items.length - 1 ? hrefFor(items[currentIndex + 1]!) : undefined,
  };
}
