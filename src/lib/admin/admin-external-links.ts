/**
 * Deep links from an admin account record into the product's analytics tools.
 * Built only from optional configuration — a link whose configuration is
 * absent is `null` and the UI omits it; nothing is guessed.
 *
 *  - PostHog identifies users by their Supabase user id
 *    (`posthog.identify(userId)`), so the person page is keyed on that id.
 *    Needs `POSTHOG_PROJECT_ID` (app host defaults to us.posthog.com;
 *    override with `POSTHOG_APP_URL`).
 *  - Langfuse traces are stamped with `landlordId` and the acting user id; for
 *    a manager both are the account id, so the Langfuse user page for that id
 *    lists the account's AI traces. Needs `LANGFUSE_PROJECT_ID`; the base URL
 *    is the existing `LANGFUSE_BASE_URL` (default us.cloud.langfuse.com).
 */
function trimBase(url: string): string {
  return url.replace(/\/+$/, "");
}

export function adminSessionReplaysUrl(userId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const projectId = env.POSTHOG_PROJECT_ID?.trim();
  if (!projectId || !userId.trim()) return null;
  const base = trimBase(env.POSTHOG_APP_URL?.trim() || "https://us.posthog.com");
  return `${base}/project/${encodeURIComponent(projectId)}/person/${encodeURIComponent(userId)}#activeTab=sessionRecordings`;
}

export function adminAiTracesUrl(userId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const projectId = env.LANGFUSE_PROJECT_ID?.trim();
  if (!projectId || !userId.trim()) return null;
  const base = trimBase(env.LANGFUSE_BASE_URL?.trim() || "https://us.cloud.langfuse.com");
  return `${base}/project/${encodeURIComponent(projectId)}/users/${encodeURIComponent(userId)}`;
}
