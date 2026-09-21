/**
 * Portfolio import agent tool — manager PORTAL registry only, never SMS (see
 * `MANAGER_PORTAL_ONLY_TOOLS` in `../index.ts`). A manager uploads a rent
 * roll or spreadsheet at /portal/properties/import and reviews the proposal
 * there before anything is created; this lets the assistant answer "how did
 * my import go" / "what still needs an answer" from the SAME stored proposal
 * the review screen reads (`store.server.ts`), never a second computation.
 * Read-only: nothing here creates a record — that stays a page action, same
 * as `create_property` warns off approving/creating a listing until the
 * relevant flow moves server-side (AGENTS.md "AI Agent & Tool Layer").
 */
import { z } from "zod";
import { defineTool } from "../registry";
import { loadImportProposal } from "@/lib/portfolio-import/store.server";

export const portfolioImportStatusTool = defineTool({
  name: "portfolio_import_status",
  description:
    "Get the status of one portfolio (spreadsheet / rent-roll) import the manager already uploaded at /portal/properties/import: how many properties, rooms, residents, charges, and tasks it will create, and which residents still have unanswered questions (a missing lease end date, rent, or contact info) before it can be created. Pass the importId the manager mentioned or that was noted earlier in this conversation. Every number comes straight from the stored proposal, never computed here.",
  kind: "read",
  inputSchema: z
    .object({
      importId: z.string().min(1).describe("The import id from the upload/review screen."),
    })
    .strict(),
  handler: async (ctx, input) => {
    const loaded = await loadImportProposal(ctx.db, ctx.landlordId, input.importId);
    if (!loaded) {
      throw new Error("No import with that id belongs to this landlord.");
    }
    const { proposal, row } = loaded;
    const gaps = proposal.properties.flatMap((property) =>
      property.residents
        .filter((resident) => resident.status === "needs")
        .flatMap((resident) => resident.gaps.map((gap) => ({ property: property.address, resident: resident.name, field: gap.field, question: gap.question }))),
    );
    return {
      importId: proposal.importId,
      status: row.status,
      files: proposal.files,
      summary: proposal.summary,
      unresolvedGaps: gaps,
    };
  },
});
