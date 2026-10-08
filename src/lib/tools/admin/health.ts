/**
 * Admin agent: platform health and open feedback. Read-only.
 *
 * `health_summary` reuses `loadAdminHealth` (the admin Health page). Its rows
 * already carry only a status, an error code and a time, with phone numbers
 * masked; nothing beyond that leaves the server here either.
 */
import { z } from "zod";
import { loadAdminHealth } from "@/lib/admin/admin-health.server";
import { normalizeBugFeedbackStatus } from "@/lib/portal-bug-feedback-utils";
import { defineTool } from "../registry";
import type { AdminAgentContext } from "./context";

const ROWS_PER_GROUP = 8;
const FEEDBACK_LISTED = 15;

export const healthSummaryTool = defineTool({
  name: "health_summary",
  description:
    "What is broken right now, by group: failed text messages, failed webhooks, open Stripe disputes and stuck applications (last 7 days). Each group has a total and its newest rows. Pass sinceHours to keep only rows from the last N hours (for example 24 for 'today').",
  inputSchema: z.object({
    sinceHours: z.number().int().min(1).max(168).optional().describe("Only rows newer than this many hours."),
  }),
  async handler(ctx: AdminAgentContext, input) {
    const now = new Date();
    const health = await loadAdminHealth(ctx.db, now);
    const cutoff = input.sinceHours ? now.getTime() - input.sinceHours * 3_600_000 : null;
    return {
      groups: health.groups.map((group) => {
        const rows = group.rows.filter((row) => {
          if (cutoff === null) return true;
          const at = Date.parse(row.at ?? "");
          return Number.isFinite(at) && at >= cutoff;
        });
        return {
          id: group.id,
          label: group.label,
          total: rows.length,
          rows: rows.slice(0, ROWS_PER_GROUP).map((row) => ({
            title: row.title,
            fact: row.fact,
            at: row.at,
            accountId: row.accountId,
          })),
        };
      }),
    };
  },
});

type FeedbackRow = {
  id: string;
  report_type: string | null;
  created_at: string | null;
  title: string | null;
  status: string | null;
};

export const openFeedbackTool = defineTool({
  name: "open_feedback",
  description:
    "Open bug reports and feedback from users (status Open or In progress), newest first, with the total still unresolved.",
  inputSchema: z.object({}),
  async handler(ctx: AdminAgentContext) {
    // Same read the account record's support card uses: one tiny projection of row_data.
    const { data, error } = await ctx.db
      .from("portal_bug_feedback_records")
      .select("id, report_type, created_at, title:row_data->>title, status:row_data->>status")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error("Could not read feedback.");
    const unresolved = ((data ?? []) as unknown as FeedbackRow[]).filter(
      (row) => normalizeBugFeedbackStatus(row.status) !== "completed",
    );
    return {
      unresolved: unresolved.length,
      feedback: unresolved.slice(0, FEEDBACK_LISTED).map((row) => ({
        id: row.id,
        type: row.report_type === "feedback" ? "feedback" : "bug",
        title: row.title ?? "",
        status: normalizeBugFeedbackStatus(row.status),
        createdAt: row.created_at,
      })),
    };
  },
});
