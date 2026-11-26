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
  /** PropLane Service staff: the ACTIVE managed workspace -> its client owner (server-derived from the seat). */
  staffWorkspaceOwners?: ReadonlyMap<string, string>;
}): string[] {
  // Staff run a managed workspace for its client owner: that owner's rows are fetched too, and
  // `conversationVisible` still decides which of them show. Without this the client-owned conversations of the
  // workspace were never read (list), nor found (open, send, mark read, archive) by the staff running it.
  return [
    ...new Set([
      ...scope.ownerIds,
      ...(scope.teamWorkspacesByOwner?.keys() ?? []),
      ...(scope.staffWorkspaceOwners?.values() ?? []),
    ]),
  ];
}
