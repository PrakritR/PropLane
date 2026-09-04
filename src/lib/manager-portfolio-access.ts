/**
 * Demo: which listings / property ids a signed-in portal user may see for Applications, filters, etc.
 */

import type { DemoApplicantRow } from "@/data/demo-portal";
import type { MockProperty } from "@/data/types";
import { resolveManagerScopeUserId } from "@/lib/demo/demo-session";
import {
  readAllExtraListings,
  readAllPendingManagerProperties,
  readExtraListingsForUser,
  readPendingManagerPropertiesForUser,
  readScopedExtraListings,
  syncPropertyPipelineFromServer,
  buildMockPropertyFromDraft,
} from "@/lib/demo-property-pipeline";
// Import the event name from the cycle-free leaf module, NOT from
// demo-property-pipeline: this module reads it at eval time (in
// MANAGER_PORTFOLIO_REFRESH_EVENTS below), and the property-pipeline import
// cycle would otherwise hit its TDZ. See property-pipeline-events.ts.
import { PROPERTY_PIPELINE_EVENT } from "@/lib/property-pipeline-events";
import { MANAGER_APPLICATIONS_EVENT, readManagerApplicationRows } from "@/lib/manager-applications-storage";
import { readProRelationships, syncProRelationshipsFromServer } from "@/lib/pro-relationships";
import { readCachedAccountLinkInvites } from "@/lib/portal-data-store";
import {
  coManagerModuleAllowed,
  hasCoManagerPermission,
  hasCoManagerPermissionForProperty,
  permissionsForProperty,
  type CoManagerPermissionId,
  type CoManagerPermissionLevel,
  type PropertyCoManagerPermissions,
} from "@/lib/co-manager-permissions";

/** Match property ids across minor formatting differences (avoid importing calendar — cycle). */
export function samePropertyId(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = String(a ?? "").trim();
  const right = String(b ?? "").trim();
  if (!left || !right) return false;
  if (left === right) return true;
  const token = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  return token(left) === token(right);
}

export function ownedPropertyIdsForUser(userId: string): Set<string> {
  const owned = new Set<string>();
  for (const p of readExtraListingsForUser(userId)) owned.add(p.id);
  for (const r of readPendingManagerPropertiesForUser(userId)) owned.add(r.id);
  return owned;
}

function addIncomingAssignedPropertyIds(userId: string, target: Set<string>): void {
  const owned = ownedPropertyIdsForUser(userId);
  const invites = readCachedAccountLinkInvites().filter(
    (inv) => inv.status === "accepted" && inv.direction === "incoming",
  );
  // Accepted invites are authoritative when present — do not union with stale
  // relationship mirrors that may still list properties removed from the link.
  if (invites.length > 0) {
    for (const inv of invites) {
      for (const id of inv.assignedPropertyIds) {
        const pid = id.trim();
        if (pid && !owned.has(pid)) target.add(pid);
      }
    }
    return;
  }
  for (const rel of readProRelationships(userId)) {
    if (rel.linkDirection === "outgoing") continue;
    for (const id of rel.assignedPropertyIds) {
      const pid = id.trim();
      if (pid && !owned.has(pid)) target.add(pid);
    }
  }
}

/** Property ids explicitly assigned via accepted co-manager account links. */
export function collectLinkedPropertyIds(userId: string): Set<string> {
  const s = new Set<string>();
  addIncomingAssignedPropertyIds(userId, s);
  return s;
}

/**
 * Client mirror of the server's module rule (src/lib/auth/co-manager-module-scope.ts):
 * an assigned property with NO module permissions checked grants every module;
 * a non-empty permission set restricts access to the checked modules.
 */
function modulePermsAllow(
  perms: PropertyCoManagerPermissions | undefined,
  propertyId: string,
  module: CoManagerPermissionId,
): boolean {
  return coManagerModuleAllowed(perms, propertyId, module);
}

