import { describe, expect, it } from "vitest";
import { profilePhoneVariants, readSmsSuppressionState } from "@/lib/sms-consent";

describe("profilePhoneVariants", () => {
  it("never emits punctuation forms that break numeric profiles.phone lookups", () => {
    for (const raw of ["+14086685132", "(408) 668-5132", "408-668-5132"]) {
      for (const variant of profilePhoneVariants(raw)) {
        expect(variant).toMatch(/^\+?\d+$/);
      }
    }
    expect(profilePhoneVariants("+14086685132")).toEqual(
      expect.arrayContaining(["4086685132", "14086685132", "+14086685132"]),
    );
  });
});

describe("readSmsSuppressionState profile lookup", () => {
  it("does not fail closed when profiles.phone is queried with digit variants", async () => {
    let inValues: string[] = [];
    const db = {
      from(table: string) {
        if (table === "sms_consent") {
          const chain = {
            select: () => chain,
            eq: () => chain,
            maybeSingle: async () => ({ data: null, error: null }),
          };
          return chain;
        }
        if (table === "profiles") {
          const chain = {
            select: () => chain,
            in: (_col: string, vals: string[]) => {
              inValues = vals;
              return chain;
            },
            then: (resolve: (v: unknown) => unknown) =>
              Promise.resolve({ data: [], error: null }).then(resolve),
          };
          return chain;
        }
        throw new Error(`unexpected table ${table}`);
      },
    } as never;

    const result = await readSmsSuppressionState(db, "+14086685132");
    expect(result).toEqual({ ok: true, optedOut: false });
    expect(inValues.every((value) => /^\+?\d+$/.test(value))).toBe(true);
  });
});
