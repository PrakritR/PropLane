/**
 * ONE rule for "which resident is this row about", shared by every manager list that groups by
 * person: payments, tours, and service requests / work orders.
 *
 * These lists are read side by side. If tours grouped by email while payments grouped by name,
 * the same person would head two differently-shaped groups on two tabs, and a manager comparing
 * them would reasonably conclude PropLane had lost track of who they are. Sharing the identity
 * rule is what keeps "Ahalya Bindhu Rajesh" the same row header everywhere.
 *
 * Identity is EMAIL first, because that is what the resident actually signs in and is billed
 * under, and two different people may share a display name. A name is only a fallback for rows
 * that carry no address — a manually added prospect, an unlinked tour request — and the row's own
 * id is the last resort, which deliberately groups such a row ALONE rather than merging it with a
 * stranger. Losing a group header is cosmetic; merging two people's charges is not.
 */
export type ResidentIdentityFields = {
  id: string;
  residentName?: string | null;
  residentEmail?: string | null;
};

export type ResidentCluster<T> = {
  key: string;
  residentLabel: string;
  residentEmail?: string;
  /** Set only when every row in the cluster shares one property label. */
  propertyLabel: string | null;
  rows: T[];
};

/** Which dimension a manager list groups its rows under. */
export type PortalListGroupMode = "resident" | "house";

export type PropertyClusterFields = {
  id: string;
  propertyId?: string | null;
  propertyLabel?: string | null;
};

export type PropertyCluster<T> = {
  key: string;
  propertyLabel: string;
  rows: T[];
};

/** Header text for a resident group — their name, else their email, else an em dash. */
export function residentClusterLabel(row: ResidentIdentityFields): string {
  const name = row.residentName?.trim();
  if (name) return name;
  const email = row.residentEmail?.trim();
  if (email?.includes("@")) return email;
  return "—";
}

/**
 * Grouping key. Prefixed by kind (`email:` / `name:` / `id:`) so a person whose NAME happens to
 * equal someone else's email cannot collide into their group.
 */
export function residentClusterKey(row: ResidentIdentityFields): string {
  const email = row.residentEmail?.trim().toLowerCase();
  if (email?.includes("@")) return `email:${email}`;
  const name = row.residentName?.trim().toLowerCase();
  if (name) return `name:${name}`;
  return `id:${row.id}`;
}

/**
 * Group rows under one resident header, PRESERVING the incoming order.
 *
 * Order is preserved deliberately: the caller has already sorted (by due date, by tour time), and
 * re-sorting here would silently override a sort the surface chose and the manager can see.
 *
 * `propertyLabelOf` is optional — a list whose rows carry no property simply gets `null`, which
 * renders as no property line rather than a wrong one.
 */
export function clusterRowsByResident<T extends ResidentIdentityFields>(
  rows: readonly T[],
  propertyLabelOf?: (row: T) => string | null | undefined,
): ResidentCluster<T>[] {
  const out: ResidentCluster<T>[] = [];
  const byKey = new Map<string, ResidentCluster<T>>();

  const sharedLabel = (clusterRows: readonly T[]): string | null => {
    if (!propertyLabelOf || clusterRows.length === 0) return null;
    const first = propertyLabelOf(clusterRows[0]!)?.trim();
    if (!first) return null;
    // Only claim a shared property when EVERY row agrees. A resident with rows at two properties
    // gets no header label rather than the first row's, which would misattribute the rest.
    return clusterRows.every((row) => propertyLabelOf(row)?.trim() === first) ? first : null;
  };

  for (const row of rows) {
    const key = residentClusterKey(row);
    const existing = byKey.get(key);
    if (existing) {
      existing.rows.push(row);
      existing.propertyLabel = sharedLabel(existing.rows);
      continue;
    }
    const cluster: ResidentCluster<T> = {
      key,
      residentLabel: residentClusterLabel(row),
      residentEmail: row.residentEmail?.trim() || undefined,
      propertyLabel: sharedLabel([row]),
      rows: [row],
    };
    byKey.set(key, cluster);
    out.push(cluster);
  }

  return out;
}

/** Header text for a property group — the house label, else an em dash. */
export function propertyClusterLabel(row: PropertyClusterFields): string {
  const label = row.propertyLabel?.trim();
  if (label) return label;
  return "—";
}

/**
 * Grouping key for a house cluster. Prefixed by kind so a property id cannot collide with a row id.
 */
export function propertyClusterKey(row: PropertyClusterFields): string {
  const id = row.propertyId?.trim();
  if (id) return `property:${id}`;
  const label = row.propertyLabel?.trim().toLowerCase();
  if (label) return `label:${label}`;
  return `row:${row.id}`;
}

/**
 * Group rows under one property header, preserving the incoming order.
 *
 * Rows with no property each stay alone rather than merging with strangers.
 */
export function clusterRowsByProperty<T extends PropertyClusterFields>(
  rows: readonly T[],
): PropertyCluster<T>[] {
  const out: PropertyCluster<T>[] = [];
  const byKey = new Map<string, PropertyCluster<T>>();

  for (const row of rows) {
    const key = propertyClusterKey(row);
    const existing = byKey.get(key);
    if (existing) {
      existing.rows.push(row);
      continue;
    }
    const cluster: PropertyCluster<T> = {
      key,
      propertyLabel: propertyClusterLabel(row),
      rows: [row],
    };
    byKey.set(key, cluster);
    out.push(cluster);
  }

  return out;
}