/** Linked property ids where this user may use `module` (client-side view of accepted links). */
export function collectLinkedPropertyIdsForModule(userId: string, module: CoManagerPermissionId): Set<string> {
  const owned = ownedPropertyIdsForUser(userId);
  const out = new Set<string>();
  const invites = readCachedAccountLinkInvites().filter(
    (inv) => inv.status === "accepted" && inv.direction === "incoming",
  );
  if (invites.length > 0) {
    for (const inv of invites) {
      for (const id of inv.assignedPropertyIds) {
        const pid = id.trim();
        if (!pid || owned.has(pid)) continue;
        if (modulePermsAllow(inv.propertyCoManagerPermissions, pid, module)) out.add(pid);
      }
    }
    return out;
  }
  for (const rel of readProRelationships(userId)) {
    if (rel.linkDirection === "outgoing") continue;
    for (const id of rel.assignedPropertyIds) {
      const pid = id.trim();
      if (!pid || owned.has(pid)) continue;
      if (modulePermsAllow(rel.propertyCoManagerPermissions, pid, module)) out.add(pid);
    }
  }
  return out;
}

/** Linked OWNER manager user ids where this user has `module` access on ≥1 assigned property. */
export function collectLinkedOwnerIdsForModule(userId: string, module: CoManagerPermissionId): Set<string> {
  const out = new Set<string>();
  if (!userId) return out;
  for (const inv of readCachedAccountLinkInvites()) {
    if (inv.status !== "accepted" || inv.direction !== "incoming") continue;
    const ownerId = inv.linkedUserId?.trim();
    if (!ownerId || ownerId === userId) continue;
    const qualifies = inv.assignedPropertyIds.some((id) => {
      const pid = id.trim();
      return pid && modulePermsAllow(inv.propertyCoManagerPermissions, pid, module);
    });
    if (qualifies) out.add(ownerId);
  }
  return out;
}

/** Client mirror of modulePermsAllow at a specific level (edit/delete). */
function modulePermsAllowLevel(
  perms: PropertyCoManagerPermissions | undefined,
  propertyId: string,
  module: CoManagerPermissionId,
  level: CoManagerPermissionLevel,
): boolean {
  return coManagerModuleAllowed(perms, propertyId, module, level);
}

/**
 * Whether this user may use `module` at `level` (edit/delete) on a linked property.
 * Own properties always qualify. Used to gate destructive/edit actions that the
 * read-only `collectLinkedPropertyIdsForModule` set does not distinguish.
 */
export function hasLinkedPropertyModuleLevel(
  userId: string,
  propertyId: string,
  module: CoManagerPermissionId,
  level: CoManagerPermissionLevel,
): boolean {
  const pid = propertyId.trim();
  if (!userId || !pid) return false;
  if (ownedPropertyIdsForUser(userId).has(pid)) return true;
  for (const rel of readProRelationships(userId)) {
    if (rel.linkDirection === "outgoing") continue;
    if (!rel.assignedPropertyIds.some((id) => id.trim() === pid)) continue;
    if (modulePermsAllowLevel(rel.propertyCoManagerPermissions, pid, module, level)) return true;
  }
  for (const inv of readCachedAccountLinkInvites()) {
    if (inv.status !== "accepted" || inv.direction !== "incoming") continue;
    if (!inv.assignedPropertyIds.some((id) => id.trim() === pid)) continue;
    if (modulePermsAllowLevel(inv.propertyCoManagerPermissions, pid, module, level)) return true;
  }
  return false;
}

/** The OWNER (primary manager) user id for a linked property, or null if it's the user's own / not linked. */
export function linkedPropertyOwnerId(userId: string, propertyId: string): string | null {
  const pid = propertyId.trim();
  if (!userId || !pid) return null;
  if (ownedPropertyIdsForUser(userId).has(pid)) return null;
  for (const inv of readCachedAccountLinkInvites()) {
    if (inv.status !== "accepted" || inv.direction !== "incoming") continue;
    if (!inv.assignedPropertyIds.some((id) => id.trim() === pid)) continue;
    const owner = inv.linkedUserId?.trim();
    if (owner && owner !== userId) return owner;
  }
  for (const rel of readProRelationships(userId)) {
    if (rel.linkDirection === "outgoing") continue;
    if (!rel.assignedPropertyIds.some((id) => id.trim() === pid)) continue;
    const owner = (rel as { linkedUserId?: string | null }).linkedUserId?.trim();
    if (owner && owner !== userId) return owner;
  }
  return null;
}

