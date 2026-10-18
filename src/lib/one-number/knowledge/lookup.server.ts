import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { houseInfoRenderSections } from "@/lib/house-info";
import { rankByOverlap } from "./ranking";
import { loadAnswerableEntries, recordEntryUse } from "./store.server";
import { loadOwnedProperty, loadWorkspaceProperties, type PropertyBrief } from "./scope.server";
import { detectAlwaysEscalate, REPLY_TOPIC_LABELS, type AlwaysEscalateTopic } from "./topics";
import type { KnowledgeScope } from "./types";

export type KnowledgeAnswer = {
  question: string;
  answer: string;
  topic: string;
  appliesTo: "this house" | "all houses" | string;
};

export type HouseDetailHit = { house: string; section: string; rows: { label: string; value: string }[] };

export type KnowledgeLookupResult = {
  found: boolean;
  answers: KnowledgeAnswer[];
  houseDetails: HouseDetailHit[];
  /** When set, the texter's question is one the agent must hand to the team whatever is found. */
  mustEscalate: AlwaysEscalateTopic | null;
  guidance: string;
};

export const NOT_FOUND_GUIDANCE =
  'Nothing approved covers this. Say "Let me check with the team" and escalate. Do not guess.';

export async function lookupPropertyKnowledge(
  db: SupabaseClient,
  scope: KnowledgeScope,
  question: string,
): Promise<KnowledgeLookupResult> {
  const mustEscalate = detectAlwaysEscalate(question);

  const entries = await loadAnswerableEntries(db, {
    workspaceId: scope.workspaceId,
    allowedPropertyIds: scope.allowedPropertyIds,
    audiences: scope.audiences,
  });
  // With a known house, only that house's entries and the team-wide ones apply.
  const applicable = entries.filter(
    (e) => e.propertyId === null || !scope.focusPropertyId || e.propertyId === scope.focusPropertyId,
  );
  const rankedEntries = rankByOverlap(
    question,
    applicable,
    (e) => ({ primary: e.question, secondary: e.answer, houseSpecific: e.propertyId !== null }),
    { limit: 4 },
  );

  const houseDetails: HouseDetailHit[] = [];
  // includeHouseInfo is only true when the scope already proved the asker may read house details
  // (a manager, or a resident past the move-in lock). Prospects and vendors never get here.
  if (scope.includeHouseInfo) {
    let houses: PropertyBrief[] = [];
    if (scope.focusPropertyId) {
      const one = await loadOwnedProperty(db, scope.ownerUserId, scope.focusPropertyId);
      houses = one && one.workspaceId === scope.workspaceId ? [one] : [];
    } else if (scope.viewer === "manager") {
      houses = await loadWorkspaceProperties(db, scope.ownerUserId, scope.workspaceId, scope.allowedPropertyIds);
    }
    const sections = houses.flatMap((house) =>
      houseInfoRenderSections(house.houseInfo)
        .map((section) => ({ house, section })),
    );
    const rankedSections = rankByOverlap(
      question,
      sections,
      ({ section }) => ({
        primary: section.label,
        secondary: section.rows.map((r) => `${r.label} ${r.value}`).join(" "),
        houseSpecific: true,
      }),
      { limit: 3 },
    );
    for (const { item } of rankedSections) {
      houseDetails.push({
        house: item.house.label,
        section: item.section.label,
        rows: item.section.rows.map((r) => ({ label: r.label, value: r.value })),
      });
    }
  }

  const used = rankedEntries.map((r) => r.item);
  if (used.length) await recordEntryUse(db, scope.workspaceId, used);

  const answers: KnowledgeAnswer[] = used.map((e) => ({
    question: e.question,
    answer: e.answer,
    topic: REPLY_TOPIC_LABELS[e.topic],
    appliesTo: e.propertyId ? "this house" : "all houses",
  }));
  const found = answers.length > 0 || houseDetails.length > 0;
  return {
    found,
    answers,
    houseDetails,
    mustEscalate,
    guidance: mustEscalate
      ? `This touches ${mustEscalate.replace("_", " ")}. Always hand it to the team: tell the person the team will follow up, then escalate.`
      : found
        ? "Answer only from these approved facts and the house details. If they do not fully cover the question, say so and escalate."
        : NOT_FOUND_GUIDANCE,
  };
}
