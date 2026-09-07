/**
 * Resident maintenance filing. Distinct from `create_service_request`: a
 * maintenance issue becomes a WORK ORDER (`portal_work_order_records`), an
 * add-on service becomes a `ServiceRequest` — two separate models that share
 * only a nav section (see AGENTS.md, "Add-on services vs. work orders").
 *
 * Input parity with the Services form (`resident-add-service-modal.tsx`): the
 * same title / priority / category / arrival window / entry permission + notes
 * / photos, with the same allowed values, read from the same modules the form
 * reads. Only `description` is required, so "the heater is broken" still files
 * and the SMS-path inference fills the rest.
 *
 * Photos never travel through the model. The chat route stores each attached
 * image privately and stashes it on the context by attachment index
 * (`ctx.chatPhotos`); the model names `attachmentIndexes`, the preview turns
 * them into storage paths it PINS via `confirmedInput`, and the handler — which
 * runs on the later confirm request, where the stash no longer exists — reads
 * those pinned paths back after re-checking they sit under this resident's own
 * storage prefix. There is deliberately no base64 or data-URL field.
 */
import { z } from "zod";
import { defineWriteTool } from "../../registry";
import type { ResidentAgentContext } from "../../resident-context";
import { writeAuditLog, updateAuditResult, auditDayBucket } from "../../audit";
import { contentHash } from "./load-resident-rows";
import { resolveServiceRequestRouting } from "./services";
import {
  RESIDENT_MAINTENANCE_CATEGORY_LABELS,
  WORK_ORDER_PRIORITY_OPTIONS,
} from "@/lib/work-order-taxonomy";
import { ENTRY_PERMISSION_OPTIONS, entryPermissionLabel } from "@/lib/work-order-entry";
import {
  PREFERRED_ARRIVAL_CUSTOM,
  PREFERRED_ARRIVAL_PRESETS,
  formatPreferredArrival,
} from "@/lib/preferred-arrival";
import {
  INBOX_ATTACHMENTS_BUCKET,
  contentTypeForInboxAttachmentPath,
  isInboxAttachmentPath,
} from "@/lib/inbox-attachments.server";

/** The Services form caps a report at six photos. */
const MAX_REPORT_PHOTOS = 6;
/** Matches the private chat-photo intake's own ceiling. */
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

const ENTRY_PERMISSION_VALUES = ENTRY_PERMISSION_OPTIONS.map((option) => option.value) as [
  (typeof ENTRY_PERMISSION_OPTIONS)[number]["value"],
  ...(typeof ENTRY_PERMISSION_OPTIONS)[number]["value"][],
];

export const reportMaintenanceSchema = z
  .object({
    description: z
      .string()
      .min(5)
      .max(2000)
      .describe(
        "What is wrong, in the resident's own words — this becomes the work order description the manager and vendor read.",
      ),
    title: z
      .string()
      .min(3)
      .max(120)
      .optional()
      .describe("Short summary the manager sees first, e.g. 'Kitchen faucet leaking'. Inferred when omitted."),
    priority: z
      .enum(WORK_ORDER_PRIORITY_OPTIONS)
      .optional()
      .describe("Emergency only for flooding, gas, sparking, no heat/water or a lockout. Inferred when omitted."),
    category: z
      .enum(RESIDENT_MAINTENANCE_CATEGORY_LABELS)
      .optional()
      .describe("Type of repair. Inferred from the description when omitted."),
    arrivalWindow: z
      .enum([...PREFERRED_ARRIVAL_PRESETS, PREFERRED_ARRIVAL_CUSTOM] as const)
      .optional()
      .describe("When maintenance may arrive. Use 'Custom' with arrivalCustom for anything not in the list."),
    arrivalCustom: z
      .string()
      .max(120)
      .optional()
      .describe("Free-text arrival window, only when arrivalWindow is 'Custom' (e.g. 'Tuesday after 3pm')."),
    entryPermission: z
      .enum(ENTRY_PERMISSION_VALUES)
      .optional()
      .describe(
        "Can maintenance enter if the resident is not home: allowed (yes), call_first (call me first), resident_present (no, I'll be home).",
      ),
    entryNotes: z
      .string()
      .max(300)
      .optional()
      .describe("Entry notes for the person coming — gate code, pets, parking."),
    attachmentIndexes: z
      .array(z.number().int().min(0))
      .max(MAX_REPORT_PHOTOS)
      .optional()
      .describe(
        "Which of the photos attached to THIS message to include, by position (0 = first). Only when the resident attached photos and wants them on the report.",
      ),
    photoRefs: z
      .array(z.string().min(1).max(600))
      .max(MAX_REPORT_PHOTOS)
      .optional()
      .describe("Internal: private photo source references already resolved for this report. Prefer attachmentIndexes."),
  })
  .strict();

type ReportMaintenanceInput = z.infer<typeof reportMaintenanceSchema>;

/**
 * A photo reference is usable only when it is one of THIS resident's own
 * private chat uploads: under their storage prefix, an image, and free of
 * anything that could reshape the object key. Same rule the inspection tool
 * applies to its `sourceRef`; a reference from anywhere else is refused, never
 * downloaded.
 */
