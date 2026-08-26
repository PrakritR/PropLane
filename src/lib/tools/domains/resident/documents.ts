import { z } from "zod";
import { defineTool } from "../../registry";
import type { ResidentAgentContext } from "../../resident-context";

const PAGE_SIZE = 1000;

export const listMySharedDocumentsTool = defineTool({
  name: "list_my_shared_documents",
  description:
    "List the documents the resident's manager has shared with them (the 'Shared with you' tab in the resident Documents section): display name, category, and when it was shared. File contents are never returned — the resident opens them from the portal.",
  inputSchema: z.object({}).strict(),
  handler: async (ctx: ResidentAgentContext) => {
    // Mirrors /api/resident/shared-documents: visibility must be "resident" and
    // the row must name this resident by user id or email. Soft-deleted rows are
    // excluded exactly as the route does. Two scoped reads rather than one
    // `.or()` because a row may carry either identity column.
    const byId = new Map<string, Record<string, unknown>>();
    for (const [column, value] of [
      ["resident_user_id", ctx.userId],
      ["resident_email", ctx.email],
    ] as const) {
      let query = ctx.db
        .from("manager_documents")
        .select("id, display_name, category, created_at, deleted_at, visibility")
        .eq("visibility", "resident")
        .eq(column, value);
      if (ctx.activeManagerId) query = query.eq("manager_user_id", ctx.activeManagerId);
      const { data, error } = await query.order("id", { ascending: true }).range(0, PAGE_SIZE - 1);
      if (error) throw new Error(error.message);
      for (const row of (data ?? []) as Record<string, unknown>[]) {
        if (row.deleted_at) continue;
        byId.set(String(row.id ?? ""), row);
      }
    }
    const documents = [...byId.values()].map((d) => ({
      id: String(d.id ?? ""),
      name: String(d.display_name ?? "") || null,
      category: String(d.category ?? "") || null,
      sharedAt: String(d.created_at ?? "") || null,
    }));
    return { count: documents.length, documents };
  },
});
