import "server-only";

import { draftPostFromIdea } from "./draft.server";
import { pickIdeas } from "./ideas.server";

/** Draft `n` posts from weighted ideas. One failing draft does not stop the others. */
export async function runDraftStep(n = 3) {
  const ideas = await pickIdeas(n);
  const drafted: string[] = [];
  const errors: string[] = [];
  for (const idea of ideas) {
    try {
      drafted.push((await draftPostFromIdea(idea)).id);
    } catch (e) {
      errors.push(`${idea.title}: ${e instanceof Error ? e.message : "draft failed"}`);
    }
  }
  return { picked: ideas.length, drafted, errors };
}
