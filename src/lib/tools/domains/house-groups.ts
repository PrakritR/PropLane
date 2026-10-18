/**
 * House chat tool (manager): "announce: water off Tuesday 9-12" posts to the house group chats.
 * A write tool, so the manager's YES at the confirm gate is the approval. With several houses on
 * chat and none named, the tool refuses with the question to ask ("Which house: A, B, C, or all?").
 * The workspace comes from the authenticated context; the model passes only the message and, when
 * it knows them, house ids, which are re-checked against the houses this manager may touch.
 */
import { z } from "zod";
import { defineWriteTool } from "../registry";
import type { AgentContext } from "../context";
import { writeAuditLog } from "../audit";
import { ANNOUNCE_MAX_CHARS, announceOutcomeLine, announceToHouses, listChatHouses } from "@/lib/house-groups/announce.server";
import { defaultWorkspaceIdFor, resolveManagerKnowledgeScope } from "@/lib/one-number/knowledge/scope.server";

export const ANNOUNCE_TOOL = "announce_to_house_chat";

const input = z
  .object({
    message: z.string().trim().min(1).max(ANNOUNCE_MAX_CHARS).describe("The announcement, exactly as residents should read it. Plain words, no emoji."),
    propertyIds: z.array(z.string().trim().min(1).max(100)).max(30).optional().describe("House ids from list_properties. Omit when the manager said all houses."),
    allHouses: z.boolean().optional().describe("True when the manager said all houses / everyone."),
  })
  .strict();

async function chatScope(ctx: AgentContext) {
  const fallback = ctx.workspace?.id ? null : await defaultWorkspaceIdFor(ctx.db, ctx.managerSmsAccess?.workNumberOwnerId ?? ctx.landlordId);
  const scoped = resolveManagerKnowledgeScope(ctx, null, fallback);
  if (!scoped.ok) throw new Error("Could not resolve your workspace.");
  return scoped.scope;
}

async function resolveTargets(ctx: AgentContext, args: z.infer<typeof input>) {
  const scope = await chatScope(ctx);
  const houses = await listChatHouses(ctx.db, { workspaceId: scope.workspaceId, allowedPropertyIds: scope.allowedPropertyIds });
  if (houses.length === 0) throw new Error("No house has a group chat yet. Turn house chat on for a house first.");
  let chosen = houses;
  if (!args.allHouses) {
    const asked = new Set((args.propertyIds ?? []).map((id) => id.trim()));
    if (asked.size > 0) {
      chosen = houses.filter((h) => asked.has(h.propertyId));
      if (chosen.length === 0) throw new Error("None of those houses has a group chat in this workspace.");
    } else if (houses.length > 1) {
      const names = houses.map((h) => h.label);
      throw new Error(`Which house: ${names.slice(0, -1).join(", ")}, or ${names[names.length - 1]}? Or say all.`);
    }
  }
  return { scope, chosen };
}

export const announceToHouseChatTool = defineWriteTool<z.infer<typeof input>, unknown, AgentContext>({
  name: ANNOUNCE_TOOL,
  description:
    "Post an announcement to the group chat of one house, several houses, or all houses (water shutoff, cleaning day, inspection). Posts through PropLane to the residents' shared thread. If the manager runs several houses and did not say which, do not guess: ask 'Which house: A, B, or all?' and pass their answer. Not for anything about one person's money, lease or complaint.",
  inputSchema: input,
  preview: async (ctx, args) => {
    const { chosen } = await resolveTargets(ctx, args);
    return {
      kind: ANNOUNCE_TOOL,
      title: "Post to house chat",
      summary: `Post to ${chosen.map((h) => h.label).join(", ")}.`,
      confirmLabel: "Post",
      fields: [
        { label: "House chat", value: chosen.map((h) => `${h.label} (${h.members})`).join(", ") },
        { label: "Message", value: args.message },
      ],
    };
  },
  handler: async (ctx, args) => {
    const { scope, chosen } = await resolveTargets(ctx, args);
    const requestKey = `${ctx.landlordId}:${Buffer.from(args.message).toString("base64url").slice(0, 24)}:${new Date().toISOString().slice(0, 13)}`;
    const audit = await writeAuditLog(ctx, {
      action: "announce_to_house_chat",
      toolName: ANNOUNCE_TOOL,
      inputSummary: { houses: chosen.map((h) => h.propertyId), length: args.message.length },
      dedupeKey: `${ANNOUNCE_TOOL}:${requestKey}`,
    });
    // A repeat is safe: each house post is idempotent on this request key, and a post that failed left no row behind.
    if (!audit.recorded && !audit.duplicate) throw new Error("Could not record the announcement; nothing was posted.");
    const outcomes = await announceToHouses(ctx.db, {
      workspaceId: scope.workspaceId,
      propertyIds: chosen.map((h) => h.propertyId),
      text: args.message,
      requestKey,
    });
    return { reply: announceOutcomeLine(outcomes) };
  },
});

export const houseGroupTools = [announceToHouseChatTool];
