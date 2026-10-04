import { NextResponse } from "next/server";
import {
  loadLinkedFormRequest,
  markLinkedFormNotNeeded,
  resolveLinkedFormViewerRole,
  rotateLinkedFormToken,
  toLinkedFormRequestViews,
  type LinkedFormRequestRow,
  type ViewerRole,
} from "@/lib/application-linked-form-requests.server";
import { resolveEmailLinkBaseUrl, resolveAppOrigin } from "@/lib/app-url";
import { isLegitimateEmail } from "@/lib/email-address";
import { createLinkedFormFeeCheckout, verifyLinkedFormFeePayment } from "@/lib/linked-form-fee.server";
import { managerOutboundFromHeader } from "@/lib/manager-outbound-identity.server";
import { rateLimit } from "@/lib/rate-limit";
import { resolveCosignerTemplateForApplication } from "@/lib/rental-application/cosigner-template.server";
import { openApplicantRow } from "@/lib/security/applicant-identity";
import { postResendEmail } from "@/lib/resend-delivery.server";
import { getStripe } from "@/lib/stripe";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/** Every caller without access gets exactly this, the same as for a request that does not exist. */
const NOT_FOUND = { error: "Not found." } as const;

async function authorize(req: Request, id: string) {
  void req;
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized." }, { status: 401 }) } as const;
  const db = createSupabaseServiceRoleClient();
  const request = await loadLinkedFormRequest(db, id);
  if (!request) return { error: NextResponse.json(NOT_FOUND, { status: 404 }) } as const;
  // The role is re-derived from the application row and the stored request, never from the body.
  const viewer = await resolveLinkedFormViewerRole(db, request, { id: user.id, email: user.email });
  if (!viewer) return { error: NextResponse.json(NOT_FOUND, { status: 404 }) } as const;
  return { db, user, request, role: viewer.role, app: viewer.app } as const;
}

