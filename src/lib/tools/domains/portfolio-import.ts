/**
 * Portfolio import agent tools — manager portal registry only
 * (docs/agents/portfolio-import.md). A manager attaches a rent roll (csv /
 * xlsx / pdf) from the dashboard, the Properties tab, or as an Ask PropLane
 * attachment; the upload always produces the SAME `PortfolioImportDraft` the
 * review wizard reads. These four tools let the assistant read that draft,
 * commit it into real records, and invite the imported residents — every
 * count and dollar amount copied from `summarizePortfolioImportDraft`, never
 * computed by the model, and every import scoped to `ctx.landlordId`.
 */
import { z } from "zod";
import { defineTool, defineWriteTool } from "../registry";
import type { AgentContext } from "../context";
import { writeAuditLog, auditDayBucket } from "../audit";
import { draftHasBlockingIssues } from "@/lib/portfolio-import/build-draft";
import { loadPortfolioImport, listPortfolioImports, summaryFor } from "@/lib/portfolio-import/store.server";
import { commitPortfolioImport, PortfolioImportBlockedError } from "@/lib/portfolio-import/commit.server";
import { invitePortfolioImportResidents, portfolioImportMessagingStatus } from "@/lib/portfolio-import/invite.server";
import type {
  PortfolioImportDraft,
  PortfolioImportInviteChannel,
  PortfolioImportInviteResult,
  PortfolioImportIssue,
  PortfolioImportProperty,
  PortfolioImportResident,
  PortfolioImportUnit,
} from "@/lib/portfolio-import/types";

// ---------------------------------------------------------------------------
// Shared helpers (mirrors the exclusion cascade in commit.server.ts /
// build-draft.ts, which does not export it — kept small and local here).
// ---------------------------------------------------------------------------

function unitExcluded(unit: PortfolioImportUnit, properties: Map<string, PortfolioImportProperty>): boolean {
  if (unit.excluded) return true;
  return !!properties.get(unit.propertyKey)?.excluded;
}

function residentExcluded(
  resident: PortfolioImportResident,
  units: Map<string, PortfolioImportUnit>,
  properties: Map<string, PortfolioImportProperty>,
): boolean {
  if (resident.excluded) return true;
  const unit = units.get(resident.unitKey);
  if (unit && unitExcluded(unit, properties)) return true;
  return !!properties.get(resident.propertyKey)?.excluded;
}

function activeResidents(draft: PortfolioImportDraft): PortfolioImportResident[] {
  const properties = new Map(draft.properties.map((p) => [p.key, p]));
  const units = new Map(draft.units.map((u) => [u.key, u]));
  return draft.residents.filter((r) => !residentExcluded(r, units, properties));
}

async function loadOwnedImportOrThrow(ctx: AgentContext, importId: string) {
  const row = await loadPortfolioImport(ctx.db, ctx.landlordId, importId);
  if (!row) {
    throw new Error("No import with that id belongs to this landlord. Use list_portfolio_imports to get valid ids.");
  }
  return row;
}

