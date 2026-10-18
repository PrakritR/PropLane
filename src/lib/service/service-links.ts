/**
 * Link slots other workstreams fill in. The owner's Finances (balance, PropLane cut, vendor deductions, statement,
 * withdraw) is W17 v2 and is NOT built here: it returns the href of a service workspace's Finances page once that
 * exists, and `null` until then, so the Service row menu draws nothing for it.
 */
export function serviceWorkspaceFinancesHref(_workspaceId: string): string | null {
  return null;
}
