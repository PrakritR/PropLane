/**
 * Move-in forms — the shared contract between the server (`server.ts`, the
 * `/api/move-in-forms` route) and every UI surface (manager sidebar section,
 * property Move-in › Forms, resident record › Move-in, resident My home › Forms).
 *
 * Two halves:
 *  - DEFINITIONS (`MoveInFormTemplate`) live on the property, in
 *    `listingSubmission.moveInFormTemplates`, beside `propertyApplicationTemplates`.
 *    Same owner, same save path as Application.
 *  - INSTANCES (`MoveInFormRecord`) are rows of `public.resident_move_in_forms`, one
 *    per (residency, form) sent. Each carries an immutable snapshot of the questions the
 *    resident saw, so later edits to the template never rewrite a submitted answer.
 *
 * Plan: studio lane claude-3, plan move-in-forms-1003 (approved 2026-10-03).
 */
import type { ManagerCustomApplicationField } from "@/lib/manager-listing-submission";

/** Question model = the application's custom-question model, plus a signature type. */
export type MoveInFormQuestion = Omit<ManagerCustomApplicationField, "type"> & {
  type: ManagerCustomApplicationField["type"] | "signature";
};

export type MoveInFormSource = "built" | "upload";

/** Who receives the form: every room, only some rooms, or one per lease for the whole house. */
export type MoveInFormAudience =
  | { kind: "every-room" }
  | { kind: "rooms"; roomIds: string[] }
  | { kind: "whole-house" };

/**
 * When a form goes out on its own. "manual" = only when the manager sends it. This is the one
 * "does it send itself" setting: a form has no separate on/off switch (the Applications list has
 * none either), so every form is usable by hand and `trigger` alone decides the automatic send.
 */
export type MoveInFormTrigger =
  | "application-submitted"
  | "application-approved"
  | "lease-signed"
  | "before-move-out"
  | "manual";

/**
 * What a form is for. Forms started from the Intake, Move-in or Move-out template carry that kind;
 * everything else is "other". The kind rides on the sent copy; the manager's Move-in tabs follow the form's name.
 */
export type MoveInFormKind = "intake" | "move-in" | "move-out" | "other";

/**
 * What an unsubmitted copy of a form holds back from the resident (or the manager). Stored on the
 * template and copied into the sent copy's `snapshot.blocks`. Absent = the kind's default.
 */
export type MoveInFormBlocks = "nothing" | "move_in_details" | "lease_signing" | "approval";

export const MOVE_IN_FORM_BLOCKS: readonly MoveInFormBlocks[] = ["nothing", "move_in_details", "lease_signing", "approval"];

export const MOVE_IN_FORM_BLOCKS_LABELS: Record<MoveInFormBlocks, string> = {
  nothing: "Nothing",
  move_in_details: "Move-in details",
  lease_signing: "Lease signing",
  approval: "Approval",
};

/** Intake forms hold Move-in details until they are filled in; every other kind blocks nothing. */
export function defaultMoveInFormBlocks(kind: MoveInFormKind | null | undefined): MoveInFormBlocks {
  return kind === "intake" ? "move_in_details" : "nothing";
}

/** The blocks a template or a sent copy carries: the stored value when valid, else the kind's default. */
export function resolveMoveInFormBlocks(blocks: unknown, kind: MoveInFormKind | null | undefined): MoveInFormBlocks {
  return MOVE_IN_FORM_BLOCKS.includes(blocks as MoveInFormBlocks) ? (blocks as MoveInFormBlocks) : defaultMoveInFormBlocks(kind);
}

/**
 * Which signed lease type a form goes to when the lease is signed. Absent / "all" = every lease.
 * A specific custom lease is `linkedLeaseTemplateIds` (the lease the residency is on).
 */
export type MoveInFormLeaseType = "all" | "long-term" | "short-term";

/** Days before the lease ends that a `before-move-out` form goes out. */
export type MoveInFormMoveOutDays = 7 | 14 | 30;

/**
 * Due date rule. Anchored on the move-in date (`day-before` ... `7-days-before`), on the day the form
 * is sent (`*-after-sent`), or on the lease end date (`move-out-day`, `*-before-move-out`).
 */
export type MoveInFormDueRule =
  | "day-before"
  | "move-in-day"
  | "3-days-before"
  | "7-days-before"
  | "3-days-after-sent"
  | "7-days-after-sent"
  | "move-out-day"
  | "3-days-before-move-out"
  | "7-days-before-move-out";

