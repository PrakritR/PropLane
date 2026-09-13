/** A partial auth directory can never prove that a profile is an orphan. */
export function assertCompleteSeedAuthDirectory(users, pageSize = 1000) {
  if (!Array.isArray(users) || users.length >= pageSize) {
    throw new Error("Seed cleanup requires a complete auth directory; paginate before pruning.");
  }
}

/** Cleanup may touch only explicitly requested, noncanonical test orphans. */
export function seedOrphanProfileIds({ profiles, users, canonicalEmails, testAccountDomain, pruneAllowed }) {
  if (!pruneAllowed) return [];
  assertCompleteSeedAuthDirectory(users);
  const authIds = new Set(users.map((user) => user.id));
  return profiles.filter((profile) => {
    const email = String(profile.email ?? "").trim().toLowerCase();
    return !authIds.has(profile.id) && email.endsWith(testAccountDomain) && !canonicalEmails.has(email);
  }).map((profile) => profile.id);
}
