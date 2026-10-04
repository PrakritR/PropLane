import { NextRequest, NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { resolveAgentContext } from "@/lib/tools/context";
import { resolveResidentAgentContext } from "@/lib/tools/resident-context";
import { moveInFormPdf } from "@/lib/move-in-forms/pdf";
import { MAX_JSON_BODY_BYTES, MAX_PDF_UPLOAD_REQUEST_BYTES, MAX_UPLOAD_REQUEST_BYTES } from "@/lib/move-in-forms/limits";
import { BodyTooLargeError, readBodyText, readFormDataLimited } from "@/lib/move-in-forms/read-body";
import {
  assertMoveInPlanForActor, cancelMoveInForm, deleteMoveInFormFile, listMoveInForms, MoveInFormError, moveInFormDetail, moveInFormFileUrl, moveInFormRecordPdf,
  moveInFormTemplatePdf, remindMoveInForm, saveMoveInFormDraft, sendMoveInForm, sendMoveInFormToCurrentResidents,
  submitMoveInForm, uploadMoveInFormFile, uploadMoveInFormTemplatePdf, type MoveInFormActor,
} from "@/lib/move-in-forms/server";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ path?: string[] }> };
const privateHeaders = { "Cache-Control": "private, no-store" };
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: privateHeaders });
const MANAGER_VERBS = new Set(["send", "send-existing", "template-pdf"]);

async function actorFor(req: NextRequest): Promise<MoveInFormActor> {
  const portal = req.nextUrl.searchParams.get("portal");
  if (portal === "manager") {
    const context = await resolveAgentContext();
    if (context) return { role: "manager", context };
  } else if (portal === "resident") {
    const context = await resolveResidentAgentContext();
    if (context) return { role: "resident", context };
  } else throw new MoveInFormError("Choose a valid portal.");
  throw new MoveInFormError("Sign in to your portal to access move-in forms.", 401);
}

function originHost(value: string | null): string | null {
  if (!value) return null;
  try { return new URL(value).host; }
  catch { return null; }
}

async function body(req: NextRequest) {
  let text: string;
  try { text = await readBodyText(req, MAX_JSON_BODY_BYTES); }
  catch (error) {
    if (error instanceof BodyTooLargeError) throw new MoveInFormError("The request is too large.", 413);
    throw new MoveInFormError("Provide a valid request.");
  }
  try { return text ? JSON.parse(text) as unknown : {}; }
  catch { throw new MoveInFormError("Provide a valid request."); }
}

/** Multipart upload, counted as it streams in: `maxBytes` is the ceiling for this route's kind of file. */
async function formData(req: NextRequest, maxBytes: number) {
  try { return await readFormDataLimited(req, maxBytes); }
  catch (error) {
    if (error instanceof BodyTooLargeError) throw new MoveInFormError("The upload is too large.", 413);
    throw new MoveInFormError("Provide a valid upload.");
  }
}

const safeName = (name: string) => name.replace(/[^\w.() -]/g, "_").slice(0, 100) || "form.pdf";
const pdfResponse = (bytes: Uint8Array, headers: Record<string, string>) =>
  new NextResponse(Buffer.from(bytes), { headers: { ...privateHeaders, "Content-Type": "application/pdf", "X-Content-Type-Options": "nosniff", ...headers } });
/** The uploaded original is read in place, so it is the one inline response; it is sandboxed and never sniffed. */
const originalPdf = (file: { bytes: Uint8Array; fileName: string }) =>
  pdfResponse(file.bytes, { "Content-Disposition": `inline; filename="${safeName(file.fileName)}"`, "Content-Security-Policy": "sandbox" });

