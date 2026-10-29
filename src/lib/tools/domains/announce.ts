import { createHash } from "node:crypto";
import { z } from "zod";
import { defineWriteTool } from "../registry";
import type { AgentContext } from "../context";
import { writeAuditLog } from "../audit";
import { announceToHouses, announcementProblem, listAnnounceHouses } from "@/lib/automations/announce.server";
import { loadHouseDirectory, loadLeaseSubjects } from "@/lib/automations/sources.server";

/**
 * "announce: water off Tuesday 9-12" from the manager (portal chat or SMS). One write tool on the
 * existing confirm gate: the manager's YES is the send. The house list comes from the actor's own
 * workspace, never the model; with several houses and none named, the preview refuses with the
 * question to ask ("Which house: A, B, or all?").
 */

const schema = z
  .object({
    text: z.string().min(1).max(300).describe("The announcement, in plain words, exactly as the residents should read it. No names, amounts or codes."),
    houseIds: z.array(z.string().min(1)).max(40).optional().describe("House ids from the list in an earlier error. Omit with allHouses."),
    allHouses: z.boolean().optional().describe("True when the landlord said all houses."),
  })
  .strict();

function scopeOf(ctx: AgentContext): { workspaceId: string; allowed: readonly string[] } {
  const workspace = ctx.workspace;
  if (!workspace?.id) throw new Error("Open the workspace you want to announce in first.");
  return { workspaceId: workspace.id, allowed: workspace.propertyIds };
}

/** Pure: the announcement id is stable within an hour, so a retried confirm sends once. */
export function announcementIdFor(input: { ownerUserId: string; workspaceId: string; houseIds: readonly string[]; text: string; now: Date }): string {
  const bucket = input.now.toISOString().slice(0, 13);
  return createHash("sha256")
    .update([input.ownerUserId, input.workspaceId, [...input.houseIds].sort().join(","), input.text.trim(), bucket].join("|"))
    .digest("hex")
    .slice(0, 32);
}

async function resolveHouses(ctx: AgentContext, input: z.infer<typeof schema>) {
  const { workspaceId, allowed } = scopeOf(ctx);
  const reachable = await listAnnounceHouses(ctx.db, { ownerUserId: ctx.landlordId, workspaceId, allowedPropertyIds: allowed });
  if (reachable.length === 0) throw new Error("There are no houses to announce to.");
  let chosen = reachable;
  if (!input.allHouses) {
    if (input.houseIds?.length) {
      const wanted = new Set(input.houseIds);
      chosen = reachable.filter((h) => wanted.has(h.id));
      if (chosen.length === 0) throw new Error(`None of those houses are yours. Ask: Which house: ${reachable.map((h) => h.label).join(", ")}, or all?`);
    } else if (reachable.length > 1) {
      throw new Error(`Ask the landlord: Which house: ${reachable.map((h) => h.label).join(", ")}, or all? Then call again with houseIds ${JSON.stringify(reachable.map((h) => ({ id: h.id, label: h.label })))} or allHouses.`);
    }
  }
  return { workspaceId, allowed, chosen };
}

export const announceToHouseTool = defineWriteTool({
  name: "announce_to_house",
  description:
    "Announce something to the residents of one house, several, or all houses ('announce: water off Tuesday 9-12'): it posts in each house's group chat, or texts each resident one on one when the house has no group. Residents' names, amounts and door or Wi-Fi codes can never go in an announcement. With several houses and none named, ask 'Which house: ..., or all?' first.",
  inputSchema: schema,
  allowedIdentityInputs: [],
  preview: async (ctx, input) => {
    const { workspaceId, chosen } = await resolveHouses(ctx, input);
    const houses = await loadHouseDirectory(ctx.db, chosen.map((h) => h.id));
    const leases = await loadLeaseSubjects(ctx.db, { onlyOwner: ctx.landlordId, houses });
    for (const house of chosen) {
      const subject = houses.get(house.id);
      if (!subject || subject.workspaceId !== workspaceId) continue;
      const problem = announcementProblem(input.text, {
        residentFirstNames: leases.filter((l) => l.propertyId === house.id).map((l) => l.firstName),
        houseInfo: subject.houseInfo,
        roomSecrets: subject.roomSecrets,
      });
      if (problem) throw new Error(`${problem} (${house.label})`);
    }
    return {
      kind: "announce_to_house",
      title: "Announce to residents",
      summary: `Announce to ${chosen.length === 1 ? chosen[0]!.label : `${chosen.length} houses`}: "${input.text.trim()}"`,
      confirmLabel: "Send announcement",
      fields: [
        { label: "Houses", value: chosen.map((h) => h.label).join(", ") },
        { label: "Text", value: input.text.trim() },
      ],
    };
  },
  handler: async (ctx, input) => {
    const { workspaceId, allowed, chosen } = await resolveHouses(ctx, input);
    const announcementId = announcementIdFor({
      ownerUserId: ctx.landlordId,
      workspaceId,
      houseIds: chosen.map((h) => h.id),
      text: input.text,
      now: new Date(),
    });
    const audit = await writeAuditLog(ctx, {
      action: "announce_to_house",
      toolName: "announce_to_house",
      inputSummary: { houses: chosen.length, announcementId },
      dedupeKey: `announce_to_house:${ctx.landlordId}:${announcementId}`,
    });
    if (!audit.recorded && audit.duplicate) return { reply: "That announcement already went out." };
    if (!audit.recorded) throw new Error("Could not record the announcement; nothing was sent.");
    const result = await announceToHouses(ctx.db, {
      ownerUserId: ctx.landlordId,
      workspaceId,
      allowedPropertyIds: allowed,
      propertyIds: chosen.map((h) => h.id),
      text: input.text,
      announcementId,
    });
    if (!result.ok) throw new Error(result.message);
    const sent = result.houses.filter((h) => h.outcome === "sent").length;
    const held = result.houses.filter((h) => h.outcome === "held").length;
    const off = result.houses.some((h) => h.outcome === "off");
    if (off && sent + held === 0) return { reply: "Announcements are switched off in Settings, so nothing was sent." };
    if (held > 0 && sent === 0) return { reply: "Announcements are set to draft. It is waiting for your approval in Settings, Automations." };
    return { reply: `Announced to ${sent} ${sent === 1 ? "house" : "houses"}${held ? `, ${held} waiting for approval` : ""}.` };
  },
});

export const managerAnnounceTools = [announceToHouseTool];
