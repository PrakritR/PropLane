/**
 * How a Team thread is named in lists and headers. A Team thread is shared by
 * several managers and is never a person: the thread-level `from` is the
 * fixed label below, never the name of whoever happened to post first. The
 * poster's name belongs on each message bubble (`messages[].from`) only.
 *
 * One thread per workspace, named "Team · <workspace name>".
 */
export const TEAM_THREAD_DISPLAY_NAME = "Team";

export function teamThreadDisplayName(workspaceName?: string | null): string {
  const name = workspaceName?.trim();
  return name ? `${TEAM_THREAD_DISPLAY_NAME} · ${name}` : TEAM_THREAD_DISPLAY_NAME;
}

/** The neutral first line of a Team chat, so no person's first message is dressed as the thread's own. */
export const TEAM_ROOT_TEXT =
  "This is the team chat. Everyone in the workspace sees what is posted here; texts to the work number reach it too.";