function moneyLabel(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// list_portfolio_imports (read)
// ---------------------------------------------------------------------------

export const listPortfolioImportsTool = defineTool({
  name: "list_portfolio_imports",
  description:
    "List the manager's recent portfolio import drafts. An import draft is created automatically the moment the manager attaches a rent-roll spreadsheet (csv/xlsx) or PDF — from the Properties tab, the dashboard import icon, or as an Ask PropLane attachment — before anything is created. Every count here comes straight from the stored draft. Use this to find the importId for get_portfolio_import, commit_portfolio_import, or invite_imported_residents.",
  kind: "read",
  inputSchema: z.object({}).strict(),
  handler: async (ctx) => {
    const rows = await listPortfolioImports(ctx.db, ctx.landlordId);
    const imports = rows.map((row) => summaryFor(row)).filter((s): s is NonNullable<typeof s> => s != null);
    return { count: imports.length, imports };
  },
});

// ---------------------------------------------------------------------------
// get_portfolio_import (read)
// ---------------------------------------------------------------------------

export const getPortfolioImportTool = defineTool({
  name: "get_portfolio_import",
  description:
    "Get the full review detail for one portfolio import draft: its summary counts, unresolved issues (blocking ones first), the properties/units it will create, the residents it will create with which invite channels they can reach, and the manager's own texting status. Pass the importId from list_portfolio_imports, or from a rent-roll attachment noted earlier in this conversation.",
  kind: "read",
  inputSchema: z
    .object({
      importId: z.string().min(1).describe("The import id, from list_portfolio_imports."),
    })
    .strict(),
  handler: async (ctx, input) => {
    const row = await loadOwnedImportOrThrow(ctx, input.importId);
    const summary = summaryFor(row);
    if (!row.draft || !summary) {
      throw new Error("This import has no draft yet.");
    }
    const draft = row.draft.draft;
    const properties = new Map(draft.properties.map((p) => [p.key, p]));
    const units = new Map(draft.units.map((u) => [u.key, u]));

    const issues: PortfolioImportIssue[] = draft.issues
      .filter((i) => !i.resolved)
      .sort((a, b) => {
        const rank = (s: PortfolioImportIssue["severity"]) => (s === "block" ? 0 : s === "review" ? 1 : 2);
        return rank(a.severity) - rank(b.severity);
      });

    const propertiesOut = draft.properties
      .filter((p) => !p.excluded)
      .map((p) => ({
        name: p.name,
        address: p.address,
        unitCount: p.unitKeys.filter((k) => {
          const u = units.get(k);
          return !!u && !unitExcluded(u, properties);
        }).length,
      }));

    const residentsOut = activeResidents(draft).map((r) => {
      const property = properties.get(r.propertyKey);
      const unit = units.get(r.unitKey);
      const home = [property?.name, unit?.label].filter((v) => v && v.trim()).join(" · ");
      return {
        name: r.name,
        email: r.email,
        phone: r.phone,
        home: home || null,
        inviteChannels: r.inviteChannels,
      };
    });

    const messaging = await portfolioImportMessagingStatus(ctx.db, ctx.landlordId);

    return { summary, issues, properties: propertiesOut, residents: residentsOut, messaging };
  },
});

// ---------------------------------------------------------------------------
// commit_portfolio_import (write)
// ---------------------------------------------------------------------------

export const commitPortfolioImportTool = defineWriteTool({
  name: "commit_portfolio_import",
  description:
    "Create the properties (unlisted), units, residents, opening balances, and follow-up tasks planned by a reviewed portfolio import draft. Nothing is emailed or texted by this call — use invite_imported_residents afterward for that, as a separate confirmation. Refuses when the draft still has unresolved blocking issues; check get_portfolio_import first and have the manager fix them on the review screen.",
  inputSchema: z
    .object({
      importId: z.string().min(1).describe("The import id, from list_portfolio_imports or get_portfolio_import."),
    })
    .strict(),
  preview: async (ctx, input) => {
    const row = await loadOwnedImportOrThrow(ctx, input.importId);
    if (row.status === "completed") {
      throw new Error(
        "This import was already committed — there is nothing left to create. Ask to invite the residents instead, or use get_portfolio_import for details.",
      );
    }
    if (row.status === "discarded") {
      throw new Error("This import was discarded and can no longer be committed.");
    }
    if (!row.draft) {
      throw new Error("This import has no draft to commit yet.");
    }
    const draft = row.draft.draft;

    if (draftHasBlockingIssues(draft)) {
      const blocking = draft.issues.filter((i) => i.severity === "block" && !i.resolved);
      const named = blocking.slice(0, 3).map((i) => i.message);
      throw new Error(
        `${blocking.length} issue${blocking.length === 1 ? "" : "s"} must be fixed on the review screen first: ${named.join("; ")}`,
      );
    }

    const summary = summaryFor(row);
    if (!summary) throw new Error("This import has no draft to commit yet.");

    const pdfVerifyCount = draft.issues.filter((i) => i.code === "pdf_verify" && !i.resolved).length;
    const sourceValue =
      draft.sourceKind === "pdf" && pdfVerifyCount > 0
        ? `pdf — ${pdfVerifyCount} row${pdfVerifyCount === 1 ? "" : "s"} need your verification`
        : draft.sourceKind;

    return {
      kind: "commit_portfolio_import",
      title: `Import portfolio from ${draft.fileName}`,
      summary: `Create ${summary.propertyCount} properties (unlisted), ${summary.unitCount} units, ${summary.residentCount} residents and ${summary.taskCount} tasks; ${summary.balanceCount} opening balance(s) totalling ${moneyLabel(summary.balanceTotal)}. Nothing is emailed.`,
      fields: [
        { label: "Properties", value: `${summary.propertyCount} (unlisted, private until you list them)` },
        { label: "Units / rooms", value: `${summary.unitCount}` },
        { label: "Residents", value: `${summary.residentCount}` },
        { label: "Opening balances", value: `${summary.balanceCount} totalling ${moneyLabel(summary.balanceTotal)}` },
        { label: "Tasks", value: `${summary.taskCount}` },
        { label: "Source", value: sourceValue },
      ],
      confirmLabel: "Import",
    };
  },
  handler: async (ctx, input) => {
    // commit_portfolio_import is idempotent through its own per-record receipts
    // (store.server.ts prepareReceipt/completeReceipt) — unlike most write tools,
    // a repeat is safe to just run again, so a duplicate dedupe key never
    // short-circuits here; the manager always gets a fresh, current report.
    const dedupeKey = `commit_portfolio_import:${ctx.landlordId}:${input.importId}`;
    const audit = await writeAuditLog(ctx, {
      action: "commit_portfolio_import",
      toolName: "commit_portfolio_import",
      inputSummary: { importId: input.importId },
      dedupeKey,
    });
    if (!audit.recorded && !audit.duplicate) {
      throw new Error("Could not record the action; nothing was imported.");
    }

    const result = await commitPortfolioImport({
      db: ctx.db,
      managerUserId: ctx.landlordId,
      actor: { userId: ctx.landlordId, email: ctx.email ?? null, managerName: undefined },
      importId: input.importId,
    });

    const parts: string[] = [
      `Created ${result.propertyIds.length} propert${result.propertyIds.length === 1 ? "y" : "ies"}, ${result.residentApplicationIds.length} resident${result.residentApplicationIds.length === 1 ? "" : "s"}, and ${result.taskIds.length} task${result.taskIds.length === 1 ? "" : "s"}${result.balanceChargeIds.length > 0 ? `, plus ${result.balanceChargeIds.length} opening balance${result.balanceChargeIds.length === 1 ? "" : "s"}` : ""}.`,
    ];
    if (result.failures.length > 0) {
      const named = result.failures.slice(0, 3).map((f) => f.message);
      parts.push(
        `${result.failures.length} record${result.failures.length === 1 ? "" : "s"} could not be imported: ${named.join("; ")}${result.failures.length > 3 ? "…" : ""}.`,
      );
    }
    if (result.residentApplicationIds.length > 0) {
      parts.push("Want me to invite the residents?");
    }

    return {
      reply: parts.join(" "),
      resultSummary: {
        status: result.status,
        propertyCount: result.propertyIds.length,
        residentCount: result.residentApplicationIds.length,
        taskCount: result.taskIds.length,
        balanceCount: result.balanceChargeIds.length,
        failureCount: result.failures.length,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// invite_imported_residents (write)
// ---------------------------------------------------------------------------

function defaultInviteChannels(workNumber: string | null): PortfolioImportInviteChannel {
  return workNumber ? "both" : "email";
}

function defaultInviteResidentKeys(draft: PortfolioImportDraft): string[] {
  return activeResidents(draft)
    .filter((r) => r.inviteChannels.email || r.inviteChannels.text)
    .map((r) => r.key);
}

function summarizeInviteResults(results: PortfolioImportInviteResult[], workNumber: string | null): string {
  const parts: string[] = [];

  const emailSent = results.filter((r) => r.email === "sent").length;
  const emailAlready = results.filter((r) => r.email === "already_sent").length;
  const emailSkipped = results.filter((r) => r.email === "skipped_no_email").length;
  const emailFailed = results.filter((r) => r.email === "failed").length;
  if (emailSent || emailAlready || emailSkipped || emailFailed) {
    const bits: string[] = [];
    if (emailSent) bits.push(`${emailSent} sent`);
    if (emailAlready) bits.push(`${emailAlready} already sent`);
    if (emailSkipped) bits.push(`${emailSkipped} skipped (no email)`);
    if (emailFailed) bits.push(`${emailFailed} failed`);
    parts.push(`Email: ${bits.join(", ")}`);
  }

  const textSent = results.filter((r) => r.text === "sent").length;
  const textAlready = results.filter((r) => r.text === "already_sent").length;
  const textSkippedPhone = results.filter((r) => r.text === "skipped_no_phone").length;
  const textSkippedNumber = results.filter((r) => r.text === "skipped_no_work_number").length;
  const textFailed = results.filter((r) => r.text === "failed").length;
  if (!workNumber) {
    if (textSkippedNumber > 0) parts.push("Text: skipped — no PropLane work number");
  } else if (textSent || textAlready || textSkippedPhone || textFailed) {
    const bits: string[] = [];
    if (textSent) bits.push(`${textSent} sent`);
    if (textAlready) bits.push(`${textAlready} already sent`);
    if (textSkippedPhone) bits.push(`${textSkippedPhone} skipped (no phone)`);
    if (textFailed) bits.push(`${textFailed} failed`);
    parts.push(`Text: ${bits.join(", ")}`);
  }

  return parts.length > 0 ? `${parts.join(". ")}.` : "No invites were sent — nothing was invitable.";
}

export const inviteImportedResidentsTool = defineWriteTool({
  name: "invite_imported_residents",
  description:
    "Send the resident welcome / account-setup email and/or text (the same message send_resident_welcome sends) to residents already created by commit_portfolio_import. Defaults to every invitable resident on every channel the file supports — texting needs a PropLane work number (Settings → Messaging), otherwise it's email only. Never automatic on commit; always requires this explicit call and the user's confirmation.",
  inputSchema: z
    .object({
      importId: z.string().min(1).describe("The import id, from list_portfolio_imports or get_portfolio_import."),
      residentKeys: z
        .array(z.string().min(1))
        .optional()
        .describe("Resident keys from get_portfolio_import to invite. Omit to invite every invitable resident."),
      channels: z
        .enum(["email", "text", "both"])
        .optional()
        .describe("Which channels to use. Omit to use both when a work number exists, else email only."),
    })
    .strict(),
  preview: async (ctx, input) => {
    const row = await loadOwnedImportOrThrow(ctx, input.importId);
    if (row.status !== "completed") {
      throw new Error("This import has not been committed yet — run commit_portfolio_import first.");
    }
    if (!row.draft) throw new Error("This import has no draft.");
    const draft = row.draft.draft;

    const messaging = await portfolioImportMessagingStatus(ctx.db, ctx.landlordId);
    const residentsByKey = new Map(activeResidents(draft).map((r) => [r.key, r]));

    const requestedKeys =
      input.residentKeys && input.residentKeys.length > 0 ? input.residentKeys : defaultInviteResidentKeys(draft);
    if (requestedKeys.length === 0) {
      throw new Error("No invitable residents in this import — every resident is missing both an email and a phone.");
    }
    const unknown = requestedKeys.filter((k) => !residentsByKey.has(k));
    if (unknown.length > 0) {
      throw new Error(`Unknown resident key(s): ${unknown.join(", ")}. Use get_portfolio_import to see valid resident keys.`);
    }

    const channels = input.channels ?? defaultInviteChannels(messaging.workNumber);
    const wantsEmail = channels === "email" || channels === "both";
    const wantsText = channels === "text" || channels === "both";

    const emailRecipients: string[] = [];
    const textRecipients: string[] = [];
    const skipped: string[] = [];
    for (const key of requestedKeys) {
      const r = residentsByKey.get(key)!;
      let matched = false;
      if (wantsEmail && r.inviteChannels.email) {
        emailRecipients.push(r.name || r.email || key);
        matched = true;
      }
      if (wantsText && messaging.workNumber && r.inviteChannels.text) {
        textRecipients.push(r.name || r.phone || key);
        matched = true;
      }
      if (!matched) {
        const reasons: string[] = [];
        if (wantsEmail && !r.inviteChannels.email) reasons.push("no email");
        if (wantsText && !messaging.workNumber) reasons.push("no work number");
        else if (wantsText && !r.inviteChannels.text) reasons.push("no phone");
        skipped.push(`${r.name || key}${reasons.length > 0 ? ` (${reasons.join(", ")})` : ""}`);
      }
    }

    const fields = [
      { label: "Email", value: emailRecipients.length > 0 ? emailRecipients.join(", ") : "None" },
      {
        label: "Text",
        value: !messaging.workNumber
          ? "None — no PropLane work number"
          : textRecipients.length > 0
            ? `${textRecipients.join(", ")} (from ${messaging.workNumber})`
            : "None",
      },
      { label: "Skipped", value: skipped.length > 0 ? skipped.join(", ") : "None" },
      { label: "Message", value: "Welcome + account setup link (same as Residents → Send welcome)" },
    ];

    return {
      confirmedInput: { importId: input.importId, residentKeys: requestedKeys, channels },
      kind: "invite_imported_residents",
      title: "Invite imported residents",
      summary: `Send welcome invites to ${requestedKeys.length} resident${requestedKeys.length === 1 ? "" : "s"} from ${draft.fileName}.`,
      fields,
      confirmLabel: "Send invites",
      ...(messaging.workNumber
        ? {}
        : { warnings: ["Email only — text invites need a PropLane work number (Settings → Messaging)."] }),
    };
  },
  handler: async (ctx, input) => {
    const row = await loadOwnedImportOrThrow(ctx, input.importId);
    if (!row.draft) throw new Error("This import has no draft.");
    const draft = row.draft.draft;

    const messaging = await portfolioImportMessagingStatus(ctx.db, ctx.landlordId);
    const residentKeys =
      input.residentKeys && input.residentKeys.length > 0 ? input.residentKeys : defaultInviteResidentKeys(draft);
    const channels = input.channels ?? defaultInviteChannels(messaging.workNumber);

    // invite_imported_residents is idempotent per resident+channel (the welcome
    // stamp and the SMS dedupe key own that), so — like commit — a duplicate
    // audit dedupe key here never blocks re-running; it is best-effort record
    // keeping, not the idempotency boundary.
    const dedupeKey = `invite_imported_residents:${ctx.landlordId}:${input.importId}:${auditDayBucket()}`;
    await writeAuditLog(ctx, {
      action: "invite_imported_residents",
      toolName: "invite_imported_residents",
      inputSummary: { importId: input.importId, residentCount: residentKeys.length, channels },
      dedupeKey,
    });

    const { results, workNumber } = await invitePortfolioImportResidents({
      db: ctx.db,
      managerUserId: ctx.landlordId,
      actor: { userId: ctx.landlordId, email: ctx.email ?? null, managerName: undefined },
      importId: input.importId,
      residentKeys,
      channels,
    });

    return {
      reply: summarizeInviteResults(results, workNumber),
      resultSummary: { residentCount: residentKeys.length, channels },
    };
  },
});

// Re-exported so a caller only needs one import to check the blocked-commit
// error class without reaching into commit.server.ts directly.
export { PortfolioImportBlockedError };
