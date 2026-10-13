/**
 * Which tab a stage-bucketed list (Tasks, Services) should open on.
 *
 * A URL that names a tab (`/tasks/assigned`) always wins. When it names none
 * (`/tasks`), the list opens on the current tab if it has rows, else on the
 * first tab, in the order shown, that does. Returns the tab to move to, or
 * null to stay put (the URL names a tab, the current tab has rows, or no tab
 * has any rows yet).
 */
export function firstNonEmptyTabToOpen<T extends string>(
  tabs: ReadonlyArray<{ id: T; count?: number }>,
  activeId: T,
  urlNamesTab: boolean,
): T | null {
  if (urlNamesTab) return null;
  const active = tabs.find((tab) => tab.id === activeId);
  if ((active?.count ?? 0) > 0) return null;
  const next = tabs.find((tab) => tab.id !== activeId && (tab.count ?? 0) > 0);
  return next ? next.id : null;
}
