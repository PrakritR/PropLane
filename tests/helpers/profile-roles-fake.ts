type RoleRow = { user_id: string; role: string };

/**
 * A `profile_roles` query builder that behaves like PostgREST: it collects every
 * `.eq()` filter, matches only rows satisfying all of them, and resolves either
 * via `.maybeSingle()` (one capability probe) or by being awaited (the whole
 * role list).
 *
 * Role authorization reads the STORED table, so a fixture has to answer per
 * subject — a blanket row would grant a capability the test means to refuse.
 *
 * The filter list is cleared once a query resolves, so one instance can back
 * several reads in a row (a route that probes one capability and then lists the
 * whole grant) without the first read's filters narrowing the second.
 */
export function profileRolesBuilder(rows: readonly RoleRow[]) {
  let filters: Array<[string, unknown]> = [];
  const take = () => {
    const applied = filters;
    filters = [];
    return rows.filter((row) => applied.every(([col, val]) => (row as Record<string, unknown>)[col] === val));
  };
  const builder = {
    select: () => builder,
    eq: (col: string, val: unknown) => {
      filters.push([col, val]);
      return builder;
    },
    maybeSingle: async () => ({ data: take()[0] ?? null, error: null }),
    then: (resolve: (value: { data: RoleRow[]; error: null }) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve({ data: take(), error: null }).then(resolve, reject),
  };
  return builder;
}

/** The same builder, seeded from a `{ userId: [roles] }` map. */
export function profileRolesTable(rolesByUser: Record<string, readonly string[]>) {
  return profileRolesBuilder(
    Object.entries(rolesByUser).flatMap(([user_id, roles]) => roles.map((role) => ({ user_id, role }))),
  );
}
