import { z } from "zod";
import { defineTool, defineWriteTool } from "../registry";
import type { AgentContext } from "../context";
import {
  normalizePromotionTemplate,
  PROMOTION_TEMPLATE_OPTIONS,
  PROMOTION_TONE_OPTIONS,
  readFlyerEntries,
  type ManagerPromotionRow,
  type PromotionTemplate,
} from "@/lib/promotion-flyer";
import { generateFlyerCopyForManager } from "@/lib/promotion-generate-flyer.server";
import {
  appendFlyerEntryToRow,
  buildFlyerEntryFromDraft,
  updateFlyerEntryOnRow,
} from "@/lib/promotion-row-ops";
import { humanizePropertyId } from "@/lib/reports/display-context";
import { writeAuditLog, updateAuditResult, auditDayBucket } from "../audit";
import { loadAllManagerRows } from "./load-manager-rows";
import { rowAllowedInAgentWorkspace } from "@/lib/agent/manager-workspace-scope";

const TEMPLATE_IDS = PROMOTION_TEMPLATE_OPTIONS.map((t) => t.id) as [PromotionTemplate, ...PromotionTemplate[]];

function templateLabel(template: PromotionTemplate): string {
  return PROMOTION_TEMPLATE_OPTIONS.find((t) => t.id === template)?.label ?? template;
}

