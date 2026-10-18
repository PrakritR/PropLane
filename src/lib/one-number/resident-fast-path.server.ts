import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";
import { loadAnswerableEntries } from "@/lib/one-number/knowledge/store.server";
import { loadOwnedProperty, resolveResidentKnowledgeScope } from "@/lib/one-number/knowledge/scope.server";
import {
  isFastPathCandidate,
  matchResidentFastPath,
  type FastPathAnswer,
} from "@/lib/one-number/resident-fast-path";

/**
 * The resident fast path, scoped. `ctx` comes from `resolveResidentSmsAgentContext`
 * (a phone VERIFIED on a profile, texting the work number of one of that resident's
 * managers). The scope is the same one the knowledge tool reads, so the rules are
 * not re-invented here:
 *   - the house is the resident's lease house, never one named in the text;
 *   - house details (Wi-Fi, door code, parking, trash, rules) only past the
 *     move-in lock (`includeHouseInfo`), exactly the `get_move_in_info` rule;
 *   - approved Q&A only in the audiences a resident may hear.
 * A door code therefore reaches only a current resident of that house. Any scope
 * miss (several managers, no house, an unresolved workspace) answers null and the
 * normal agent runs. Never throws.
 */
export async function tryResidentFastPath(
  db: SupabaseClient,
  ctx: ResidentAgentContext,
  text: string,
): Promise<FastPathAnswer | null> {
  try {
    if (!isFastPathCandidate(text)) return null;
    const resolved = await resolveResidentKnowledgeScope(db, ctx);
    if (!resolved.ok) return null;
    const scope = resolved.scope;
    if (!scope.focusPropertyId) return null;

    let houseInfo = null;
    if (scope.includeHouseInfo) {
      const property = await loadOwnedProperty(db, scope.ownerUserId, scope.focusPropertyId);
      if (property && property.workspaceId === scope.workspaceId) houseInfo = property.houseInfo;
    }
    const entries = await loadAnswerableEntries(db, {
      workspaceId: scope.workspaceId,
      allowedPropertyIds: scope.allowedPropertyIds,
      audiences: scope.audiences,
    });
    const knowledge = entries
      .filter((entry) => entry.propertyId === null || entry.propertyId === scope.focusPropertyId)
      .map((entry) => ({ question: entry.question, answer: entry.answer }));
    return matchResidentFastPath(text, { houseInfo, knowledge });
  } catch {
    return null;
  }
}
