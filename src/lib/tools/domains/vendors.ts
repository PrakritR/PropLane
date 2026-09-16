import { z } from "zod";
import { defineTool, defineWriteTool } from "../registry";
import type { AgentContext } from "../context";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";
import { resolveShareableAppOrigin } from "@/lib/app-url";
import { sendVendorInvite } from "@/lib/vendor-invite.server";
import { loadAllManagerRows } from "./load-manager-rows";
import { writeAuditLog, updateAuditResult } from "../audit";

// Domain matched as dot-separated labels — same shape as the invite route's validator.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/**
 * Server-side read of the landlord's own vendors, scoped by manager_user_id.
 * Only the landlord's own vendor records are returned. The separate
 * `vendor_tax_profiles` table (W-9 / TIN data) is NEVER read here — tax
 * identifiers must not be exposed to the model.
 */
async function loadManagerVendors(ctx: AgentContext): Promise<ManagerVendorRow[]> {
  return loadAllManagerRows(
    ctx,
    "manager_vendor_records",
    (rowData) => rowData as ManagerVendorRow,
  );
}

function summarizeVendor(v: ManagerVendorRow) {
  return {
    id: v.id,
    name: v.name || null,
    trade: v.trade || null,
    phone: v.phone || null,
    email: v.email || null,
    notes: v.notes || null,
    active: v.active !== false,
    propertyIds: Array.isArray(v.propertyIds) ? v.propertyIds : [],
  };
}

export const listVendorsTool = defineTool({
  name: "list_vendors",
  description:
    "List the current landlord's vendors (contractors/service providers) with name, trade, contact info, active status, and the properties they cover. Use to answer questions like 'who are my plumbers' or 'list my active vendors', and to collect vendor ids for update_vendor or invite_vendor. Does not include tax/W-9 information.",
  kind: "read",
  inputSchema: z
    .object({
      activeOnly: z
        .boolean()
        .optional()
        .describe("When true, return only vendors marked active."),
      trade: z
        .string()
        .optional()
        .describe("Optional case-insensitive filter on the vendor's trade, e.g. 'plumbing'."),
    })
    .strict(),
  handler: async (ctx, input) => {
    const rows = await loadManagerVendors(ctx);
    const wantTrade = input.trade?.trim().toLowerCase();
    const filtered = rows.filter((v) => {
      if (input.activeOnly && v.active === false) return false;
      if (wantTrade && String(v.trade ?? "").toLowerCase() !== wantTrade) return false;
      return true;
    });
    return { count: filtered.length, vendors: filtered.map(summarizeVendor) };
  },
});

/** Synthetic per-manager settings row that must never be edited as a vendor. */
function isVendorSettingsRow(v: Pick<ManagerVendorRow, "id" | "name">): boolean {
  return v.name === "__vendor_category_settings__" || String(v.id ?? "").startsWith("axis:vendor-category-settings");
}

