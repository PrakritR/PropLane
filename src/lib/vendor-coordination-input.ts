import { z } from "zod";
const quote = z.object({ laborCents: z.number().int().min(0).max(1_000_000_000), materialsCents: z.number().int().min(0).max(1_000_000_000), consultationFeeCents: z.number().int().min(0).max(1_000_000_000), scope: z.string().trim().min(1).max(4000), exclusions: z.string().max(4000) }).strict();
const window = z.object({ startIso: z.string().datetime({ offset: true }), endIso: z.string().datetime({ offset: true }) }).strict().refine((w) => Date.parse(w.startIso) < Date.parse(w.endIso), "Window end must follow its start.");
const base = { proposal_id: z.string().uuid(), expected_version: z.number().int().positive() };
export const coordinationRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("enroll"), work_order_id: z.string().min(1).max(200), vendor_directory_id: z.string().min(1).max(200), visit_type: z.enum(["repair", "consultation"]), manager_user_id: z.string().optional(), actor_user_id: z.string().optional() }).strict(),
  z.object({ ...base, kind: z.literal("revise_quote"), quote, duration_minutes: z.number().int().min(15).max(480) }).strict(),
  z.object({ ...base, kind: z.literal("submit_vendor_windows"), windows: z.array(window).min(1).max(20), duration_minutes: z.number().int().min(15).max(480) }).strict(),
  z.object({ ...base, kind: z.literal("submit_resident_windows"), windows: z.array(window).min(1).max(20) }).strict(),
  z.object({ ...base, kind: z.literal("select_time"), selected_start_iso: z.string().datetime({ offset: true }) }).strict(),
  z.object({ ...base, kind: z.literal("request_revision"), reason: z.string().trim().min(1).max(1000) }).strict(),
  z.object({ ...base, kind: z.literal("take_over"), reason: z.string().trim().min(1).max(1000) }).strict(),
  ...(["confirm_vendor", "confirm_resident", "approve_manager", "decline_manager", "cancel"] as const).map((kind) => z.object({ ...base, kind: z.literal(kind) }).strict()),
]);
