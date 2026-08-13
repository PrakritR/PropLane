import type { DemoApplicantRow } from "@/data/demo-portal";
import type { ResidentDocumentMatch } from "@/lib/resident-document-import/types";
import { firstEmail } from "@/lib/resident-document-import/text-extract";

export function matchResidentFromApplications(
  rows: DemoApplicantRow[],
  input: { email?: string | null; name?: string | null },
  managerUserId?: string | null,
): ResidentDocumentMatch {
  const email = input.email?.trim().toLowerCase() ?? firstEmail(input.name ?? "") ?? "";
  if (email) {
    const byEmail = rows.filter(
      (row) =>
        row.email?.trim().toLowerCase() === email &&
        (!managerUserId || !row.managerUserId || row.managerUserId === managerUserId),
    );
    if (byEmail.length === 1) {
      return {
        kind: "existing",
        applicationId: byEmail[0]!.id,
        residentName: byEmail[0]!.name?.trim() || "Resident",
        residentEmail: email,
      };
    }
  }

  const name = input.name?.trim().toLowerCase() ?? "";
  if (name) {
    const byName = rows.filter(
      (row) =>
        row.name?.trim().toLowerCase() === name &&
        (!managerUserId || !row.managerUserId || row.managerUserId === managerUserId),
    );
    if (byName.length === 1 && byName[0]!.email?.trim()) {
      return {
        kind: "existing",
        applicationId: byName[0]!.id,
        residentName: byName[0]!.name?.trim() || "Resident",
        residentEmail: byName[0]!.email!.trim().toLowerCase(),
      };
    }
  }

  return { kind: "new" };
}
