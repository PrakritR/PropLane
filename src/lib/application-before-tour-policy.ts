/**
 * The form-level `tourOrder` facts the Forms library still stores and shows.
 *
 * There is NO application-before-tour gate (removed Nov 10 2026, captain): anyone signed in may request a
 * tour. A `tourOrder` stored on a template is a dead field; nothing reads it for a decision.
 */
import type { ApplicationTourOrder } from "@/lib/property-application-templates";

/** @deprecated A form has no tour order of its own; kept only for the Forms library's stored facts. */
export const APPLICATION_TOUR_ORDER_OPTIONS: readonly { value: ApplicationTourOrder; label: string }[] = [
  { value: "workspace", label: "Use the workspace setting" },
  { value: "before_tour", label: "Before the tour" },
  { value: "after_tour", label: "After the tour" },
];

/** Anything that is not an explicit before/after is the workspace setting. */
export function normalizeApplicationTourOrder(raw: unknown): ApplicationTourOrder {
  return raw === "before_tour" || raw === "after_tour" ? raw : "workspace";
}
