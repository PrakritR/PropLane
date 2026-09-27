import { z } from "zod";
import { defineTool } from "../../registry";
import type { ResidentAgentContext } from "../../resident-context";
import { researchPropertyLocation, type PropertyResearchTopic } from "@/lib/property-location-research.server";
import { applicationPropertyIds } from "./property-research-application";

type Row = Record<string, unknown>;

function object(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function locationFromRecord(propertyData: unknown, rowData: unknown): Record<string, unknown> {
  const published = object(propertyData);
  const raw = object(rowData);
  const submission = object(published?.listingSubmission) ?? object(raw?.submission) ?? object(raw?.listingSubmission);
  const location: Record<string, unknown> = {};
  for (const key of ["address", "city", "state", "zip", "neighborhood", "mapLat", "mapLng"] as const) {
    const value = published?.[key] ?? raw?.[key] ?? submission?.[key];
    if (key === "mapLat" || key === "mapLng") {
      if (typeof value === "number" && Number.isFinite(value)) location[key] = value;
    } else if (typeof value === "string") {
      location[key] = value.slice(0, 120);
    }
  }
  return location;
}

async function findAuthorizedLiveProperty(ctx: ResidentAgentContext, requestedId: string) {
  const id = requestedId.trim();
  if (!id || !ctx.email?.trim() || !ctx.userId?.trim()) return null;

  let applications = ctx.db
    .from("manager_application_records")
    .select("row_data, property_id, assigned_property_id, manager_user_id")
    .eq("resident_email", ctx.email);
  if (ctx.activeManagerId) applications = applications.eq("manager_user_id", ctx.activeManagerId);
  const { data: applicationRows, error: applicationError } = await applications.limit(500);
  if (applicationError) throw new Error(applicationError.message);

  const authorizedApplications = ((applicationRows ?? []) as Row[]).filter((record) => {
    const row = object(record.row_data);
    const managerId = text(record.manager_user_id);
    return row && managerId && applicationPropertyIds(record).includes(id);
  });
  if (!authorizedApplications.length) return null;

  for (const application of authorizedApplications) {
    const managerId = text(application.manager_user_id);
    if (!managerId) continue;
    const { data: property, error } = await ctx.db
      .from("manager_property_records")
      .select("id, status, manager_user_id, property_data, row_data")
      .eq("id", id)
      .eq("manager_user_id", managerId)
      .eq("status", "live")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (property && property.id === id && property.manager_user_id === managerId && property.status === "live") {
      return property as Row;
    }
  }
  return null;
}

export const researchMyPropertyLocationTool = defineTool({
  name: "research_my_property_location",
  description: "Research sourced public location facts for a live property from your own application. Use only a property id from your own application. Choose schools, schools_dual_language (for immersion programs), parks, groceries, transit_service, transit_stops, or nearby_amenities. Cite returned sources; never infer school assignment, walking or commute time, suitability, or current operating status.",
  kind: "read",
  inputSchema: z.object({
    propertyId: z.string().trim().min(1).max(160),
    topic: z.enum(["schools", "schools_dual_language", "parks", "groceries", "transit_service", "transit_stops", "nearby_amenities"]),
  }).strict(),
  handler: async (ctx: ResidentAgentContext, input: { propertyId: string; topic: PropertyResearchTopic }) => {
    const property = await findAuthorizedLiveProperty(ctx, input.propertyId);
    if (!property) return { found: false, message: "No matching live property from your own application was found." };
    return {
      found: true,
      research: await researchPropertyLocation({
        scopeKey: `resident:${ctx.userId}`,
        propertyId: String(property.id),
        location: locationFromRecord(property.property_data, property.row_data),
        topic: input.topic,
      }),
    };
  },
});