/** Whether a row scoped by managerUserId/propertyId is visible for a module (owner or linked co-manager). */
export function moduleRowVisibleToPortalUser(
  row: { managerUserId?: string | null; propertyId?: string | null; assignedPropertyId?: string | null },
  userId: string | null,
  module: CoManagerPermissionId,
): boolean {
  if (!userId) return false;
  // A row attributed to this manager is always theirs — even when its property
  // is missing from the local owned/linked cache (deleted/archived property, or
  // cache not hydrated yet on first paint). The server already scoped the list.
  if (row.managerUserId && row.managerUserId === userId) return true;
  const pid = row.propertyId?.trim() || row.assignedPropertyId?.trim() || "";
  if (pid) {
    if (ownedPropertyIdsForUser(userId).has(pid)) return true;
    return collectLinkedPropertyIdsForModule(userId, module).has(pid);
  }
  // Rows without a property stay visible only when unscoped.
  return !row.managerUserId;
}

/** Refresh co-manager relationships and property pipeline (includes linked owner listings). */
export async function syncManagerPortfolioFromServer(userId: string, opts?: { force?: boolean }): Promise<void> {
  if (!userId.trim()) return;
  try {
    await syncProRelationshipsFromServer(userId, { force: opts?.force === true });
    const linkedPropertyIds = collectLinkedPropertyIds(userId);
    await syncPropertyPipelineFromServer({
      force: opts?.force === true,
      userId,
      linkedPropertyIds,
    });
  } catch {
    /* offline or dev server recompiling */
  }
}

/**
 * Whether an application/resident row should appear for this portal user.
 *
 * Pass `module` to gate a co-manager's LINKED-property rows by a specific grant
 * (e.g. "residents" for the Residents tab, "applications" for Applications) so a
 * co-manager granted only, say, `payments` on a property no longer sees its
 * residents. Omitting `module` keeps the legacy module-agnostic behavior (any
 * assigned property is visible) for callers that aren't module-scoped yet.
 * Owned/pending properties are always visible regardless of `module`.
 */
export function applicationVisibleToPortalUser(
  row: DemoApplicantRow,
  userId: string | null,
  module?: CoManagerPermissionId,
): boolean {
  if (!userId) return false;
  // A row attributed to THIS manager is always theirs — even when its property
  // is missing from the local owned/linked cache (property just created and the
  // pipeline cache not hydrated yet on first paint, or an archived/unlisted own
  // listing). The server GET already scoped this list by manager_user_id, so
  // trusting the attribution here only ever un-hides the manager's OWN rows; it
  // can never surface another manager's, because a co-manager's linked rows are
  // attributed to the OWNER (managerUserId !== this userId) and fall through to
  // the property-scoped check below. Without this, a resident's freshly
  // submitted application — correctly stored and returned — vanished from the
  // manager's Applications tab whenever the property cache lost the hydration
  // race. This mirrors the same fix already in `moduleRowVisibleToPortalUser`.
  if (row.managerUserId && row.managerUserId === userId) return true;
  const pid = row.assignedPropertyId?.trim() || row.propertyId?.trim() || row.application?.propertyId?.trim() || "";
  if (pid) {
    // Foreign (co-manager linked) rows must still belong to the live portfolio,
    // so unlink/delete scope changes stick (the row is attributed to the owner,
    // never this co-manager). Otherwise residents/housing would stick after an
    // unlink.
    if (ownedPropertyIdsForUser(userId).has(pid)) return true;
    const linked = module ? collectLinkedPropertyIdsForModule(userId, module) : collectLinkedPropertyIds(userId);
    return linked.has(pid);
  }
  // An unscoped row (no attribution, no property) stays hidden.
  return false;
}

