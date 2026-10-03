import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(`${process.cwd()}/${path}`, "utf8");

describe("Edit resident wizard shows the real record (C2-ER5 / ER7 / ER8)", () => {
  const index = read("src/components/portal/resident-wizard/index.tsx");
  const steps = read("src/components/portal/resident-wizard/edit-steps.tsx");

  it("Payments, Documents, Lease and Application read the record in edit mode only", () => {
    expect(index).toContain("<EditPaymentsStep");
    expect(index).toContain("<EditDocumentsStep");
    expect(index).toContain('editRecord={mode === "edit" ? editContext?.record : undefined}');
    // Add mode keeps today's steps.
    expect(index).toContain("<PaymentsStep form={form}");
    expect(index).toContain("<DocumentsStep form={form}");
  });

  it("Payments groups Overdue, Pending and Paid with the paid-of line and the deposit", () => {
    for (const label of ['label="Overdue"', 'label="Pending"', 'label="Paid"', "residentEditPaidOfLine", "residentEditDepositLine", 'title="Rent schedule"']) {
      expect(steps).toContain(label);
    }
  });

  it("Application carries status, household, housing charges and placement as cards", () => {
    for (const title of ['title="Status"', 'title="Household"', 'title="Housing charges (listing)"', 'title="Manager final placement"']) {
      expect(steps).toContain(title);
    }
  });

  it("Documents rows have a ⋯ menu and Add document", () => {
    expect(steps).toContain("residents-wizard-document-menu");
    expect(steps).toContain("+ Add document");
  });

  it("Save writes the Application step's answers back to the application", () => {
    const residents = read("src/components/portal/pro-residents.tsx");
    expect(residents).toContain("applicationAnswerPatch");
    expect(residents).toContain("...applicationAnswerPatch");
  });
});

describe("Resident section header cards (C2-RT3)", () => {
  const residents = read("src/components/portal/pro-residents.tsx");

  it("Payments and Services put their tabs in the section toolbar's destination row, not a second card", () => {
    expect(residents).not.toContain("<ResidentDetailSubsectionChrome");
    expect(residents).toContain("destinationRow={");
    expect(residents).toContain('ariaLabel="Service status"');
    expect(residents).toContain('ariaLabel="Payment status"');
    expect(residents).toContain('dataAttr: "resident-services-search"');
  });

  it("a service row carries one ⋯ menu with Edit first", () => {
    const menu = residents.slice(residents.indexOf("const residentServiceRowMenu"));
    expect(menu.indexOf('data-attr="resident-service-row-edit"')).toBeLessThan(menu.indexOf('data-attr="resident-service-row-delete"'));
  });
});