/** Stable short FNV-1a hash of normalized text, for dedupe-key components. */
function hashText(text: string): string {
  const s = text.trim().toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/**
 * Safe projection of a promotion row. The `inputs`/`flyerCopies` payloads carry
 * base64 photo data URLs and are deliberately never returned.
 */
function summarizePromotion(row: ManagerPromotionRow) {
  // A promotion carries flyer copy, marketing text entries, or both; the
  // Promotion page's All/Text/Image pills classify on exactly this distinction.
  const raw = row as unknown as Record<string, unknown>;
  const hasFlyer = Boolean(raw.copy) || (Array.isArray(raw.flyers) && raw.flyers.length > 0);
  const textCount = Array.isArray(raw.textCopies) ? raw.textCopies.length : raw.textCopy ? 1 : 0;
  return {
    id: row.id,
    title: row.title || null,
    propertyId: row.propertyId || null,
    propertyLabel: row.propertyLabel || null,
    status: row.status === "generated" ? "generated" : "draft",
    template: normalizePromotionTemplate(row.template),
    hasFlyer,
    textCount,
    updatedAt: row.updatedAt || null,
  };
}

/** Server-side read of one of the landlord's OWN promotion rows, by id. */
async function loadOwnedPromotion(ctx: AgentContext, promotionId: string): Promise<ManagerPromotionRow | null> {
  const { data, error } = await ctx.db
    .from("manager_promotion_records")
    .select("id, row_data")
    .eq("manager_user_id", ctx.landlordId)
    .eq("id", promotionId)
    .limit(1);
  if (error) throw new Error(error.message);
  const rec = (data ?? [])[0] as { row_data: unknown } | undefined;
  if (!rec?.row_data) return null;
  const row = rec.row_data as ManagerPromotionRow;
  // Same active-workspace check `list_promotions` gets for free through
  // `loadAllManagerRows` (`rowAllowedInAgentWorkspace`) — a manager with 2+
  // workspaces asking the assistant to act on a promotion BY ID must not
  // reach one filed under a house in a workspace they are not currently in.
  if (!rowAllowedInAgentWorkspace(ctx, row)) return null;
  return row;
}

const UNOWNED_PROMOTION_ERROR =
  "No promotion with that id belongs to this landlord. Use list_promotions to get valid promotion ids.";

/** Resolve a property id against the landlord's OWN records; returns its display label. */
async function resolveOwnedPropertyLabel(
  ctx: AgentContext,
  propertyId: string,
): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const { data, error } = await ctx.db
    .from("manager_property_records")
    .select("id, row_data, property_data")
    .eq("manager_user_id", ctx.landlordId)
    .eq("id", propertyId)
    .limit(1);
  if (error) throw new Error(error.message);
  const rec = (data ?? [])[0] as { id: string; row_data: unknown; property_data: unknown } | undefined;
  if (!rec) {
    const demoId = propertyId.trim();
    if (/^mgr-demo-/i.test(demoId)) {
      return { ok: true, label: humanizePropertyId(demoId) };
    }
    return {
      ok: false,
      error: `Property ${propertyId} is not one of this landlord's properties. Use list_properties or find_records to get a valid property id.`,
    };
  }
  const src = (rec.property_data ?? rec.row_data ?? {}) as Record<string, unknown>;
  const label = [src.title, src.buildingName, src.name, src.address].find(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  return { ok: true, label: label?.trim() ?? rec.id };
}

export const listPromotionsTool = defineTool({
  name: "list_promotions",
  description:
    "List the current landlord's marketing promotions from the Promotion page (AI flyer/social campaigns) with id, title, property, status (draft/generated), flyer template, and whether each carries a generated flyer image and/or marketing text. Use for 'what promotions do I have for this listing', 'have I made a flyer for the Ballard house', and to get promotion ids for update_promotion/delete_promotion. Flyer images and generated copy are not returned.",
  kind: "read",
  inputSchema: z
    .object({
      status: z.enum(["draft", "generated"]).optional().describe("Optional filter on promotion status."),
      propertyId: z.string().optional().describe("Optional: only promotions for this property."),
      contentType: z
        .enum(["text", "flyer"])
        .optional()
        .describe("Optional content-type filter, matching the All/Text/Image pills on the Promotion page."),
    })
    .strict(),
  handler: async (ctx, input) => {
    // Was a raw `manager_user_id`-only query: never widened for a co-manager
    // (the opposite failure — a co-manager granted promotion access got
    // NOTHING), and never narrowed to the active workspace (a manager with 2+
    // workspaces got every workspace's promotions at once). `loadAllManagerRows`
    // is the one shared loader that gets both right, same as every sibling
    // domain (charges, applications, work orders, leases).
    const promotionRows = await loadAllManagerRows(
      ctx,
      "manager_promotion_records",
      (rowData) => rowData as ManagerPromotionRow,
    );
    const promotions = promotionRows
      .filter(Boolean)
      .map(summarizePromotion)
      .filter((p) => !input.status || p.status === input.status)
      .filter((p) => !input.propertyId || p.propertyId === input.propertyId)
      .filter((p) => {
        if (input.contentType === "flyer") return p.hasFlyer;
        if (input.contentType === "text") return p.textCount > 0;
        return true;
      });
    return { count: promotions.length, promotions };
  },
});

/** Apply AI flyer copy to a promotion row and persist it. */
async function persistGeneratedFlyer(
  ctx: AgentContext,
  promotionId: string,
  current: ManagerPromotionRow,
  extraInstructions: string,
  referenceImageUrls: string[] = [],
): Promise<{ merged: ManagerPromotionRow; source: string }> {
  const inputs = current.inputs ?? {
    headline: current.title,
    sellingPoints: "",
    price: "",
    promo: "",
    cta: "",
    contact: "",
    tone: PROMOTION_TONE_OPTIONS[0]!,
    customDetails: "",
    images: [],
  };
  const propertyLabel = current.propertyLabel?.trim() || inputs.headline || current.title;
  const { copy, source } = await generateFlyerCopyForManager(
    ctx,
    inputs,
    propertyLabel,
    extraInstructions,
    referenceImageUrls,
  );

  const nowIso = new Date().toISOString();
  const existing = readFlyerEntries(current);
  let merged: ManagerPromotionRow;
  if (existing.length > 0) {
    merged = updateFlyerEntryOnRow(current, existing[0]!.id, {
      copy,
      inputs,
      title: current.title,
      theme: current.theme,
      flyerSize: current.flyerSize,
      template: normalizePromotionTemplate(current.template),
    });
  } else {
    const entry = buildFlyerEntryFromDraft({
      title: current.title,
      copy,
      inputs,
      theme: current.theme,
      flyerSize: current.flyerSize,
      template: normalizePromotionTemplate(current.template),
      now: nowIso,
    });
    merged = appendFlyerEntryToRow(current, entry);
  }
  merged = { ...merged, status: "generated", updatedAt: nowIso };

  const { error } = await ctx.db
    .from("manager_promotion_records")
    .update({ row_data: merged, updated_at: nowIso })
    .eq("id", promotionId)
    .eq("manager_user_id", ctx.landlordId);
  if (error) throw new Error(error.message);
  return { merged, source };
}

export const createPromotionTool = defineWriteTool({
  name: "create_promotion",
  description:
    "Create a marketing promotion and generate its printable flyer copy for the landlord. Optionally attach a property (propertyId from list_properties/find_records) and notes or style hints (e.g. from an uploaded reference). The flyer appears under Promotions → Image after confirm.",
  inputSchema: z
    .object({
      title: z.string().min(1).describe("Short promotion title, e.g. 'Spring move-in special'."),
      propertyId: z
        .string()
        .optional()
        .describe("Optional property id (from list_properties) the promotion advertises."),
      template: z
        .enum(TEMPLATE_IDS)
        .optional()
        .describe("Optional flyer layout template; defaults to 'showcase'."),
      notes: z
        .string()
        .optional()
        .describe("Optional property details / selling points to seed the flyer copy with."),
      referenceImageUrls: z
        .array(z.string().url())
        .max(3)
        .optional()
        .describe(
          "Optional reference flyer image URLs from the chat upload note (listing-photos) to match layout/style.",
        ),
    })
    .strict(),
  preview: async (ctx, input) => {
    let propertyLabel: string | null = null;
    if (input.propertyId?.trim()) {
      const property = await resolveOwnedPropertyLabel(ctx, input.propertyId.trim());
      if (!property.ok) throw new Error(property.error);
      propertyLabel = property.label;
    }
    const template = normalizePromotionTemplate(input.template);
    const lines = [
      { label: "Title", value: input.title.trim() },
      { label: "Property", value: propertyLabel ?? "None (custom details)" },
      { label: "Template", value: templateLabel(template) },
    ];
    if (input.notes?.trim()) lines.push({ label: "Notes", value: input.notes.trim() });
    if (input.referenceImageUrls?.length) {
      lines.push({ label: "Reference images", value: `${input.referenceImageUrls.length} attached` });
    }
    return {
      kind: "create_promotion",
      title: "Create promotion",
      summary: `Create "${input.title.trim()}"${propertyLabel ? ` for ${propertyLabel}` : ""} and generate its flyer for the Promotions page.`,
      fields: lines,
      confirmLabel: "Create & generate flyer",
    };
  },
  handler: async (ctx, input) => {
    const title = input.title.trim();
    const propertyId = input.propertyId?.trim() || null;
    let propertyLabel = "";
    if (propertyId) {
      const property = await resolveOwnedPropertyLabel(ctx, propertyId);
      if (!property.ok) throw new Error(property.error);
      propertyLabel = property.label;
    }

    const dedupeKey = `create_promotion:${ctx.landlordId}:${hashText(`${title}|${propertyId ?? ""}`)}:${auditDayBucket()}`;
    const audit = await writeAuditLog(ctx, {
      action: "create_promotion",
      toolName: "create_promotion",
      inputSummary: { propertyId, template: normalizePromotionTemplate(input.template) },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) {
        return { reply: "A promotion with this title and property was already created today — nothing new was added." };
      }
      throw new Error("Could not record the action; no promotion was created.");
    }

    const nowIso = new Date().toISOString();
    const row: ManagerPromotionRow = {
      id: `promo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      managerUserId: ctx.landlordId,
      propertyId,
      propertyLabel,
      title,
      theme: "cobalt",
      flyerSize: "letter",
      template: normalizePromotionTemplate(input.template),
      status: "draft",
      inputs: {
        headline: title,
        sellingPoints: "",
        price: "",
        promo: "",
        cta: "",
        contact: "",
        tone: PROMOTION_TONE_OPTIONS[0]!,
        customDetails: input.notes?.trim() ?? "",
        images: [],
      },
      copy: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const { error } = await ctx.db.from("manager_promotion_records").upsert(
      { id: row.id, manager_user_id: ctx.landlordId, row_data: row, updated_at: nowIso },
      { onConflict: "id" },
    );
    if (error) {
      await updateAuditResult(ctx, dedupeKey, { created: false }, { clearDedupeKey: true });
      throw new Error(error.message);
    }
    await updateAuditResult(ctx, dedupeKey, { created: true, promotionId: row.id });
    const notes = input.notes?.trim() ?? "";
    const referenceImageUrls = input.referenceImageUrls ?? [];
    try {
      const { merged, source } = await persistGeneratedFlyer(ctx, row.id, row, notes, referenceImageUrls);
      await updateAuditResult(ctx, dedupeKey, { created: true, promotionId: row.id, flyerGenerated: true, source });
      return {
        reply: `Created the promotion "${merged.title}"${propertyLabel ? ` for ${propertyLabel}` : ""} and generated its flyer${source === "fallback" ? " (offline copy)" : ""}. Open Promotions → Image to preview or download.`,
        resultSummary: { promotionId: row.id },
      };
    } catch (genErr) {
      return {
        reply: `Created the draft promotion "${title}"${propertyLabel ? ` for ${propertyLabel}` : ""}, but flyer generation failed: ${genErr instanceof Error ? genErr.message : "unknown error"}. Try generate_promotion_flyer from the assistant.`,
        resultSummary: { promotionId: row.id },
      };
    }
  },
});

export const generatePromotionFlyerTool = defineWriteTool({
  name: "generate_promotion_flyer",
  description:
    "Generate printable flyer copy for an existing promotion (promotionId from list_promotions or create_promotion) and mark it generated so it appears under Promotions → Image. Use when the manager uploads a reference image/PDF in chat and wants a similar flyer, or after create_promotion. Pass extraInstructions to capture style notes from the conversation.",
  inputSchema: z
    .object({
      promotionId: z.string().min(1).describe("Promotion id to generate a flyer for."),
      extraInstructions: z
        .string()
        .optional()
        .describe("Optional style or layout notes from the manager (e.g. match an uploaded reference)."),
      referenceImageUrls: z
        .array(z.string().url())
        .max(3)
        .optional()
        .describe("Optional reference flyer URLs from the chat upload note."),
    })
    .strict(),
  preview: async (ctx, input) => {
    const current = await loadOwnedPromotion(ctx, input.promotionId.trim());
    if (!current) throw new Error(UNOWNED_PROMOTION_ERROR);
    const lines = [
      { label: "Promotion", value: current.title || current.id },
      { label: "Property", value: current.propertyLabel || "Custom" },
      { label: "Template", value: templateLabel(normalizePromotionTemplate(current.template)) },
    ];
    if (input.extraInstructions?.trim()) {
      lines.push({ label: "Style notes", value: input.extraInstructions.trim() });
    }
    if (input.referenceImageUrls?.length) {
      lines.push({ label: "Reference images", value: `${input.referenceImageUrls.length} attached` });
    }
    return {
      kind: "generate_promotion_flyer",
      title: "Generate flyer",
      summary: `Generate AI flyer copy for "${current.title || current.id}" and save it to the Promotions page.`,
      fields: lines,
      confirmLabel: "Generate flyer",
    };
  },
  handler: async (ctx, input) => {
    const promotionId = input.promotionId.trim();
    const current = await loadOwnedPromotion(ctx, promotionId);
    if (!current) throw new Error(UNOWNED_PROMOTION_ERROR);

    const dedupeKey = `generate_promotion_flyer:${ctx.landlordId}:${promotionId}:${hashText(input.extraInstructions ?? "")}:${auditDayBucket()}`;
    const audit = await writeAuditLog(ctx, {
      action: "generate_promotion_flyer",
      toolName: "generate_promotion_flyer",
      inputSummary: { promotionId },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) {
        return { reply: "This flyer was already generated today with the same notes — open Promotions to view it." };
      }
      throw new Error("Could not record the action; the flyer was not generated.");
    }

    const { merged, source } = await persistGeneratedFlyer(
      ctx,
      promotionId,
      current,
      input.extraInstructions?.trim() ?? "",
      input.referenceImageUrls ?? [],
    );
    await updateAuditResult(ctx, dedupeKey, { generated: true, promotionId, source });
    return {
      reply: `Generated the flyer for "${merged.title}"${source === "fallback" ? " (offline copy)" : ""}. Open Promotions → Image to preview, download, or print.`,
      resultSummary: { promotionId },
    };
  },
});

export const updatePromotionTool = defineWriteTool({
  name: "update_promotion",
  description:
    "Rename one of the landlord's promotions and/or change its status (draft/generated). Pass the promotionId from list_promotions. Flyer content itself is edited on the Promotions page, not here.",
  inputSchema: z
    .object({
      promotionId: z.string().min(1).describe("Id of the promotion to update, from list_promotions."),
      title: z.string().min(1).optional().describe("New promotion title."),
      status: z.enum(["draft", "generated"]).optional().describe("New promotion status."),
    })
    .strict(),
  preview: async (ctx, input) => {
    if (!input.title?.trim() && !input.status) {
      throw new Error("Provide at least one change: a new title or a new status.");
    }
    const current = await loadOwnedPromotion(ctx, input.promotionId.trim());
    if (!current) throw new Error(UNOWNED_PROMOTION_ERROR);
    const lines = [{ label: "Promotion", value: current.title || current.id }];
    if (input.title?.trim()) lines.push({ label: "New title", value: input.title.trim() });
    if (input.status) {
      lines.push({ label: "Status", value: `${current.status === "generated" ? "generated" : "draft"} → ${input.status}` });
    }
    return {
      kind: "update_promotion",
      title: "Update promotion",
      summary: `Update the promotion "${current.title || current.id}".`,
      fields: lines,
      confirmLabel: "Update promotion",
    };
  },
  handler: async (ctx, input) => {
    const promotionId = input.promotionId.trim();
    const current = await loadOwnedPromotion(ctx, promotionId);
    if (!current) throw new Error(UNOWNED_PROMOTION_ERROR);

    const dedupeKey = `update_promotion:${ctx.landlordId}:${promotionId}:${hashText(`${input.title ?? ""}|${input.status ?? ""}`)}:${auditDayBucket()}`;
    const audit = await writeAuditLog(ctx, {
      action: "update_promotion",
      toolName: "update_promotion",
      inputSummary: { promotionId, status: input.status ?? null, titleChanged: Boolean(input.title?.trim()) },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) {
        return { reply: "This exact promotion update was already applied today — nothing changed." };
      }
      throw new Error("Could not record the action; the promotion was not updated.");
    }

    // Mirror-table write: merge onto the CURRENT row_data, never rebuild it.
    const nowIso = new Date().toISOString();
    const merged: ManagerPromotionRow = {
      ...current,
      title: input.title?.trim() || current.title,
      status: input.status ?? current.status,
      updatedAt: nowIso,
    };
    const { error } = await ctx.db
      .from("manager_promotion_records")
      .update({ row_data: merged, updated_at: nowIso })
      .eq("id", promotionId)
      .eq("manager_user_id", ctx.landlordId);
    if (error) {
      await updateAuditResult(ctx, dedupeKey, { updated: false }, { clearDedupeKey: true });
      throw new Error(error.message);
    }
    await updateAuditResult(ctx, dedupeKey, { updated: true, promotionId });
    return { reply: `Updated the promotion "${merged.title}"${input.status ? ` (status: ${merged.status})` : ""}.`, resultSummary: { promotionId } };
  },
});

export const deletePromotionTool = defineWriteTool({
  name: "delete_promotion",
  description:
    "Permanently delete one of the landlord's promotions, including its generated flyer and text copies. Pass the promotionId from list_promotions.",
  destructive: true,
  inputSchema: z
    .object({
      promotionId: z.string().min(1).describe("Id of the promotion to delete, from list_promotions."),
    })
    .strict(),
  preview: async (ctx, input) => {
    const current = await loadOwnedPromotion(ctx, input.promotionId.trim());
    if (!current) throw new Error(UNOWNED_PROMOTION_ERROR);
    return {
      kind: "delete_promotion",
      title: "Delete promotion",
      summary: `Delete the promotion "${current.title || current.id}"${current.propertyLabel ? ` (${current.propertyLabel})` : ""}.`,
      fields: [
          { label: "Promotion", value: current.title || current.id },
          { label: "Status", value: current.status === "generated" ? "generated" : "draft" },
        ],
      confirmLabel: "Delete promotion",
      warnings: ["This permanently deletes the promotion and any generated flyer and text copies. It cannot be undone."],
    };
  },
  handler: async (ctx, input) => {
    const promotionId = input.promotionId.trim();
    const current = await loadOwnedPromotion(ctx, promotionId);
    if (!current) throw new Error(UNOWNED_PROMOTION_ERROR);

    // One-shot transition: retries return already-done forever.
    const dedupeKey = `delete_promotion:${ctx.landlordId}:${promotionId}`;
    const audit = await writeAuditLog(ctx, {
      action: "delete_promotion",
      toolName: "delete_promotion",
      inputSummary: { promotionId },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: "That promotion was already deleted." };
      throw new Error("Could not record the action; the promotion was not deleted.");
    }

    const { error } = await ctx.db
      .from("manager_promotion_records")
      .delete()
      .eq("id", promotionId)
      .eq("manager_user_id", ctx.landlordId);
    if (error) {
      await updateAuditResult(ctx, dedupeKey, { deleted: false }, { clearDedupeKey: true });
      throw new Error(error.message);
    }
    await updateAuditResult(ctx, dedupeKey, { deleted: true });
    return { reply: `Deleted the promotion "${current.title || promotionId}".`, resultSummary: { promotionId } };
  },
});