/** Minimal lease shape for portfolio visibility checks (avoids circular imports). */
export type LeaseVisibilityRow = {
  managerUserId?: string | null;
  propertyId?: string;
  application?: { propertyId?: string };
};

/** Whether a lease row should appear for this portal user (direct owner or linked property). */
export function leaseVisibleToPortalUser(row: LeaseVisibilityRow, userId: string | null): boolean {
  if (!userId) return false;
  // Same attribution-first rule as `applicationVisibleToPortalUser` /
  // `moduleRowVisibleToPortalUser`: a lease attributed to THIS manager is
  // theirs even when the property cache has not hydrated yet. This gates lease
  // WRITES via `leaseAccessibleToManager`, so a cold cache otherwise fails the
  // manager's own lease actions outright.
  if (row.managerUserId && row.managerUserId === userId) return true;
  const pid = row.propertyId?.trim() || row.application?.propertyId?.trim() || "";
  if (pid) {
    if (ownedPropertyIdsForUser(userId).has(pid)) return true;
    return collectLinkedPropertyIdsForModule(userId, "leases").has(pid);
  }
  // An unscoped row (no attribution, no property) stays hidden. Attribution is
  // already handled by the attribution-first check above, so there is nothing
  // left to fall back to here.
  return false;
}

export type ManagerPropertyFilterOption = { id: string; label: string };

/**
 * True when a label is really a raw property id / seed-run token rather than a
 * human name — e.g. `test-prop-seed-1782590281847` or a title like
 * "Seed Property seed-1782590281847" left behind by an older seed. These must
 * never reach a user-facing dropdown.
 */