export type MoveInFormStarterKey =
  | "intake-form"
  | "move-in-form"
  | "move-out-form"
  | "move-in-checklist"
  | "key-receipt"
  | "vehicle-parking"
  | "pet-agreement"
  | "emergency-contacts";

export type MoveInFormTemplate = {
  id: string;
  name: string;
  source: MoveInFormSource;
  /** Questions in display order. For `upload` forms: the extra questions asked after the PDF (a signature at minimum). */
  questions: MoveInFormQuestion[];
  /** Uploaded PDF (source === "upload"): private storage path + display metadata. Never a public URL. */
  pdf?: { storagePath: string; fileName: string; pageCount: number; sha256: string } | null;
  audience: MoveInFormAudience;
  trigger: MoveInFormTrigger;
  due: MoveInFormDueRule;
  /** Absent in stored data written before kinds existed: read as "other". */
  kind: MoveInFormKind;
  /** What an unsubmitted copy blocks. Absent = {@link defaultMoveInFormBlocks} of the kind. */
  blocks?: MoveInFormBlocks;
  /** Used when `trigger` is "before-move-out". */
  moveOutDaysBefore: MoveInFormMoveOutDays;
  /** Application templates (`propertyApplicationTemplates` ids) this form goes to. Empty = every application. */
  linkedApplicationTemplateIds: string[];
  /** Lease templates (`propertyLeaseTemplates` ids) this form goes to. Empty = every lease. */
  linkedLeaseTemplateIds: string[];
  /** Which lease type this form goes to once a lease is signed. Absent = "all". See {@link MoveInFormLeaseType}. */
  leaseType?: MoveInFormLeaseType;
  starterKey?: MoveInFormStarterKey;
  createdAt: string;
  updatedAt: string;
};

/** Per-property move-in settings (the Move-in tab's gear). Absent = these defaults. */
export type MoveInFormSettings = {
  remind: "before-and-due" | "due-only" | "never";
  notifyOnSubmit: "assistant" | "assistant-and-email" | "none";
};

export const DEFAULT_MOVE_IN_FORM_SETTINGS: MoveInFormSettings = {
  remind: "before-and-due",
  notifyOnSubmit: "assistant",
};

export type MoveInFormStatus = "sent" | "submitted" | "cancelled";

/** One answer, keyed by the snapshot question's `key`. Photos/signature hold storage paths, never bytes. */
export type MoveInFormAnswer =
  | { key: string; value: string | string[] | number | boolean | null }
  | { key: string; files: string[] }
  | { key: string; signature: { storagePath: string; signedName: string; signedAt: string } };

/** A row of `public.resident_move_in_forms`, as the API returns it. */
export type MoveInFormRecord = {
  id: string;
  applicationId: string;
  /** Manager-side only; the resident API omits it. */
  managerUserId?: string;
  propertyId: string;
  propertyLabel: string;
  roomLabel: string;
  residentName: string;
  residentEmail: string;
  formId: string;
  formName: string;
  source: MoveInFormSource;
  /**
   * The questions this resident was asked, and the PDF fingerprint behind them. The fingerprint is
   * immutable once sent; the questions are editable by their own manager (`editMoveInForm`) only while
   * the copy is still `sent`, and immutable once it is submitted.
   */
  snapshot: { questions: MoveInFormQuestion[]; pdf: MoveInFormTemplate["pdf"]; kind?: MoveInFormKind; blocks?: MoveInFormBlocks };
  status: MoveInFormStatus;
  answers: MoveInFormAnswer[];
  /** SHA-256 of the exact PDF bytes the resident signed (upload forms only). */
  signedDocumentSha256: string | null;
  sentAt: string;
  dueAt: string | null;
  submittedAt: string | null;
  remindedAt: string | null;
  /** Manager first opened the submission (drives the sidebar's unread count). */
  managerViewedAt: string | null;
};

/** List-row projection (no answers) for the sidebar, the resident record and the resident's checklist. */
export type MoveInFormSummary = Omit<MoveInFormRecord, "answers" | "snapshot"> & {
  /** Which kind of form this copy was sent from (the Waiting / Submitted filter). */
  kind: MoveInFormKind;
  /** What this copy holds back until it is submitted (the snapshot's value, else its kind's default). */
  blocks: MoveInFormBlocks;
  questionCount: number;
  photoCount: number;
  signed: boolean;
};
