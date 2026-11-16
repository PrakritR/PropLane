import { handleAssistantReviewGet, handleAssistantReviewPost } from "@/lib/assistant-review/route.server";
import { requireKnowledgeActor } from "@/lib/one-number/knowledge/route-auth.server";

export const runtime = "nodejs";

/**
 * Assistant quality management for the manager's Communication (flag / correct / pause / resume, and the review list).
 * The signed-in manager's ACTIVE workspace and their Communication access in it are re-derived here (`requireKnowledgeActor`:
 * `read` to look, `edit` to change anything); the body never names a workspace. Admin has its own route.
 */
export async function GET(request: Request) {
  const result = await requireKnowledgeActor("read");
  if (!result.ok) return result.response;
  const { actor } = result;
  return handleAssistantReviewGet({ db: actor.db, userId: actor.userId, workspaceId: actor.workspaceId, ownerUserId: actor.ownerUserId }, new URL(request.url));
}

export async function POST(request: Request) {
  const result = await requireKnowledgeActor("edit");
  if (!result.ok) return result.response;
  const { actor } = result;
  return handleAssistantReviewPost({ db: actor.db, userId: actor.userId, workspaceId: actor.workspaceId, ownerUserId: actor.ownerUserId }, request);
}