function looksLikeRawPropertyId(value: string, id: string): boolean {
  const v = value.trim();
  if (!v) return true;
  if (v === id.trim()) return true;
  return /(?:^|[\s(])(?:seed|test)[-_]prop\b|\bseed-\d{6,}\b|\bseedwf[_-]|\bmgr-[a-z0-9]{4,}-[a-z0-9]{4,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-|\d{12,}/i.test(v);
}

/**
 * True when a title is the auto-generated placeholder used for listings created
 * without a building name — `${buildingName || "Property"} · ${unitLabel}`, e.g.
 * "Property · 2 rooms". Every such listing renders the SAME label, so a manager
 * with two of them cannot tell them apart in a picker. Deprioritized in favour
 * of the address, which is always distinct.
 */
function looksLikeGenericPropertyTitle(value: string): boolean {
  return /^property\s*(?:·|-|—)/i.test(value.trim());
}

/** Drop shorter labels fully contained in a longer candidate (e.g. street duplicated in full address). */
function collapseRedundantPropertyCandidates(values: string[]): string[] {
  const usable = values.map((v) => v.trim()).filter(Boolean);
  if (usable.length <= 1) return usable;
  return usable.filter((candidate, index) => {
    const lower = candidate.toLowerCase();
    return !usable.some((other, otherIndex) => {
      if (otherIndex === index) return false;
      return other.length > candidate.length && other.toLowerCase().includes(lower);
    });
  });
}

/**
 * First human-friendly candidate that is not a raw id / seed token. Falls back
 * to any non-id candidate, then a generic label — never the bare id. Shared by
 * every property picker so labels stay consistent and clean across surfaces.
 */
export function safePropertyOptionLabel(candidates: Array<string | null | undefined>, id: string): string {
  const usable = collapseRedundantPropertyCandidates(
    candidates.map((c) => (c ?? "").trim()).filter((v) => v && !looksLikeRawPropertyId(v, id)),
  );
  // Prefer a distinctive name over the "Property · N rooms" placeholder.
  const distinctive = usable.find((v) => !looksLikeGenericPropertyTitle(v));
  if (distinctive) return distinctive;
  if (usable.length > 0) return usable[0];
  for (const c of candidates) {
    const v = (c ?? "").trim();
    if (v && v !== id.trim()) return v;
  }
  return "Untitled property";
}

/** A short, stable tail of the id — enough to tell two otherwise identical rows apart. */
function propertyIdSuffix(id: string): string {
  const trimmed = id.trim();
  return trimmed.length > 6 ? trimmed.slice(-6) : trimmed;
}

/**
 * Make every label in a picker distinct.
 *
 * `buildingName` is optional, so an unnamed listing falls back to a generic
 * "Property · N rooms" placeholder — and EVERY such listing renders the same
 * string, so a manager with two of them cannot tell which is which (PRP-211).
 * That is a nuisance in most dropdowns and a real hazard in the co-manager
 * property picker, where picking the wrong row grants a third party access to
 * the wrong property.
 *
 * Disambiguation is by ADDRESS first, because that is how managers actually
 * refer to a property and it is already required at step 0; only when two rows
 * share even that does it fall back to a slice of the id.
 */
export function disambiguatePropertyOptionLabels<T extends { id: string; label: string; address?: string | null }>(
  options: T[],
): T[] {
  const counts = new Map<string, number>();
  for (const option of options) counts.set(option.label, (counts.get(option.label) ?? 0) + 1);

  const usedLabels = new Set<string>();
  return options.map((option) => {
    if ((counts.get(option.label) ?? 0) <= 1) {
      usedLabels.add(option.label);
      return option;
    }
    const address = (option.address ?? "").trim();
    const byAddress = address && address !== option.label ? `${option.label} · ${address}` : "";
    const candidate = byAddress && !usedLabels.has(byAddress) ? byAddress : "";
    const label = candidate || `${option.label} · ${propertyIdSuffix(option.id)}`;
    usedLabels.add(label);
    return { ...option, label };
  });
}

/** Human-readable label for a property id across owned, linked, and pending pipeline rows. */
export function resolvePropertyLabelForId(id: string, fallback?: string): string {
  const pid = id.trim();
  if (!pid) return fallback?.trim() || "Untitled property";
  const fromExtras = readAllExtraListings().find((p) => p.id === pid);
  if (fromExtras) {
    return safePropertyOptionLabel(
      [fromExtras.buildingName, fromExtras.unitLabel, fromExtras.title, fromExtras.address],
      pid,
    );
  }
  const pending = readAllPendingManagerProperties().find((p) => p.id === pid);
  if (pending) {
    const joined = [pending.buildingName, pending.unitLabel, pending.address].filter(Boolean).join(" · ");
    return safePropertyOptionLabel([joined, pending.buildingName, pending.address], pid);
  }
  return safePropertyOptionLabel([fallback], pid);
}

/** Labels for Applications / Payments property dropdowns. */
export function buildManagerPropertyFilterOptions(userId: string | null): ManagerPropertyFilterOption[] {
  const scopeUserId = resolveManagerScopeUserId(userId);
  if (!scopeUserId) return [];
  const labelById = new Map<string, string>();

  for (const p of readScopedExtraListings(scopeUserId)) {
    labelById.set(p.id, safePropertyOptionLabel([p.title, p.buildingName, p.address], p.id));
  }
  for (const r of readPendingManagerPropertiesForUser(scopeUserId)) {
    labelById.set(r.id, resolvePropertyLabelForId(r.id));
  }

  const allExtras = readAllExtraListings();
  for (const rel of readProRelationships(scopeUserId)) {
    for (const pid of rel.assignedPropertyIds) {
      if (!pid.trim() || labelById.has(pid)) continue;
      const found = allExtras.find((x) => x.id === pid);
      const pending = readAllPendingManagerProperties().find((x) => x.id === pid);
      const pendingJoined = pending
        ? resolvePropertyLabelForId(pid)
        : undefined;
      labelById.set(
        pid,
        safePropertyOptionLabel([found?.title, found?.buildingName, pendingJoined, found?.address], pid),
      );
    }
  }

  for (const pid of collectLinkedPropertyIds(scopeUserId)) {
    if (labelById.has(pid)) continue;
    const found = allExtras.find((x) => x.id === pid);
    const pending = readAllPendingManagerProperties().find((x) => x.id === pid);
    const pendingJoined = pending ? resolvePropertyLabelForId(pid) : undefined;
    labelById.set(
      pid,
      safePropertyOptionLabel([found?.title, found?.buildingName, pendingJoined, found?.address], pid),
    );
  }

  for (const row of readManagerApplicationRows()) {
    if (!applicationVisibleToPortalUser(row, scopeUserId)) continue;
    const pid = row.assignedPropertyId?.trim() || row.propertyId?.trim() || row.application?.propertyId?.trim();
    if (pid && !labelById.has(pid)) {
      labelById.set(pid, resolvePropertyLabelForId(pid, row.property));
    }
  }

  return [...labelById.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}

/** Listings from linked accounts that this user has been given access to. */
export function readLinkedListingsForUser(userId: string): { listing: MockProperty; canEdit: boolean; ownerUserId: string }[] {
  const allListings = readAllExtraListings();
  const seen = new Set<string>();
  const result: { listing: MockProperty; canEdit: boolean; ownerUserId: string }[] = [];

  const resolveListing = (pid: string): { listing: MockProperty; ownerUserId: string } | null => {
    const fromExtras = allListings.find((l) => samePropertyId(l.id, pid));
    if (fromExtras) {
      const ownerUserId = fromExtras.managerUserId?.trim() ?? "";
      return ownerUserId ? { listing: fromExtras, ownerUserId } : null;
    }
    const pending = readAllPendingManagerProperties().find((p) => samePropertyId(p.id, pid));
    if (pending) {
      const ownerUserId = pending.submittedByUserId?.trim() ?? "";
      if (!ownerUserId) return null;
      return { listing: buildMockPropertyFromDraft(pending, pending.id), ownerUserId };
    }
    return null;
  };

  const permissionsForPropertyId = (pid: string): PropertyCoManagerPermissions[string] | undefined => {
    for (const rel of readProRelationships(userId)) {
      if (rel.linkDirection === "outgoing") continue;
      if (!rel.assignedPropertyIds.some((id) => samePropertyId(id, pid))) continue;
      return permissionsForProperty(rel.propertyCoManagerPermissions, pid);
    }
    for (const inv of readCachedAccountLinkInvites()) {
      if (inv.status !== "accepted" || inv.direction !== "incoming") continue;
      if (!inv.assignedPropertyIds.some((id) => samePropertyId(id, pid))) continue;
      return permissionsForProperty(inv.propertyCoManagerPermissions, pid);
    }
    return undefined;
  };

  for (const pid of collectLinkedPropertyIds(userId)) {
    if (seen.has(pid)) continue;
    const resolved = resolveListing(pid);
    if (!resolved) continue;
    const { listing, ownerUserId } = resolved;
    if (ownerUserId === userId) continue;
    seen.add(pid);
    const perms = permissionsForPropertyId(pid);
    const rel = readProRelationships(userId).find(
      (row) => row.linkDirection !== "outgoing" && row.assignedPropertyIds.some((id) => samePropertyId(id, pid)),
    );
    result.push({
      listing,
      canEdit:
        hasCoManagerPermissionForProperty(rel?.propertyCoManagerPermissions, pid, "properties") ||
        hasCoManagerPermission(perms, "properties") ||
        hasCoManagerPermission(rel?.coManagerPermissions, "properties") ||
        rel?.canEditListing === true,
      ownerUserId,
    });
  }
  return result;
}

export const MANAGER_PORTFOLIO_REFRESH_EVENTS = [
  PROPERTY_PIPELINE_EVENT,
  "axis-pro-relationships",
  "storage",
  MANAGER_APPLICATIONS_EVENT,
] as const;
