import { describe, expect, it } from "vitest";
import {
  assertCloneEndpoint,
  decideRowFate,
  PROD_REF,
  STAGING_REF,
} from "../../scripts/lib/prod-staging-merge.mjs";

describe("decideRowFate", () => {
  it("keeps a staging-only row that was never in a snapshot", () => {
    expect(
      decideRowFate({ inProd: false, inStaging: true, inSnapshot: false }),
    ).toBe("keep-staging");
  });

  it("deletes a row prod removed", () => {
    expect(
      decideRowFate({ inProd: false, inStaging: true, inSnapshot: true }),
    ).toBe("delete-staging");
  });

  it("inserts a row that is new on prod", () => {
    expect(
      decideRowFate({ inProd: true, inStaging: false, inSnapshot: false }),
    ).toBe("insert-prod");
  });

  it("restores a row staging deleted when prod still has it", () => {
    expect(
      decideRowFate({ inProd: true, inStaging: false, inSnapshot: true }),
    ).toBe("insert-prod");
  });

  it("keeps a staging edit when prod did not change", () => {
    expect(
      decideRowFate({
        inProd: true,
        inStaging: true,
        inSnapshot: true,
        prodEqualsSnapshot: true,
        stagingEqualsSnapshot: false,
      }),
    ).toBe("keep-staging");
  });

  it("takes prod when only prod changed", () => {
    expect(
      decideRowFate({
        inProd: true,
        inStaging: true,
        inSnapshot: true,
        prodEqualsSnapshot: false,
        stagingEqualsSnapshot: true,
      }),
    ).toBe("update-prod");
  });

  it("takes prod when both sides changed", () => {
    expect(
      decideRowFate({
        inProd: true,
        inStaging: true,
        inSnapshot: true,
        prodEqualsSnapshot: false,
        stagingEqualsSnapshot: false,
      }),
    ).toBe("update-prod");
  });

  it("no-ops when nothing changed", () => {
    expect(
      decideRowFate({
        inProd: true,
        inStaging: true,
        inSnapshot: true,
        prodEqualsSnapshot: true,
        stagingEqualsSnapshot: true,
      }),
    ).toBe("noop");
  });
});

describe("assertCloneEndpoint", () => {
  it("accepts the staging project and refuses prod as the write target", () => {
    expect(() =>
      assertCloneEndpoint({
        kind: "staging",
        url: `https://${STAGING_REF}.supabase.co`,
      }),
    ).not.toThrow();
    expect(() =>
      assertCloneEndpoint({
        kind: "staging",
        url: `https://${PROD_REF}.supabase.co`,
      }),
    ).toThrow(/must not name the live production/);
  });

  it("accepts the production project as the read source", () => {
    expect(() =>
      assertCloneEndpoint({
        kind: "prod",
        url: `https://${PROD_REF}.supabase.co`,
      }),
    ).not.toThrow();
    expect(() =>
      assertCloneEndpoint({
        kind: "staging",
        url: "https://example.supabase.co",
      }),
    ).toThrow(/must name/);
  });
});