export function ownedResidentChatPhotoRef(ctx: ResidentAgentContext, path: string): boolean {
  const trimmed = path.trim();
  if (!trimmed || trimmed !== path) return false;
  if (!isInboxAttachmentPath(trimmed) || /[\\?#%]/.test(trimmed)) return false;
  if (!trimmed.startsWith(`${ctx.userId}/`)) return false;
  return /\.(jpg|jpeg|png|webp|gif)$/i.test(trimmed);
}

/**
 * Turn the model's attachment indexes (and any already-pinned refs) into the
 * ordered, de-duplicated list of storage paths this report will carry. Throws
 * on an index that is not attached to this turn — the model may not invent a
 * photo — and on a ref outside the resident's own uploads.
 */
function resolvePhotoRefs(ctx: ResidentAgentContext, input: ReportMaintenanceInput): string[] {
  const stash = ctx.chatPhotos ?? [];
  const refs: string[] = [];
  for (const index of input.attachmentIndexes ?? []) {
    const hit = stash.find((photo) => photo.index === index);
    if (!hit) {
      throw new Error(
        stash.length === 0
          ? "No photos are attached to this message — attach them and ask again."
          : `Photo ${index + 1} isn't attached to this message (there ${stash.length === 1 ? "is 1 photo" : `are ${stash.length} photos`}).`,
      );
    }
    refs.push(hit.storagePath);
  }
  for (const ref of input.photoRefs ?? []) {
    if (!ownedResidentChatPhotoRef(ctx, ref)) {
      throw new Error("One of the photos isn't one of your own chat uploads, so it can't go on the report.");
    }
    refs.push(ref);
  }
  const unique = [...new Set(refs)];
  if (unique.length > MAX_REPORT_PHOTOS) {
    throw new Error(`A report carries at most ${MAX_REPORT_PHOTOS} photos.`);
  }
  return unique;
}

/**
 * Read a pinned photo back as the data URL the Services form writes on
 * `row_data.photoDataUrls`, so the resident, manager and vendor panels render
 * it exactly like a form-filed photo. Ownership is re-checked here because the
 * stored input is not proof — the confirm request is a different request.
 */
async function loadPhotoDataUrl(ctx: ResidentAgentContext, ref: string): Promise<string> {
  if (!ownedResidentChatPhotoRef(ctx, ref)) {
    throw new Error("One of the photos isn't one of your own chat uploads, so the report wasn't filed.");
  }
  const { data, error } = await ctx.db.storage.from(INBOX_ATTACHMENTS_BUCKET).download(ref);
  if (error || !data) {
    throw new Error("One of the photos could not be found — attach it again and re-file.");
  }
  if (data.size > MAX_PHOTO_BYTES) {
    throw new Error("One of the photos is larger than 5 MB, so the report wasn't filed.");
  }
  const bytes = Buffer.from(await data.arrayBuffer());
  return `data:${contentTypeForInboxAttachmentPath(ref)};base64,${bytes.toString("base64")}`;
}

function resolvedArrival(input: ReportMaintenanceInput): string | undefined {
  if (!input.arrivalWindow) return undefined;
  return formatPreferredArrival(input.arrivalWindow, input.arrivalCustom ?? "");
}

/**
 * Gated write: file a maintenance work order for the signed-in resident.
 * Reuses `createWorkOrderFromResidentSms`, the same server function the SMS
 * channel uses, so duplicate suppression, manager notification, and vendor
 * pre-dispatch all behave identically to the portal's "Report maintenance"
 * button; explicit fields override its text inference. The manager and
 * property are resolved from the resident's own residency, never from model
 * input.
 */
export const reportMaintenanceIssueTool = defineWriteTool({
  name: "report_maintenance_issue",
  description:
    "File a new maintenance work order for the signed-in resident (the portal's Services -> Report maintenance action). Use when the resident describes something broken or in need of repair — NOT for add-on services like parking or storage, which use create_service_request. Fill title, priority, category, arrival window, entry permission and entry notes only from what the resident actually said; to include photos the resident attached to this message, pass their positions in attachmentIndexes.",
  inputSchema: reportMaintenanceSchema,
  preview: async (ctx: ResidentAgentContext, input) => {
    const routing = await resolveServiceRequestRouting(ctx);
    if (!routing) {
      throw new Error("Your account isn't linked to a property manager yet, so I can't file this for you.");
    }
    const photoRefs = resolvePhotoRefs(ctx, input);
    const arrival = resolvedArrival(input);
    const title = input.title?.trim() || undefined;
    const entryNotes = input.entryNotes?.trim() || undefined;

    const fields = [
      { label: "Reported by", value: `${routing.residentName} (${ctx.email})` },
      { label: "Property", value: routing.propertyLabel },
      ...(title ? [{ label: "Title", value: title }] : []),
      { label: "What's wrong", value: input.description },
      ...(input.category ? [{ label: "Category", value: input.category }] : []),
      ...(input.priority ? [{ label: "Priority", value: input.priority }] : []),
      ...(arrival ? [{ label: "Preferred arrival", value: arrival }] : []),
      ...(input.entryPermission
        ? [{ label: "Entry if not home", value: entryPermissionLabel(input.entryPermission) }]
        : []),
      ...(entryNotes ? [{ label: "Entry notes", value: entryNotes }] : []),
      ...(photoRefs.length > 0
        ? [{ label: "Photos", value: `${photoRefs.length} attached` }]
        : []),
    ];

    // Pin what the preview resolved: the storage paths replace the per-turn
    // indexes (which mean nothing on the confirm request), and the arrival
    // window is stored already formatted so the card and the row agree.
    const { attachmentIndexes: _indexes, ...rest } = input;
    void _indexes;
    const confirmedInput: ReportMaintenanceInput = {
      ...rest,
      ...(title ? { title } : {}),
      ...(entryNotes ? { entryNotes } : {}),
      ...(photoRefs.length > 0 ? { photoRefs } : {}),
    };

    return {
      kind: "report_maintenance_issue",
      title: "File a maintenance request",
      summary: `File a maintenance request with ${routing.managerLabel}.`,
      confirmLabel: "File request",
      fields,
      warnings: [
        input.priority === "Emergency"
          ? "Filed as an Emergency — your manager is notified immediately. For a life-safety emergency call 911 first."
          : "Your manager is notified as soon as this is filed.",
      ],
      confirmedInput,
    };
  },
  handler: async (ctx: ResidentAgentContext, input) => {
    // Re-resolve the manager at confirm time; stored input is never ownership proof.
    const routing = await resolveServiceRequestRouting(ctx);
    if (!routing) {
      throw new Error("Your account isn't linked to a property manager yet, so I can't file this for you.");
    }

    // Read the pinned photos back BEFORE recording intent, so a missing photo
    // leaves no half-recorded action behind.
    const photoDataUrls: string[] = [];
    for (const ref of input.photoRefs ?? []) {
      photoDataUrls.push(await loadPhotoDataUrl(ctx, ref));
    }

    // Record intent first, idempotent per title+description per day, so a
    // double confirm cannot file the same issue twice.
    const title = input.title?.trim() || undefined;
    const issueHash = contentHash(`${(title ?? "").toLowerCase()}\n${input.description.trim().toLowerCase()}`);
    const dedupeKey = `report_maintenance_issue:${ctx.landlordId}:${issueHash}:${auditDayBucket()}`;
    const audit = await writeAuditLog(ctx, {
      action: "report_maintenance_issue",
      toolName: "report_maintenance_issue",
      inputSummary: {
        descriptionHash: issueHash,
        ...(input.priority ? { priority: input.priority } : {}),
        ...(input.category ? { category: input.category } : {}),
        ...(input.entryPermission ? { entryPermission: input.entryPermission } : {}),
        photoCount: photoDataUrls.length,
      },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) {
        return { reply: "You already filed that maintenance request today — I didn't file a duplicate." };
      }
      throw new Error("Could not record the action; no maintenance request was filed.");
    }

    // Imported lazily: the claw maintenance lib reaches the work-order dispatch
    // path, which imports the manager registry — a static import would close
    // that cycle and leave this registry half-initialised at module load.
    const { createWorkOrderFromResidentSms } = await import("@/lib/claw-maintenance-work-order.server");
    const result = await createWorkOrderFromResidentSms({
      managerUserId: routing.managerId,
      residentPhone: "",
      residentUserId: ctx.userId,
      residentEmail: ctx.email,
      text: input.description,
      senderUserId: ctx.userId,
      // The resident explicitly asked for this, so the SMS channel's
      // "does this text look like maintenance?" heuristic must not veto it.
      skipIntentCheck: true,
      details: {
        ...(title ? { title } : {}),
        ...(input.priority ? { priority: input.priority } : {}),
        ...(input.category ? { categoryLabel: input.category } : {}),
        ...(resolvedArrival(input) ? { preferredArrival: resolvedArrival(input) } : {}),
        ...(input.entryPermission ? { entryPermission: input.entryPermission } : {}),
        ...(input.entryNotes?.trim() ? { entryNotes: input.entryNotes.trim() } : {}),
        ...(photoDataUrls.length > 0 ? { photoDataUrls } : {}),
      },
    });
    if ("alreadyOpen" in result && result.alreadyOpen) {
      await updateAuditResult(ctx, dedupeKey, { alreadyOpen: true });
      return {
        reply: `You already have an open request for that (${result.title}). I didn't file a duplicate.`,
      };
    }
    if (!result.created) {
      await updateAuditResult(ctx, dedupeKey, { filed: false }, { clearDedupeKey: true });
      throw new Error("Could not file the maintenance request. Please try again from Services.");
    }
    await updateAuditResult(ctx, dedupeKey, { filed: true, photoCount: photoDataUrls.length });
    const photoNote = photoDataUrls.length > 0
      ? ` with ${photoDataUrls.length} photo${photoDataUrls.length === 1 ? "" : "s"}`
      : "";
    return { reply: `Filed "${result.title}"${photoNote} with your manager. You can track it under Services → Work orders.` };
  },
});
