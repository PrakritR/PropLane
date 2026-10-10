/**
 * The owners whose `portal_inbox_thread_records` the inbox store query fetches:
 * every owner whose houses the viewer holds (`scope.ownerIds`), plus every owner
 * whose workspace Team chat the viewer belongs to. The extra owners' other rows
 * come back from the store but `conversationVisible` drops them (no granted
 * house), so the only thing a zero-house teammate gains is the chat. Pure.
 */
export function inboxStoreOwnerIds(scope: {
  ownerIds: readonly string[];
  teamWorkspacesByOwner?: ReadonlyMap<string, unknown>;
}): string[] {
  return [...new Set([...scope.ownerIds, ...(scope.teamWorkspacesByOwner?.keys() ?? [])])];
}
