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

/** When a form goes out on its own. "manual" = only when the manager sends it. */
export type MoveInFormTrigger = "lease-signed" | "application-approved" | "manual";

/** Due date rule, relative to the residency's move-in date. */
export type MoveInFormDueRule = "day-before" | "move-in-day" | "3-days-before" | "7-days-before";

export type MoveInFormStarterKey =
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
  /** Turned off = nothing new goes out; already-sent instances are unaffected. Starters ship off. */
  enabled: boolean;
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
  managerUserId: string;
  propertyId: string;
  propertyLabel: string;
  roomLabel: string;
  residentName: string;
  residentEmail: string;
  formId: string;
  formName: string;
  source: MoveInFormSource;
  /** Immutable once sent: the questions (and PDF fingerprint) this resident was asked. */
  snapshot: { questions: MoveInFormQuestion[]; pdf: MoveInFormTemplate["pdf"] };
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
  questionCount: number;
  photoCount: number;
  signed: boolean;
};
