import { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { resolveAgentContext } from "@/lib/tools/context";
import { resolveResidentAgentContext } from "@/lib/tools/resident-context";
import { InspectionError } from "@/lib/inspections/model";
import {
  addInspectionPhoto, changeInspectionStatus, createInspection, inspectionDetail,
  listInspectionResidencies, listInspections, removeInspectionPhoto, saveInspection,
  type InspectionActor,
} from "@/lib/inspections/server";
import { inspectionPdf } from "@/lib/inspections/pdf";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ path?: string[] }> };
const privateHeaders = { "Cache-Control": "private, no-store" };
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: privateHeaders });

async function actorFor(req: NextRequest): Promise<InspectionActor> {
  const portal = req.nextUrl.searchParams.get("portal");
  if (portal === "manager") {
    const context = await resolveAgentContext();
    if (context) return { role: "manager", context };
  } else if (portal === "resident") {
    const context = await resolveResidentAgentContext();
    if (context) return { role: "resident", context };
  } else throw new InspectionError("Choose a valid portal.");
  throw new InspectionError("Sign in to your portal to access inspections.", 401);
}

async function body(req: NextRequest) {
  const text = await req.text();
  if (text.length > 800_000) throw new InspectionError("The report is too large.", 413);
  try { return JSON.parse(text) as unknown; }
  catch { throw new InspectionError("Provide a valid request."); }
}

async function handle(req: NextRequest, context: RouteContext) {
  try {
    if (req.method !== "GET") {
      const origin = req.headers.get("origin");
      if (!origin || new URL(origin).host !== req.headers.get("host")) throw new InspectionError("Open the inspection in your portal and try again.", 403);
      if (Number(req.headers.get("content-length") ?? 0) > 7 * 1024 * 1024) throw new InspectionError("The upload is too large.", 413);
    }
    const actor = await actorFor(req);
    const path = (await context.params).path ?? [];
    const id = path[0] ? z.string().uuid().parse(path[0]) : null;
    if (path.length > 2) throw new InspectionError("Not found.", 404);
    if (req.method === "GET") {
      if (!id) {
        const [reports, residencies] = await Promise.all([listInspections(actor, req.nextUrl.searchParams.get("applicationId") ?? undefined), listInspectionResidencies(actor)]);
        return json({ reports, residencies });
      }
      if (path[1] === "pdf") {
        const bytes = await inspectionPdf(actor, id);
        return new NextResponse(Buffer.from(bytes), { headers: { ...privateHeaders,
          "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="inspection-${id}.pdf"` } });
      }
      if (!path[1]) return json(await inspectionDetail(actor, id));
    }
    if (req.method === "POST") {
      if (!id) {
        const created = await createInspection(actor, await body(req));
        return json(await inspectionDetail(actor, created.id), 201);
      }
      if (path[1] === "status") {
        await changeInspectionStatus(actor, id, await body(req));
        return json(await inspectionDetail(actor, id));
      }
      if (path[1] === "photos") {
        const form = await req.formData();
        const file = form.get("file");
        if (!(file instanceof File)) throw new InspectionError("Choose a photo.");
        await addInspectionPhoto(actor, id, z.string().min(1).max(100).parse(form.get("itemId")),
          z.coerce.number().int().positive().parse(form.get("revision")), file);
        return json(await inspectionDetail(actor, id));
      }
    }
    if (req.method === "PATCH" && id && !path[1]) {
      await saveInspection(actor, id, await body(req));
      return json(await inspectionDetail(actor, id));
    }
    if (req.method === "DELETE" && id && path[1] === "photos") {
      const input = z.object({ photoId: z.string().uuid(), revision: z.number().int().positive() }).strict().parse(await body(req));
      await removeInspectionPhoto(actor, id, input.photoId, input.revision);
      return json(await inspectionDetail(actor, id));
    }
    throw new InspectionError("Not found.", 404);
  } catch (error) {
    if (error instanceof ZodError) return json({ error: error.issues[0]?.message ?? "Invalid inspection input." }, 400);
    if (error instanceof InspectionError) return json({ error: error.message }, error.status);
    console.error("[inspections] Request failed", error instanceof Error ? error.name : "unknown");
    return json({ error: "Could not finish the inspection request. Please try again." }, 500);
  }
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
