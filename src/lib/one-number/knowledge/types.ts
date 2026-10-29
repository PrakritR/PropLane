import { houseInfoWithoutSecrets, type HouseInfoV1 } from "@/lib/house-info";
import type { KnowledgeEntryStatus } from "../contracts";
import type { ReplyTopic } from "./topics";

export type KnowledgeAudience = "all" | "residents" | "team";
export const KNOWLEDGE_AUDIENCES: readonly KnowledgeAudience[] = ["all", "residents", "team"];

export function asAudience(value: unknown): KnowledgeAudience {
  return KNOWLEDGE_AUDIENCES.find((a) => a === value) ?? "residents";
}

export type KnowledgeSource = "manager_answer" | "draft_edit" | "manual" | "import";

export type KnowledgeEntry = {
  id: string;
  workspaceId: string;
  /** Null = the whole team (every house in the workspace). */
  propertyId: string | null;
  topic: ReplyTopic;
  question: string;
  answer: string;
  status: KnowledgeEntryStatus;
  source: KnowledgeSource;
  sourceRef: string | null;
  audience: KnowledgeAudience;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Who is asking, which decides audience and whether house details may be quoted. */
export type KnowledgeViewer = "manager" | "resident" | "prospect" | "vendor";

export type KnowledgeScope = {
  viewer: KnowledgeViewer;
  /** The workspace whose knowledge is readable. Always re-derived server-side. */
  workspaceId: string;
  ownerUserId: string;
  /** Houses this turn may read; null = every house in the workspace. */
  allowedPropertyIds: readonly string[] | null;
  /** The house the conversation is about, when known. */
  focusPropertyId: string | null;
  audiences: readonly KnowledgeAudience[];
  /** Structured house details (Wi-Fi, trash, rules...). Never for prospects or vendors. */
  includeHouseInfo: boolean;
  /**
   * May the SECRET fields of those details travel (door and gate codes, the lockbox, the Wi-Fi
   * password, free-text access notes)? A resident past the move-in lock reads trash day and the house
   * rules straight away; the codes wait for the check-in reveal (`houseInfoWithoutSecrets`).
   */
  includeHouseSecrets: boolean;
};

export type KnowledgeScopeResult =
  | { ok: true; scope: KnowledgeScope }
  | { ok: false; reason: "needs_house" | "unresolved" | "not_available" };

/**
 * The house details a scope may quote: the brief's own, less every secret field when the scope has not
 * opened the codes (`includeHouseSecrets`). Every reader of a brief goes through here, so a new one
 * cannot quote a code the asker is not yet meant to have.
 */
export function houseInfoForScope(
  scope: Pick<KnowledgeScope, "includeHouseSecrets">,
  brief: { houseInfo: HouseInfoV1 },
): HouseInfoV1 {
  return scope.includeHouseSecrets ? brief.houseInfo : houseInfoWithoutSecrets(brief.houseInfo);
}
