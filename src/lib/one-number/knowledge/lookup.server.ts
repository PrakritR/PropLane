import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { houseInfoRenderSections } from "@/lib/house-info";
import { rankByOverlap } from "./ranking";
import { loadAnswerableEntries, recordEntryUse } from "./store.server";
import { loadOwnedProperty, loadWorkspaceProperties, type PropertyBrief } from "./scope.server";
import { detectAlwaysEscalate, REPLY_TOPIC_LABELS, type AlwaysEscalateTopic } from "./topics";
import { houseInfoForScope, type KnowledgeScope } from "./types";
import { houseManualForScope, isDisputeText, type HouseManualSection } from "./house-manual";

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
  /** The house manual (rules + general info), quoted data. Fees and policies live here: answer from it. Absent when none is on file or the asker may not read house details. */
  houseManual?: HouseManualSection[];
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
  const houseManual: HouseManualSection[] = [];
  // includeHouseInfo is only true when the scope already proved the asker may read house details
  // (a manager, or a resident past the move-in lock). Prospects and vendors never get here, and the
  // codes inside those details wait for `includeHouseSecrets` (`houseInfoForScope`).
  if (scope.includeHouseInfo) {
    let houses: PropertyBrief[] = [];
    if (scope.focusPropertyId) {
      const one = await loadOwnedProperty(db, scope.ownerUserId, scope.focusPropertyId);
      houses = one && one.workspaceId === scope.workspaceId ? [one] : [];
    } else if (scope.viewer === "manager") {
      houses = await loadWorkspaceProperties(db, scope.ownerUserId, scope.workspaceId, scope.allowedPropertyIds);
    }
    // The manual is read for the one focus house only (a manager asking across houses uses the structured sections).
    if (scope.focusPropertyId && houses[0]) houseManual.push(...houseManualForScope(scope, houses[0]));
    const sections = houses.flatMap((house) =>
      houseInfoRenderSections(houseInfoForScope(scope, house))
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
  // A plain question about a WRITTEN fee or money policy (deposit return, a lockout fee) is answered from the manual; a
  // dispute, a waiver, a legal, a safety or a FAIR-HOUSING matter is handed to the team whatever the manual says.
  const answerFromManual = houseManual.length > 0 && mustEscalate === "money" && !isDisputeText(question);
  const escalate = answerFromManual ? null : mustEscalate;
  // A fair-housing question goes to a person, so the policy text does not travel with it: the model never holds the
  // manual and a hand-off instruction on the same turn.
  const manual = escalate === "fair_housing" ? [] : houseManual;
  const found = answers.length > 0 || houseDetails.length > 0 || manual.length > 0;
  return {
    found,
    answers,
    houseDetails,
    ...(manual.length > 0 ? { houseManual: manual } : {}),
    mustEscalate: escalate,
    guidance: escalate
      ? `This touches ${escalate!.replace("_", " ")}. Always hand it to the team: tell the person the team will follow up, then escalate.`
      : found
        ? manual.length > 0
          ? "Answer fees and policies from houseManual, quoting its amounts and terms exactly (never a number it does not state). Say it is not in PropLane only when neither the manual, the answers nor the details cover it, then offer to pass it to the manager."
          : "Answer only from these approved facts and the house details. If they do not fully cover the question, say so and escalate."
        : NOT_FOUND_GUIDANCE,
  };
}
