import { describe, expect, it } from "vitest";
import { createDefaultListingSubmission, normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

describe("bathrooms and shared spaces never share an id", () => {
  it("re-mints a repeated bathroom id, stably", () => {
    const base = createDefaultListingSubmission();
    const bath = { ...(base.bathrooms[0] ?? {}), id: "bath-1791034156965", name: "Main" } as (typeof base.bathrooms)[number];
    const sub = { ...base, bathrooms: [bath, { ...bath, name: "Upper" }] };
    const once = normalizeManagerListingSubmissionV1(sub);
    const ids = once.bathrooms.map((b) => b.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toBe("bath-1791034156965");
    expect(normalizeManagerListingSubmissionV1(once).bathrooms.map((b) => b.id)).toEqual(ids);
  });
});
