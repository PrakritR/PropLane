/**
 * A Team chat is stored once and read by several people, so "which lines are
 * mine" is decided at read time: a line is the viewer's (outbound, right) when
 * its `actorUserId` is the viewer, everyone else's is inbound with the poster's
 * name, and the neutral first line is never the viewer's. Pure; a row that is
 * not a team thread, or a legacy line with no actor, is returned unchanged
 * apart from the neutral root.
 */
export function teamThreadRowForViewer(row: Record<string, unknown>, viewerUserId: string): Record<string, unknown> {
  const viewer = viewerUserId.trim();
  const messages = Array.isArray(row.messages) ? (row.messages as Array<Record<string, unknown>>) : [];
  return {
    ...row,
    rootOutbound: false,
    messages: messages.map((message) => {
      const actor = typeof message.actorUserId === "string" ? message.actorUserId.trim() : "";
      return actor ? { ...message, outbound: viewer !== "" && actor === viewer } : message;
    }),
  };
}
