/**
 * How a Team thread is named in lists and headers. A Team thread is shared by
 * several managers and is never a person: the thread-level `from` is the
 * fixed label below, never the name of whoever happened to post first. The
 * poster's name belongs on each message bubble (`messages[].from`) only.
 *
 * Stage 2 moves the id to one thread per workspace and widens this to
 * "Team · <workspace name>"; every caller already goes through here.
 */
export const TEAM_THREAD_DISPLAY_NAME = "Team";

export function teamThreadDisplayName(workspaceName?: string | null): string {
  const name = workspaceName?.trim();
  return name ? `${TEAM_THREAD_DISPLAY_NAME} · ${name}` : TEAM_THREAD_DISPLAY_NAME;
}
