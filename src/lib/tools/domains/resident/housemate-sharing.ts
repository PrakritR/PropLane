import { z } from "zod";
import { defineTool, defineWriteTool } from "../../registry";
import type { ResidentAgentContext } from "../../resident-context";
import { housemateSharingSchema, HOUSEMATE_SHARING_LABELS } from "@/lib/resident-housemate-sharing";
import { loadResidentMoveInForEmail } from "@/lib/resident-move-in-info";
import { readHousemateSharing, saveHousemateSharing } from "@/lib/resident-housemate-sharing.server";

export const getHousemateSharingTool = defineTool({
  name: "get_housemate_sharing", description: "Read which personal details the signed-in resident has chosen to share with roommates and housemates. Unset preferences are private.", inputSchema: z.object({}).strict(),
  handler: async (ctx: ResidentAgentContext) => ({ preferences: await readHousemateSharing(ctx) }),
});
export const updateHousemateSharingTool = defineWriteTool({
  name: "update_housemate_sharing", description: "Update only the signed-in resident's choices for sharing their name, room, email and phone with housemates. Requires explicit confirmation. Read existing preferences first and preserve choices the resident did not ask to change.", inputSchema: housemateSharingSchema,
  preview: async (_ctx: ResidentAgentContext, preferences) => ({
    kind: "update_housemate_sharing", title: "Update housemate sharing", confirmLabel: "Save sharing choices",
    fields: (Object.keys(HOUSEMATE_SHARING_LABELS) as Array<keyof typeof preferences>).map(key => ({ label: HOUSEMATE_SHARING_LABELS[key], value: preferences[key] ? "Shared with housemates" : "Private" })),
    warnings: ["This changes what housemates can see. Your property manager can still access information needed to manage your tenancy."],
  }),
  handler: async (ctx: ResidentAgentContext, preferences) => ({ reply: "Your housemate sharing choices were saved.", resultSummary: await saveHousemateSharing(ctx, preferences) }),
});

export const getHousematesTool = defineTool({
  name: "get_housemates", description: "Read roommates and housemates for the resident's own approved home. Only details each person explicitly chose to share are returned. Private details must never be inferred.", inputSchema: z.object({}).strict(),
  handler: async (ctx: ResidentAgentContext) => {
    if (ctx.phase !== "approved" || (ctx.activeManagerId && !ctx.managerIds.includes(ctx.activeManagerId))) return { housemates: [] };
    const home = await loadResidentMoveInForEmail(ctx.email, { db: ctx.db, managerUserId: ctx.activeManagerId });
    return { housemates: home?.housemates ?? [] };
  },
});
