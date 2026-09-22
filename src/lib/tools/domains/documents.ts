/**
 * Manager document-library tools.
 *
 * The `manager-documents` Storage bucket is PRIVATE: bytes are reachable only
 * through a server-minted signed URL after an ownership check, so this tool
 * returns METADATA ONLY and never a URL or file content. The assistant tells the
 * landlord what exists and where it lives; opening it stays a portal action.
 * Every query is scoped by `manager_user_id = ctx.landlordId`, AND — for an
 * account with more than one workspace — by the active workspace: a document
 * filed against a property outside it is invisible, and a document filed
 * against no property at all (a lease template, a portfolio-wide policy) is
 * visible only while the viewer's own DEFAULT workspace is active, matching
 * the same account-level-row rule the inbox already follows
 * (`untaggedOwnedVisible`, `src/lib/communication/conversation-visibility.server.ts`).
 */
import { z } from "zod";
import { defineTool } from "../registry";
import { DOCUMENT_CATEGORIES } from "@/lib/documents/manager-documents";
import { propertyInAgentWorkspace } from "@/lib/agent/manager-workspace-scope";

const MAX_ROWS = 500;

export const listDocumentsTool = defineTool({
  name: "list_documents",
  description:
    "List documents in the current landlord's Document Library (the Documents -> Library tab): display name, category (lease/insurance/tax/notice/invoice/inspection/photo/other), what the document is filed against (property, lease, resident, vendor, or work order), who it is shared with, expiry date, and signature status. Use for 'do I have a copy of the insurance certificate', 'which documents expire this year', 'what have I shared with this resident'. File contents and download links are never returned — the landlord opens documents from the portal.",
  kind: "read",
  inputSchema: z
    .object({
      category: z.enum(DOCUMENT_CATEGORIES).optional().describe("Optional category filter."),
      propertyId: z.string().optional().describe("Optional: only documents filed against this property."),
      search: z
        .string()
        .optional()
        .describe("Optional case-insensitive substring match on the document's display name."),
      expiringOnly: z
        .boolean()
        .optional()
        .describe("When true, return only documents that have an expiry date set."),
    })
    .strict(),
  handler: async (ctx, input) => {
    // Never widen: an explicit propertyId outside the active workspace is
    // refused up front rather than silently answered against another house.
    if (input.propertyId && !propertyInAgentWorkspace(ctx.workspace, input.propertyId)) {
      return { count: 0, documents: [] };
    }
    let query = ctx.db
      .from("manager_documents")
      .select(
        "id, display_name, category, property_id, unit_label, lease_id, resident_email, vendor_id, work_order_id, visibility, expires_at, signature_status, size_bytes, created_at, deleted_at",
      )
      .eq("manager_user_id", ctx.landlordId)
      .order("created_at", { ascending: false })
      .limit(MAX_ROWS);
    if (input.category) query = query.eq("category", input.category);
    if (input.propertyId) {
      query = query.eq("property_id", input.propertyId);
    } else if (ctx.workspace?.narrowing) {
      const ids = ctx.workspace.propertyIds;
      if (ids.length === 0 && !ctx.workspace.isDefault) {
        return { count: 0, documents: [] };
      }
      query =
        ids.length === 0
          ? query.is("property_id", null)
          : ctx.workspace.isDefault
            ? query.or(`property_id.in.(${ids.join(",")}),property_id.is.null`)
            : query.in("property_id", [...ids]);
    }
    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const search = input.search?.trim().toLowerCase();
    const documents = ((data ?? []) as Record<string, unknown>[])
      // Soft-deleted rows are invisible in the Library, so they must be
      // invisible to the assistant too.
      .filter((d) => !d.deleted_at)
      .filter((d) => !input.expiringOnly || Boolean(d.expires_at))
      .filter((d) => !search || String(d.display_name ?? "").toLowerCase().includes(search))
      .map((d) => ({
        id: String(d.id ?? ""),
        name: String(d.display_name ?? "") || null,
        category: String(d.category ?? "") || null,
        propertyId: (d.property_id as string | null) ?? null,
        unit: (d.unit_label as string | null) ?? null,
        leaseId: (d.lease_id as string | null) ?? null,
        residentEmail: (d.resident_email as string | null) ?? null,
        vendorId: (d.vendor_id as string | null) ?? null,
        workOrderId: (d.work_order_id as string | null) ?? null,
        sharedWith: String(d.visibility ?? "manager"),
        expiresAt: (d.expires_at as string | null) ?? null,
        signatureStatus: (d.signature_status as string | null) ?? null,
        sizeBytes: Number(d.size_bytes ?? 0),
        uploadedAt: (d.created_at as string | null) ?? null,
      }));
    return { count: documents.length, documents };
  },
});
