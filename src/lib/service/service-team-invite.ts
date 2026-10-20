/**
 * The request body for inviting a helper to a service workspace from one box: an email when it has an "@", else a
 * PropLane ID. Null for an empty box. Pure, shared by the Team pane and its test.
 */
export function serviceInviteBody(workspaceId: string, typed: string): Record<string, unknown> | null {
  const value = typed.trim();
  if (!value) return null;
  return value.includes("@")
    ? { action: "team-invite", id: workspaceId, email: value }
    : { action: "team-invite", id: workspaceId, proplaneId: value };
}
