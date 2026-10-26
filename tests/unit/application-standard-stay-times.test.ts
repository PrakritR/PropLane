import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
vi.mock("server-only", () => ({}));
import { standardizeApplicantStayTimes } from "@/lib/rental-application/standard-stay-times.server";

function row(stage = "In progress"): DemoApplicantRow {
  return { id: "app", bucket: "pending", stage, propertyId: "host-house", application: {
    propertyId: "host-house", rentalType: "short_term", shortTermCheckInTime: "01:00", shortTermCheckOutTime: "23:59",
  } } as DemoApplicantRow;
}
function database(stayTimes: unknown) {
  const eq = vi.fn().mockReturnThis();
  const db = { from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnThis(), eq,
    maybeSingle: vi.fn().mockResolvedValue({ data: { property_data: { listingSubmission: { stayTimes } } } }),
  }) };
  return { db: db as unknown as SupabaseClient, eq, from: db.from };
}

describe("applicant standard stay clock", () => {
  it("ignores forged times and stamps the host's stored clock", async () => {
    const { db, eq } = database({ checkInTime: "16:00", checkOutTime: "10:00" });
    const result = await standardizeApplicantStayTimes(db, row());
    expect(eq).toHaveBeenCalledWith("id", "host-house");
    expect(result.application).toMatchObject({ shortTermCheckInTime: "16:00", shortTermCheckOutTime: "10:00" });
  });
  it("uses standard defaults when the property has no custom times", async () => {
    const { db } = database(undefined);
    expect((await standardizeApplicantStayTimes(db, row())).application).toMatchObject({ shortTermCheckInTime: "15:00", shortTermCheckOutTime: "11:00" });
  });
  it("preserves the existing submitted clock without reading newer host defaults", async () => {
    const { db, from } = database({ checkInTime: "16:00", checkOutTime: "10:00" });
    const existing = row("Submitted");
    const result = await standardizeApplicantStayTimes(db, row(), existing);
    expect(result.application).toMatchObject({ shortTermCheckInTime: "01:00", shortTermCheckOutTime: "23:59" });
    expect(from).not.toHaveBeenCalled();
  });
});
