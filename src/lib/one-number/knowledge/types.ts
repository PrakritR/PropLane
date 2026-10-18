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
};

export type KnowledgeScopeResult =
  | { ok: true; scope: KnowledgeScope }
  | { ok: false; reason: "needs_house" | "unresolved" | "not_available" };
