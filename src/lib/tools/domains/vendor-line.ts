/**
 * The vendor flow on the PropLane line: its ENTIRE capability surface is one read. The result is the same public
 * allowlist view the Find work board shows (`listOpenJobsNear` -> `publicServiceProjection`): general area only, never
 * a street, unit, resident or internal id. `landlordId` and the vendor identity come from the context, never from input.
 */
import { z } from "zod";
import { defineTool } from "../registry";
import type { VendorLineContext } from "../vendor-line-context";
import { listOpenJobsNear, type OpenJobsNear } from "@/lib/open-jobs-near.server";
import { openGigLinesFor, type OpenGigLine } from "@/lib/jobs/gig-offers.server";
import { VENDOR_TRADE_OPTIONS } from "@/lib/work-order-taxonomy";
import type { DirectoryProfileRow } from "@/lib/work-order-marketplace-match.server";

export const LIST_OPEN_JOBS_NEAR_TOOL = "list_open_jobs_near";

const inputSchema = z
  .object({
    trade: z.enum(VENDOR_TRADE_OPTIONS).optional(),
    area: z.string().trim().max(120).optional(),
  })
  .strict();
export type ListOpenJobsNearInput = z.infer<typeof inputSchema>;

const PROFILE_COLUMNS =
  "user_id, trades, service_area_zips, service_radius_miles, license_number, insurance_expires_at, insurance_doc_path, directory_listed, onboarding_completed_at";

export async function runListOpenJobsNear(
  ctx: VendorLineContext,
  input: ListOpenJobsNearInput,
  options: { includeRefs?: boolean; limit?: number } = {},
): Promise<OpenJobsNear> {
  // A signed-in vendor's saved trades and service area fill in what the text leaves out; read pinned to their own id.
  let profile: DirectoryProfileRow | null = null;
  if (ctx.vendorUserId) {
    const { data } = await ctx.db.from("vendor_business_profiles").select(PROFILE_COLUMNS).eq("user_id", ctx.vendorUserId).maybeSingle();
    profile = (data as DirectoryProfileRow | null) ?? null;
  }
  return listOpenJobsNear(ctx.db, {
    tradeLabel: input.trade ?? null,
    areaText: input.area ?? null,
    vendor: ctx.vendorUserId ? { userId: ctx.vendorUserId, profile } : null,
    ...(options.includeRefs ? { includeRefs: true } : {}),
    ...(options.limit ? { limit: options.limit } : {}),
  });
}

export const listOpenJobsNearTool = defineTool<ListOpenJobsNearInput, OpenJobsNear, VendorLineContext>({
  name: LIST_OPEN_JOBS_NEAR_TOOL,
  description:
    "Open jobs a vendor can do, from the PropLane Find work board: published, unassigned services only, filtered by the Seattle neighborhood, landmark or zip the vendor names and by trade when given. Each job is a trade, a general area (never a street address), when and a budget when the manager published one. Call it whenever a vendor asks what work is available.",
  inputSchema,
  handler: async (ctx, input) => runListOpenJobsNear(ctx, input),
});

/* ------------------------------------------------------------------------------------------ */
/* PropLane Jobs: the priced jobs among them, with the code a vendor answers with.            */
/* ------------------------------------------------------------------------------------------ */

export const LIST_OPEN_GIGS_NEAR_TOOL = "list_open_gigs_near";

export type OpenGigsNear = {
  gigs: OpenGigLine[];
  total: number;
  /** `trade|area|when` of the board jobs these gigs are, so a list does not show the same job twice. */
  duplicateKeys: string[];
};

export const listOpenGigsNearTool = defineTool<ListOpenJobsNearInput, OpenGigsNear, VendorLineContext>({
  name: LIST_OPEN_GIGS_NEAR_TOOL,
  description:
    "Priced PropLane jobs open near a vendor right now (tour showings, cleanings, odd jobs a landlord posted with a price), from the same area and trade filter as list_open_jobs_near. Each has a four-character code, the kind of job, a general area (never an address), the time and what it pays. The vendor takes one by replying YES and the code. Call it when a vendor asks for work.",
  inputSchema,
  handler: async (ctx, input) => {
    const listed = await runListOpenJobsNear(ctx, input, { includeRefs: true, limit: 25 });
    const { lines, serviceIds } = await openGigLinesFor(ctx.db, listed.jobs);
    const duplicateKeys = listed.jobs.filter((j) => j.serviceId && serviceIds.has(j.serviceId)).map((j) => `${j.trade}|${j.area}|${j.when}`);
    return { gigs: lines.slice(0, 4), total: lines.length, duplicateKeys };
  },
});