async function handle(req: NextRequest, context: RouteContext) {
  try {
    if (req.method !== "GET") {
      const host = originHost(req.headers.get("origin"));
      if (!host || host !== req.headers.get("host")) throw new MoveInFormError("Open the form in your portal and try again.", 403);
      // Early refusal only; the readers below count the bytes themselves.
      if (Number(req.headers.get("content-length") ?? 0) > MAX_PDF_UPLOAD_REQUEST_BYTES) throw new MoveInFormError("The upload is too large.", 413);
    }
    const actor = await actorFor(req);
    await assertMoveInPlanForActor(actor);
    const path = (await context.params).path ?? [];
    if (path.length > 4) throw new MoveInFormError("Not found.", 404);
    const search = req.nextUrl.searchParams;

    if (actor.role === "manager") {
      const [first, second] = path;
      if (first === "mine") throw new MoveInFormError("Not found.", 404);
      if (req.method === "GET" && !first) {
        return json(await listMoveInForms(actor, {
          status: search.get("status") ?? undefined,
          propertyId: search.get("propertyId") ?? undefined,
          applicationId: search.get("applicationId") ?? undefined,
        }));
      }
      if (first && MANAGER_VERBS.has(first) && !second) {
        if (first === "template-pdf" && req.method === "GET") {
          return originalPdf(await moveInFormTemplatePdf(actor, z.string().min(1).max(120).parse(search.get("propertyId")), z.string().min(1).max(120).parse(search.get("formId"))));
        }
        if (first === "template-pdf" && req.method === "POST") {
          const form = await formData(req, MAX_PDF_UPLOAD_REQUEST_BYTES);
          const file = form.get("file");
          if (!(file instanceof File)) throw new MoveInFormError("Property, form, and PDF are required.");
          return json(await uploadMoveInFormTemplatePdf(actor, {
            propertyId: z.string().min(1).max(120).parse(form.get("propertyId")),
            formId: z.string().min(1).max(120).parse(form.get("formId")),
            file,
          }), 201);
        }
        if (first === "send" && req.method === "POST") return json(await sendMoveInForm(actor, await body(req)), 201);
        if (first === "send-existing" && req.method === "POST") return json(await sendMoveInFormToCurrentResidents(actor, await body(req)));
        throw new MoveInFormError("Not found.", 404);
      }
      const id = first ? z.string().uuid().parse(first) : null;
      if (id && req.method === "GET") {
        if (!second) return json(await moveInFormDetail(actor, id));
        if (second === "pdf") {
          return pdfResponse(await moveInFormPdf(actor, id), { "Content-Disposition": `attachment; filename="move-in-form-${id}.pdf"` });
        }
        if (second === "file") return fileRedirect(await moveInFormFileUrl(actor, id, filePath(search)));
        if (second === "template-pdf") return originalPdf(await moveInFormRecordPdf(actor, id));
      }
      if (id && req.method === "POST" && second === "remind") return json(await remindMoveInForm(actor, id));
      if (id && req.method === "POST" && second === "cancel") return json(await cancelMoveInForm(actor, id));
      throw new MoveInFormError("Not found.", 404);
    }

    // Resident: everything lives under /mine.
    if (path[0] !== "mine") throw new MoveInFormError("Not found.", 404);
    const id = path[1] ? z.string().uuid().parse(path[1]) : null;
    const verb = path[2];
    if (req.method === "GET") {
      if (!id) return json(await listMoveInForms(actor, {
        status: search.get("status") ?? undefined,
        applicationId: search.get("applicationId") ?? undefined,
      }));
      if (!verb) return json(await moveInFormDetail(actor, id));
      if (verb === "pdf") return pdfResponse(await moveInFormPdf(actor, id), { "Content-Disposition": `attachment; filename="move-in-form-${id}.pdf"` });
      if (verb === "file") return fileRedirect(await moveInFormFileUrl(actor, id, filePath(search)));
      if (verb === "template-pdf") return originalPdf(await moveInFormRecordPdf(actor, id));
    }
    if (id && req.method === "PATCH" && !verb) return json(await saveMoveInFormDraft(actor, id, await body(req)));
    if (id && req.method === "POST" && verb === "submit") return json(await submitMoveInForm(actor, id, await body(req)));
    if (id && req.method === "POST" && verb === "files") {
      const form = await formData(req, MAX_UPLOAD_REQUEST_BYTES);
      const file = form.get("file");
      if (!(file instanceof File)) throw new MoveInFormError("Choose a file.");
      return json(await uploadMoveInFormFile(actor, id, z.string().min(1).max(80).parse(form.get("questionKey")), file), 201);
    }
    if (id && req.method === "DELETE" && verb === "files") return json(await deleteMoveInFormFile(actor, id, filePath(search)));
    throw new MoveInFormError("Not found.", 404);
  } catch (error) {
    if (error instanceof ZodError) return json({ error: error.issues[0]?.message ?? "Invalid move-in form input." }, 400);
    if (error instanceof MoveInFormError) return json({ error: error.message }, error.status);
    console.error("[move-in-forms] Request failed", error instanceof Error ? error.name : "unknown");
    return json({ error: "Could not finish the move-in form request. Please try again." }, 500);
  }
}

const filePath = (search: URLSearchParams) => z.string().min(1).max(300).parse(search.get("path"));
const fileRedirect = (url: string) => NextResponse.redirect(url, { status: 302, headers: privateHeaders });

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
