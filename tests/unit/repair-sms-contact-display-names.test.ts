import { describe, expect, it, vi } from "vitest";
// @ts-expect-error - a plain .mjs script; its parser, guard and planner are the units under test
import { assertProjectAllowed, parseArgs, planDisplayNameRepair } from "../../scripts/repair-sms-contact-display-names.mjs";

const DEV = "emstjswhotsnyksqhqyf";
const row = (display_name: string | null, manager = "m1") => ({
  id: `${manager}-${display_name}`, manager_user_id: manager, phone_e164: "+14259849697", counterparty_role: "prospect", display_name, updated_at: "t",
});

describe("repair-sms-contact-display-names planner", () => {
  it("clears phrases and phone labels, keeps names, blanks and vendor-record labels", () => {
    const vendors = new Map([["m1", new Set(["joe's plumbing 24/7"])]]);
    const plan = planDisplayNameRepair(
      [row("looking for"), row("(425) 984-9697"), row("interested in the room"), row("Maya Chen"), row("maya"), row(null), row("Joe's Plumbing 24/7"), row("Joe's Plumbing 24/7", "m2")],
      vendors,
    );
    expect(plan.clear.map((entry: { row: { display_name: string } }) => entry.row.display_name)).toEqual([
      "looking for", "(425) 984-9697", "interested in the room", "Joe's Plumbing 24/7",
    ]);
    expect(plan.kept).toBe(3);
    expect(plan.blank).toBe(1);
  });
});

describe("repair-sms-contact-display-names guards", () => {
  it("is a dry run by default and requires --project-ref", () => {
    expect(parseArgs(["--project-ref", DEV]).apply).toBe(false);
    expect(() => parseArgs([])).toThrow(/project-ref/);
  });

  it("--apply needs a backup dir", () => {
    expect(() => parseArgs(["--project-ref", DEV, "--apply"])).toThrow(/backup-dir/);
    expect(parseArgs(["--project-ref", DEV, "--apply", "--backup-dir", "/x"]).apply).toBe(true);
  });

  it("refuses a project that is not the named one, and a non-dev apply without --allow-project", () => {
    const url = `https://${DEV}.supabase.co`;
    expect(() => assertProjectAllowed({ url, projectRef: "abc", apply: false, allowProject: null })).toThrow(/does not match/);
    expect(assertProjectAllowed({ url, projectRef: DEV, apply: true, allowProject: null })).toBe(DEV);
    const prod = "https://qahnczmilgptcedaqype.supabase.co";
    expect(() => assertProjectAllowed({ url: prod, projectRef: "qahnczmilgptcedaqype", apply: true, allowProject: null })).toThrow(/Refusing --apply/);
    expect(assertProjectAllowed({ url: prod, projectRef: "qahnczmilgptcedaqype", apply: true, allowProject: "qahnczmilgptcedaqype" })).toBe("qahnczmilgptcedaqype");
  });
});

// Writer: a guessed name never overwrites a saved one and never stores a phrase.
vi.mock("server-only", () => ({}));
describe("upsertManagerSmsContact suggestedDisplayName", () => {
  async function run(suggested: string, existing: string | null) {
    const { upsertManagerSmsContact } = await import("@/lib/sms/manager-sms-contacts.server");
    const upserts: Record<string, unknown>[] = [];
    const db = {
      from() {
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq"]) q[m] = () => q;
        q.maybeSingle = async () => ({ data: existing === null ? null : { display_name: existing }, error: null });
        q.upsert = async (payload: Record<string, unknown>) => { upserts.push(payload); return { error: null }; };
        return q;
      },
    };
    await upsertManagerSmsContact(db as never, {
      managerUserId: "m1", phone: "+14259849697", counterpartyRole: "prospect", suggestedDisplayName: suggested,
    });
    return upserts[0]!;
  }

  it("saves a plausible introduction when the contact has no name", async () => {
    expect((await run("Maya Chen", null)).display_name).toBe("Maya Chen");
  });
  it("never overwrites a name already saved", async () => {
    expect(await run("Maya Chen", "Maya C.")).not.toHaveProperty("display_name");
  });
  it("never stores a phrase or a phone label", async () => {
    expect(await run("looking for", null)).not.toHaveProperty("display_name");
    expect(await run("+1 (425) 984-9697", null)).not.toHaveProperty("display_name");
  });
});
