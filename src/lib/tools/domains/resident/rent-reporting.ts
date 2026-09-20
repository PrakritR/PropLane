import { z } from "zod";
import { defineTool } from "../../registry";
import type { ResidentAgentContext } from "../../resident-context";
import {
  isRentReportingPartnerLive,
  RENT_REPORTING_BUREAUS_LABEL,
  RENT_REPORTING_COMING_SOON,
} from "@/lib/rent-reporting/partner";

/**
 * Read-only status check for "did my rent reporting go through". No write tool exists
 * here on purpose — turning reporting on requires typed consent (legal name + DOB), so
 * it stays a resident-portal-only action (`resident-payments-panel.tsx`), never
 * something the assistant can flip on the resident's behalf.
 */
export const rentReportingStatusTool = defineTool({
  name: "rent_reporting_status",
  description:
    "Get whether the resident has turned on reporting their rent payments to credit bureaus, and their most recent monthly submission if any. Read-only. Use for 'is my rent being reported', 'did last month's payment get reported'. When the result says available: false, rent reporting is not offered yet — tell the resident it is coming soon. There is no tool to turn this on or off — direct the resident to the 'Report my rent to credit bureaus' card on their Payments page.",
  kind: "read",
  inputSchema: z.object({}).strict(),
  handler: async (ctx: ResidentAgentContext) => {
    if (!isRentReportingPartnerLive()) {
      return { available: false, enrolled: false, message: RENT_REPORTING_COMING_SOON };
    }
    const { data, error } = await ctx.db
      .from("resident_rent_reporting")
      .select("id, status, consented_at, stopped_at")
      .eq("resident_user_id", ctx.userId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return { available: true, enrolled: false, bureaus: RENT_REPORTING_BUREAUS_LABEL };

    const { data: submission } = await ctx.db
      .from("rent_reporting_submissions")
      .select("period, status, sent_at")
      .eq("reporting_id", data.id)
      .order("period", { ascending: false })
      .limit(1)
      .maybeSingle();

    return {
      available: true,
      enrolled: data.status === "active",
      status: data.status as "active" | "paused" | "stopped",
      consentedAt: (data.consented_at as string | null) ?? null,
      stoppedAt: (data.stopped_at as string | null) ?? null,
      bureaus: RENT_REPORTING_BUREAUS_LABEL,
      lastSubmission: submission
        ? { period: submission.period as string, status: submission.status as string, sentAt: (submission.sent_at as string | null) ?? null }
        : null,
    };
  },
});
