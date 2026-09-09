import { describe, expect, it } from "vitest";
import { assertBrowserDatabaseTarget } from "@/lib/supabase/browser-target";
const prod = "https://qahnczmilgptcedaqype.supabase.co";
const staging = "https://xwszcafaontidfgznlxd.supabase.co";
describe("browser database isolation", () => {
  it.each(["staging-prop-lane.space", "staging.prop-lane.space", "proplane-git-staging-team.vercel.app", "localhost"])("blocks a live bundle on %s", (host) => {
    expect(() => assertBrowserDatabaseTarget(prod, host)).toThrow(/environment mismatch/);
  });
  it("permits staging only on its dedicated database", () => {
    expect(() => assertBrowserDatabaseTarget(staging, "staging-prop-lane.space")).not.toThrow();
    expect(() => assertBrowserDatabaseTarget("https://emstjswhotsnyksqhqyf.supabase.co", "staging-prop-lane.space")).toThrow();
    expect(() => assertBrowserDatabaseTarget(prod, "prop-lane.space")).not.toThrow();
  });
});