/** One request, plus (to the person who fills it in) the form's questions. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const ok = await authorize(req, id);
    if ("error" in ok) return ok.error;
    const { db, request, role, app } = ok;
    const [view] = await toLinkedFormRequestViews(db, [{ request, viewerRole: role, app }]);
    let form: Record<string, unknown> | null = null;
    if (role !== "manager" && request.form_kind === "application" && (request.status === "owed" || request.status === "shared")) {
      const template = await resolveCosignerTemplateForApplication(db, app, request.form_id, undefined, { anyPublishedVariant: true });
      if (template && !template.pinMissing) {
        const row = openApplicantRow(app.row_data, app.id, true, { soft: true });
        form = {
          signerAppId: app.id,
          signerFullName: row.name ?? "",
          templateId: template.templateId,
          templateVersion: template.templateVersion,
          config: template.config,
        };
      }
    }
    return NextResponse.json({ request: view, form }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not load this form." }, { status: 500 });
  }
}

type Action = "share" | "send_email" | "not_needed" | "fee_checkout" | "fee_verify";

function canDo(action: Action, role: ViewerRole, request: LinkedFormRequestRow): string | null {
  const open = request.status === "owed" || request.status === "shared";
  if (action === "share" || action === "send_email") {
    if (role === "helper") return "forbidden";
    if (action === "send_email" && role !== "manager") return "forbidden";
    if (request.form_kind !== "application") return "move_in";
    if (!open) return "closed";
  }
  if (action === "not_needed") {
    if (role !== "manager") return "forbidden";
    if (!open) return "closed";
  }
  if (action === "fee_checkout" || action === "fee_verify") {
    if (role === "manager") return "forbidden";
    if (request.form_kind !== "application") return "move_in";
  }
  return null;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as {
      action?: unknown;
      to?: unknown;
      sessionId?: unknown;
    };
    const action = body.action as Action;
    if (!["share", "send_email", "not_needed", "fee_checkout", "fee_verify"].includes(String(action))) {
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
    const ok = await authorize(req, id);
    if ("error" in ok) return ok.error;
    const { db, user, request, role, app } = ok;
    const refusal = canDo(action, role, request);
    if (refusal === "forbidden") return NextResponse.json(NOT_FOUND, { status: 404 });
    if (refusal === "move_in") {
      return NextResponse.json({ error: "This form is filled in from the applicant's own portal." }, { status: 409 });
    }
    if (refusal === "closed") return NextResponse.json({ error: "This form is already finished." }, { status: 409 });

    if (action === "not_needed") {
      const done = await markLinkedFormNotNeeded(db, request.id);
      return done ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "This form is already finished." }, { status: 409 });
    }

    if (action === "share") {
      if (!(await rateLimit(`linked-form-share:${user.id}`, 20, 60_000)).ok) {
        return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });
      }
      const link = await rotateLinkedFormToken(db, request);
      if (!link) return NextResponse.json({ error: "Could not create a link." }, { status: 500 });
      return NextResponse.json({ ok: true, path: link.path }, { headers: { "Cache-Control": "private, no-store" } });
    }

    if (action === "send_email") {
      if (!(await rateLimit(`linked-form-send:${user.id}`, 10, 60_000)).ok) {
        return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });
      }
      const to = typeof body.to === "string" ? body.to.trim().toLowerCase() : "";
      if (!isLegitimateEmail(to)) return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
      const apiKey = process.env.RESEND_API_KEY?.trim();
      if (!apiKey) return NextResponse.json({ error: "Email delivery is not configured." }, { status: 503 });
      const link = await rotateLinkedFormToken(db, request);
      if (!link) return NextResponse.json({ error: "Could not create a link." }, { status: 500 });
      const [view] = await toLinkedFormRequestViews(db, [{ request, viewerRole: role, app }]);
      const row = openApplicantRow(app.row_data, app.id, true, { soft: true });
      const applicant = row.name?.trim() || "An applicant";
      const url = `${resolveEmailLinkBaseUrl().replace(/\/$/, "")}${link.path}`;
      const from = await managerOutboundFromHeader(db, request.manager_user_id, {
        propertyId: String(app.assigned_property_id ?? app.property_id ?? "") || null,
      });
      const subject = `${applicant} asked you to fill out ${view?.formLabel ?? "a form"}`;
      const text = [
        `${applicant} asked you to fill out ${view?.formLabel ?? "a form"} for their rental application.`,
        "",
        "Open the link, sign in or create a resident account, and fill it in:",
        url,
        "",
        "The link works for one form and expires in 30 days.",
      ].join("\n");
      const res = await postResendEmail({
        apiKey,
        actorUserId: request.manager_user_id,
        payload: { from, to: [to], subject, text },
        effectSummary: "Linked form link email captured for the test workspace.",
        metadata: { applicationId: app.id, linkedFormRequestId: request.id },
      });
      if (!res.ok) return NextResponse.json({ error: "The email could not be sent." }, { status: 502 });
      return NextResponse.json({ ok: true });
    }

    // Fee actions: the person submitting is the one who pays.
    if (!user.email) return NextResponse.json({ error: "Your account has no email address." }, { status: 400 });
    const stripe = getStripe();
    if (action === "fee_checkout") {
      if (!(await rateLimit(`linked-form-fee:${user.id}`, 10, 60_000)).ok) {
        return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });
      }
      const result = await createLinkedFormFeeCheckout(db, stripe, {
        request,
        payer: { id: user.id, email: user.email },
        origin: resolveAppOrigin(req).replace(/\/$/, ""),
      });
      if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
      return NextResponse.json({ ok: true, url: result.url });
    }
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const verified = await verifyLinkedFormFeePayment(db, stripe, { request, payerUserId: user.id, sessionId });
    if (!verified.ok) return NextResponse.json({ error: verified.error }, { status: verified.status });
    return NextResponse.json({ ok: true, paid: verified.paid });
  } catch {
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
