import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertCompleteSeedAuthDirectory, seedOrphanProfileIds } from "../helpers/seed-orphan-profile-scope.mjs";

const profiles = [
  { id: "developer", email: "developer@example.com" },
  { id: "other-run", email: "another-test@test.proplane.local" },
  { id: "canonical", email: "manager@test.proplane.local" },
  { id: "orphan", email: "removed-test@test.proplane.local" },
  { id: "outside", email: "outside@example.com" },
];
const input = { profiles, users: [{ id: "developer" }, { id: "other-run" }], canonicalEmails: new Set(["manager@test.proplane.local"]), testAccountDomain: "@test.proplane.local", pruneAllowed: false };

describe("test seed orphan cleanup", () => {
  it("default seed preserves every profile, including noncanonical accounts", () => {
    expect(seedOrphanProfileIds(input)).toEqual([]);
  });
  it("explicit prune keeps live test accounts, developer accounts and canonical fixtures", () => {
    expect(seedOrphanProfileIds({ ...input, pruneAllowed: true })).toEqual(["orphan"]);
  });
  it("fails closed when the auth result may have another page", () => {
    const users = Array.from({ length: 1000 }, (_, n) => ({ id: `u-${n}` }));
    expect(() => assertCompleteSeedAuthDirectory(users)).toThrow("complete auth directory");
    expect(() => seedOrphanProfileIds({ ...input, users, pruneAllowed: true })).toThrow("complete auth directory");
  });
  it("does not revoke orphan profile roles before attempting profile deletion", () => {
    const seed = readFileSync("tests/helpers/seed-test-db.mjs", "utf8");
    expect(seed).not.toContain('from("profile_roles").delete().in("user_id", orphanProfileIds)');
    expect(seed).toContain('from("profiles").delete().in("id", orphanProfileIds)');
  });
});
