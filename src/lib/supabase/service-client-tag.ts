/**
 * Marks the clients `createSupabaseServiceRoleClient` hands out. A global snapshot (one answer for every caller)
 * may only be built from a client that sees every row; a session client sees its own rows and would poison it.
 * A client that was never tagged (a test double, a session client) simply does not use the snapshot.
 */
const serviceRoleClients = new WeakSet<object>();

export function tagServiceRoleClient<T extends object>(client: T): T {
  serviceRoleClients.add(client);
  return client;
}

export function isServiceRoleClient(client: unknown): boolean {
  return typeof client === "object" && client !== null && serviceRoleClients.has(client);
}
