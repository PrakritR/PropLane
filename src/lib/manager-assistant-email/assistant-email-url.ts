/**
 * The URL every reader of `GET /api/manager/assistant-email` asks for.
 *
 * The route answers for the ACTIVE workspace (its cookie), and ignores a
 * `workspaceId` query. The query is only a cache key: `sharedGet` keys on the
 * full URL, so the work-number card, the reply composer and the listing hooks
 * share one request per workspace and a workspace switch reads a fresh answer.
 */
export function assistantEmailUrl(workspaceId: string | null | undefined): string {
  const id = String(workspaceId ?? "").trim();
  return `/api/manager/assistant-email${id ? `?workspaceId=${encodeURIComponent(id)}` : ""}`;
}