/** Tiny stable content hash (djb2) for dedupe keys built from non-id input. */
function stableHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** New directory ids follow the makeVendorId() shape the manager UI writes. */
function newVendorId(): string {
  return `vendor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

type OwnedVendorRecord = {
  id: string;
  manager_user_id: string | null;
  vendor_user_id: string | null;
  row_data: unknown;
};

/**
 * Resolve a single vendor directory record by id, scoped to the landlord. The
 * explicit manager_user_id filter is the ownership gate (the service role
 * bypasses RLS) — a foreign or unknown vendor id resolves to null, as does the
 * synthetic category-settings row.
 */
async function findOwnedVendorRecord(
  ctx: AgentContext,
  vendorId: string,
): Promise<{ record: OwnedVendorRecord; row: ManagerVendorRow } | null> {
  const { data, error } = await ctx.db
    .from("manager_vendor_records")
    .select("id, manager_user_id, vendor_user_id, row_data")
    .eq("id", vendorId.trim())
    .eq("manager_user_id", ctx.landlordId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const row = ((data as OwnedVendorRecord).row_data ?? {}) as ManagerVendorRow;
  if (!row.id || isVendorSettingsRow(row)) return null;
  return { record: data as OwnedVendorRecord, row };
}

/** Duplicate check against the landlord's own directory: same email, or same name + trade. */
function findExistingVendor(
  vendors: ManagerVendorRow[],
  name: string,
  trade: string,
  email: string,
): ManagerVendorRow | null {
  const nameKey = name.toLowerCase();
  const tradeKey = trade.toLowerCase();
  return (
    vendors.find((v) => {
      if (isVendorSettingsRow(v)) return false;
      if (email && String(v.email ?? "").trim().toLowerCase() === email) return true;
      return (
        String(v.name ?? "").trim().toLowerCase() === nameKey &&
        String(v.trade ?? "").trim().toLowerCase() === tradeKey
      );
    }) ?? null
  );
}

export const addVendorTool = defineWriteTool({
  name: "add_vendor",
  description:
    "Add a new vendor (contractor / service provider) to the landlord's vendor directory with a name, trade, and optional contact details. Use when the user wants a new plumber, electrician, cleaner, etc. on file.",
  inputSchema: z
    .object({
      name: z.string().min(1).max(120).describe("Vendor or company name."),
      trade: z.string().min(1).max(80).describe("The vendor's trade/category, e.g. 'plumbing' or 'electrical'."),
      email: z.string().max(200).optional().describe("Vendor contact email, if known."),
      phone: z.string().max(40).optional().describe("Vendor contact phone number, if known."),
      notes: z.string().max(500).optional().describe("Optional manager notes about the vendor."),
    })
    .strict(),
  preview: async (ctx, input) => {
    const name = input.name.trim();
    const trade = input.trade.trim();
    const email = input.email?.trim().toLowerCase() || "";
    if (!name || !trade) throw new Error("Provide both a vendor name and a trade.");
    if (email && !EMAIL_RE.test(email)) {
      throw new Error(`"${email}" is not a valid email address.`);
    }
    const existing = findExistingVendor(await loadManagerVendors(ctx), name, trade, email);
    if (existing) {
      throw new Error(`${existing.name} is already in the vendor directory (id ${existing.id}). Use update_vendor to change it.`);
    }
    const phone = input.phone?.trim() || "";
    const notes = input.notes?.trim() || "";
    return {
      confirmedInput: {
        name,
        trade,
        ...(email ? { email } : {}),
        ...(phone ? { phone } : {}),
        ...(notes ? { notes } : {}),
      },
      kind: "add_vendor",
      title: "Add vendor",
      summary: `Add ${name} (${trade}) to the vendor directory.`,
      fields: [
          { label: "Name", value: name },
          { label: "Trade", value: trade },
          ...(email ? [{ label: "Email", value: email }] : []),
          ...(phone ? [{ label: "Phone", value: phone }] : []),
          ...(notes ? [{ label: "Notes", value: notes }] : []),
        ],
      confirmLabel: "Add vendor",
    };
  },
  handler: async (ctx, input) => {
    const name = input.name.trim();
    const trade = input.trade.trim();
    const email = input.email?.trim().toLowerCase() || "";
    if (!name || !trade) throw new Error("Provide both a vendor name and a trade.");
    if (email && !EMAIL_RE.test(email)) throw new Error("The vendor email is not valid.");
    // Re-check against live directory data — the vendor may have been added
    // (by the UI or a concurrent action) since the preview.
    const existing = findExistingVendor(await loadManagerVendors(ctx), name, trade, email);
    if (existing) return { reply: `${existing.name} is already in your vendor directory.` };

    // Record intent first, idempotently. The dedupe key is content-derived
    // (email, else name+trade) since the row id doesn't exist yet.
    const vendorId = newVendorId();
    const dedupeKey = `add_vendor:${ctx.landlordId}:${email || stableHash(`${name.toLowerCase()}|${trade.toLowerCase()}`)}`;
    const audit = await writeAuditLog(ctx, {
      action: "add_vendor",
      toolName: "add_vendor",
      inputSummary: { vendorId },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: "This vendor was already added." };
      throw new Error("Could not record the action; the vendor was not added.");
    }

    const nowIso = new Date().toISOString();
    const row: ManagerVendorRow = {
      id: vendorId,
      managerUserId: ctx.landlordId,
      name,
      trade,
      phone: input.phone?.trim() ?? "",
      email,
      notes: input.notes?.trim() ?? "",
      active: true,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const { error } = await ctx.db.from("manager_vendor_records").insert({
      id: vendorId,
      manager_user_id: ctx.landlordId,
      row_data: row,
      updated_at: nowIso,
    });
    if (error) {
      await updateAuditResult(ctx, dedupeKey, { created: false }, { clearDedupeKey: true });
      throw new Error(error.message);
    }
    await updateAuditResult(ctx, dedupeKey, { vendorId, created: true });
    return { reply: `Added ${name} (${trade}) to your vendor directory.`, resultSummary: { vendorId } };
  },
});

/**
 * The ONLY row_data fields update_vendor may change. Tax data, payment
 * settings (achPaymentsEnabled / acceptedPaymentMethods), vendorDocuments,
 * and sharedWithManagers are deliberately outside the allowlist and
 * unreachable from the agent.
 */
type VendorPatch = { trade?: string; active?: boolean; notes?: string; phone?: string };

function buildVendorPatch(input: { trade?: string; active?: boolean; notes?: string; phone?: string }): VendorPatch {
  const patch: VendorPatch = {};
  const trade = input.trade?.trim();
  if (trade) patch.trade = trade;
  if (input.active !== undefined) patch.active = input.active;
  if (input.notes !== undefined) patch.notes = input.notes.trim();
  if (input.phone !== undefined) patch.phone = input.phone.trim();
  return patch;
}

export const updateVendorTool = defineWriteTool({
  name: "update_vendor",
  description:
    "Update a vendor's trade, active status, notes, or phone in the landlord's vendor directory. Pass the vendor id from list_vendors and only the fields to change. Use active:false to deactivate a vendor instead of deleting it.",
  inputSchema: z
    .object({
      vendorId: z.string().min(1).describe("Id of the vendor to update, from list_vendors."),
      trade: z.string().min(1).max(80).optional().describe("New trade/category for the vendor."),
      active: z.boolean().optional().describe("Set false to deactivate the vendor, true to reactivate."),
      notes: z.string().max(500).optional().describe("Replacement manager notes (empty string clears them)."),
      phone: z.string().max(40).optional().describe("Replacement contact phone (empty string clears it)."),
    })
    .strict(),
  preview: async (ctx, input) => {
    const found = await findOwnedVendorRecord(ctx, input.vendorId);
    if (!found) {
      throw new Error(`No vendor with id ${input.vendorId} belongs to this landlord. Use list_vendors to get valid vendor ids.`);
    }
    const patch = buildVendorPatch(input);
    if (Object.keys(patch).length === 0) {
      throw new Error("Nothing to update — provide at least one of trade, active, notes, or phone.");
    }
    const v = found.row;
    const lines: { label: string; value: string }[] = [];
    if (patch.trade !== undefined) lines.push({ label: "Trade", value: `${v.trade || "—"} → ${patch.trade}` });
    if (patch.active !== undefined) {
      lines.push({
        label: "Status",
        value: `${v.active !== false ? "active" : "inactive"} → ${patch.active ? "active" : "inactive"}`,
      });
    }
    if (patch.phone !== undefined) lines.push({ label: "Phone", value: `${v.phone || "—"} → ${patch.phone || "—"}` });
    if (patch.notes !== undefined) lines.push({ label: "Notes", value: `${v.notes || "—"} → ${patch.notes || "—"}` });
    return {
      confirmedInput: { vendorId: found.record.id, ...patch },
      kind: "update_vendor",
      title: "Update vendor",
      summary: `Update ${v.name || "this vendor"} (${lines.length} field${lines.length === 1 ? "" : "s"}).`,
      fields: lines,
      confirmLabel: "Update vendor",
    };
  },
  handler: async (ctx, input) => {
    const found = await findOwnedVendorRecord(ctx, input.vendorId);
    if (!found) throw new Error("No matching vendor for this landlord.");
    const patch = buildVendorPatch(input);
    if (Object.keys(patch).length === 0) throw new Error("Nothing to update.");
    const fields = Object.keys(patch);

    // Idempotent per vendor per exact patch content.
    const patchHash = stableHash(
      JSON.stringify([patch.trade ?? null, patch.active ?? null, patch.notes ?? null, patch.phone ?? null]),
    );
    const dedupeKey = `update_vendor:${ctx.landlordId}:${found.record.id}:${patchHash}`;
    const audit = await writeAuditLog(ctx, {
      action: "update_vendor",
      toolName: "update_vendor",
      inputSummary: { vendorId: found.record.id, fields },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: "This exact vendor update was already applied." };
      throw new Error("Could not record the action; the vendor was not updated.");
    }

    // Read-merge-write the CURRENT row_data: only allowlisted fields change;
    // everything else (payment contacts, documents, shared flags) is preserved.
    const nowIso = new Date().toISOString();
    const current = (found.record.row_data && typeof found.record.row_data === "object"
      ? found.record.row_data
      : {}) as Record<string, unknown>;
    const nextRowData = { ...current, ...patch, updatedAt: nowIso };
    const { error } = await ctx.db
      .from("manager_vendor_records")
      .update({ row_data: nextRowData, updated_at: nowIso })
      .eq("id", found.record.id)
      .eq("manager_user_id", ctx.landlordId);
    if (error) {
      await updateAuditResult(ctx, dedupeKey, { updated: false }, { clearDedupeKey: true });
      throw new Error(error.message);
    }
    await updateAuditResult(ctx, dedupeKey, { updated: true, fields });
    return { reply: `Updated ${found.row.name || "the vendor"} (${fields.join(", ")}).`, resultSummary: { vendorId: found.record.id, fields } };
  },
});

export const inviteVendorTool = defineWriteTool({
  name: "invite_vendor",
  description:
    "Email a vendor from the directory an invite link to create their own Axis vendor portal account. Pass the vendor id from list_vendors; the invite goes to the email already on the vendor's directory record.",
  inputSchema: z
    .object({
      vendorId: z.string().min(1).describe("Id of the vendor to invite, from list_vendors."),
    })
    .strict(),
  preview: async (ctx, input) => {
    const found = await findOwnedVendorRecord(ctx, input.vendorId);
    if (!found) {
      throw new Error(`No vendor with id ${input.vendorId} belongs to this landlord. Use list_vendors to get valid vendor ids.`);
    }
    if (found.record.vendor_user_id) {
      throw new Error(`${found.row.name || "This vendor"} already has a linked Axis account — no invite is needed.`);
    }
    const email = String(found.row.email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      throw new Error(`${found.row.name || "This vendor"} has no valid email on file — add one to the vendor record in Services → Vendors first.`);
    }
    return {
      confirmedInput: { vendorId: found.record.id },
      kind: "invite_vendor",
      title: "Invite vendor to Axis",
      summary: `Email ${found.row.name || email} a link to create their Axis vendor account.`,
      fields: [
          { label: "Vendor", value: found.row.name || "—" },
          { label: "Email", value: email },
          { label: "Effect", value: "Sends a signup link (valid 7 days); replaces any pending invite" },
        ],
      confirmLabel: "Send invite",
    };
  },
  handler: async (ctx, input) => {
    const found = await findOwnedVendorRecord(ctx, input.vendorId);
    if (!found) throw new Error("No matching vendor for this landlord.");
    if (found.record.vendor_user_id) {
      return { reply: `${found.row.name || "This vendor"} already has a linked Axis account.` };
    }
    // The invite email always comes from the directory row, never model input.
    const email = String(found.row.email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new Error("This vendor has no valid email on file.");

    // One-shot per vendor: record intent first; retries return already-done.
    const dedupeKey = `invite_vendor:${ctx.landlordId}:${found.record.id}`;
    const audit = await writeAuditLog(ctx, {
      action: "invite_vendor",
      toolName: "invite_vendor",
      inputSummary: { vendorId: found.record.id },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: `${found.row.name || "This vendor"} was already invited.` };
      throw new Error("Could not record the action; no invite was sent.");
    }

    const { data: profile } = await ctx.db
      .from("profiles")
      .select("full_name, email")
      .eq("id", ctx.landlordId)
      .maybeSingle();
    const managerName =
      String(profile?.full_name ?? "").trim() || String(profile?.email ?? "").trim() || "Your property manager";
    const result = await sendVendorInvite(ctx.db, {
      managerUserId: ctx.landlordId,
      managerName,
      vendorId: found.record.id,
      vendorEmail: email,
      vendorName: String(found.row.name ?? "").trim(),
      origin: resolveShareableAppOrigin(),
    });
    if (!result.ok) {
      // A failed send is retryable — clear the dedupe key so a retry records a
      // fresh attempt instead of short-circuiting to "already invited".
      await updateAuditResult(ctx, dedupeKey, { sent: false }, { clearDedupeKey: true });
      throw new Error(result.error);
    }
    await updateAuditResult(ctx, dedupeKey, { sent: true });
    return { reply: `Sent an Axis signup invite to ${found.row.name || "the vendor"} at ${email}.`, resultSummary: { vendorId: found.record.id, sent: true } };
  },
});
