import { expect, type Locator, type Page } from "@playwright/test";
import { pickListingSelect } from "./manager-onboarding-e2e";

/** The portal renders a hidden mobile shell alongside the desktop one — always take the visible node. */
export function visibleLocator(page: Page, selector: string): Locator {
  return page.locator(selector).filter({ visible: true }).first();
}

export function continueBtn(page: Page): Locator {
  return visibleLocator(page, '[data-attr="rental-wizard-continue"]');
}

export async function yesNo(page: Page, fieldKey: string, answer: "Yes" | "No") {
  await page
    .locator(`[data-wizard-field="${fieldKey}"] button`, { hasText: new RegExp(`^${answer}$`) })
    .filter({ visible: true })
    .first()
    .click();
}

export function usDateInDays(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

export async function pickApplySelect(page: Page, fieldLabel: string | RegExp, optionName: string) {
  const section = page.locator("div").filter({ has: page.getByText(fieldLabel) }).last();
  await section.getByRole("button").first().click();
  await page.getByRole("option", { name: optionName, exact: true }).filter({ visible: true }).first().click();
}

export async function openApplyAccountGate(page: Page, propertyId: string) {
  await page.goto(`/rent/apply?propertyId=${propertyId}`, { waitUntil: "domcontentloaded" });
  const createAccount = page.getByRole("link", { name: /create account/i }).filter({ visible: true }).first();
  const guestBtn = page.locator('[data-attr="public-apply-continue-guest"]');
  await expect(createAccount).toBeVisible({ timeout: 60_000 });
  await expect(guestBtn).toHaveCount(0);
}

/** @deprecated Guest apply is gone (PLAN-0924-1421). Prefer {@link openApplyAccountGate}. */
export async function openGuestApplyWizard(page: Page, propertyId: string) {
  await openApplyAccountGate(page, propertyId);
}

/**
 * Walk the rental wizard after the resident is already signed in (or the
 * account gate has been cleared). Guest continue was removed — do not click it.
 */
export async function walkSignedInRentalApplication(
  page: Page,
  propertyId: string,
  applicant: ApplicantInfo,
  household: HouseholdConfig = { kind: "solo" },
) {
  await page.goto(`/rent/apply?propertyId=${propertyId}`, { waitUntil: "domcontentloaded" });
  const guestBtn = page.locator('[data-attr="public-apply-continue-guest"]');
  await expect(guestBtn).toHaveCount(0);
  const householdStep = page.locator('[data-wizard-field="applyingAsGroup"]').filter({ visible: true }).first();
  const createAccount = page.getByRole("link", { name: /create account/i }).filter({ visible: true }).first();
  // If the account gate is still up, stop — the caller must create/sign in first.
  if (await createAccount.isVisible().catch(() => false)) {
    await expect(createAccount).toBeVisible();
    return;
  }
  await expect(householdStep).toBeVisible({ timeout: 60_000 });

  await fillHouseholdStep(page, household);
  await continueBtn(page).click();

  await fillSignerStep(page, applicant);
  await continueBtn(page).click();

  await fillPropertyLeaseStep(page);
  await continueBtn(page).click();

  await fillCurrentAddressStep(page);
  await continueBtn(page).click();

  await fillPreviousAddressStep(page);
  await continueBtn(page).click();

  await fillEmploymentStep(page);
  await continueBtn(page).click();

  await fillReferencesStep(page);
  await continueBtn(page).click();

  await fillAdditionalDetailsStep(page);
  await continueBtn(page).click();

  await fillConsentStep(page, applicant.name);
  await continueBtn(page).click();

  await submitReviewAndApplication(page);
}

/** @deprecated Use {@link walkSignedInRentalApplication} — guest path removed. */
export async function walkGuestRentalApplication(
  page: Page,
  propertyId: string,
  applicant: ApplicantInfo,
  household: HouseholdConfig = { kind: "solo" },
) {
  await walkSignedInRentalApplication(page, propertyId, applicant, household);
}

export type HouseholdConfig =
  | { kind: "solo" }
  | { kind: "group-first"; size: string }
  | { kind: "group-joining"; groupId: string };

export async function fillHouseholdStep(page: Page, config: HouseholdConfig, cosigner: "Yes" | "No" = "No") {
  if (config.kind === "solo") {
    await yesNo(page, "applyingAsGroup", "No");
  } else {
    await yesNo(page, "applyingAsGroup", "Yes");
    if (config.kind === "group-first") {
      await page
        .getByRole("button", { name: /I am the first person applying/i })
        .filter({ visible: true })
        .first()
        .click();
      await visibleLocator(page, "#groupSize").selectOption(config.size);
    } else {
      await page
        .getByRole("button", { name: /I am joining an existing group/i })
        .filter({ visible: true })
        .first()
        .click();
      await visibleLocator(page, "#groupId").fill(config.groupId);
    }
  }
  await yesNo(page, "hasCosigner", cosigner);
}

export type ApplicantInfo = { name: string; email: string; phone: string };

export async function fillSignerStep(page: Page, applicant: ApplicantInfo, dateOfBirth = "06/15/1995") {
  await expect(visibleLocator(page, "#fullLegalName")).toBeVisible();
  await visibleLocator(page, "#fullLegalName").fill(applicant.name);
  await visibleLocator(page, "#dateOfBirth").fill(dateOfBirth);
  await visibleLocator(page, "#ssn").fill("123456789");
  await visibleLocator(page, "#driversLicense").fill("WDL8831001");
  await visibleLocator(page, "#phone").fill(applicant.phone);
  const email = visibleLocator(page, "#email");
  if (await email.isEditable()) await email.fill(applicant.email);
}

export async function fillPropertyLeaseStep(page: Page, leaseTerm = "12-Month") {
  await expect(page.getByText(/Property Information/i).filter({ visible: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  const leaseTrigger = page.getByRole("button", { name: "Select lease length" }).filter({ visible: true }).first();
  if (await leaseTrigger.count()) {
    await pickListingSelect(page, "Select lease length", leaseTerm);
  } else {
    const nativeLease = visibleLocator(page, "#leaseTerm");
    if (await nativeLease.count()) {
      const values = await nativeLease
        .locator("option")
        .evaluateAll((opts) => (opts as HTMLOptionElement[]).map((o) => o.value).filter(Boolean));
      if (values[0]) await nativeLease.selectOption(values[0]);
    }
  }
  const startBox = page
    .getByRole("textbox", { name: /Lease start date/i })
    .filter({ visible: true })
    .first();
  if (await startBox.count()) {
    await startBox.fill(usDateInDays(30));
    await startBox.blur();
  } else {
    const legacyStart = visibleLocator(page, "#leaseStart");
    await legacyStart.fill(usDateInDays(30));
    await legacyStart.blur();
  }
  const endBox = page
    .getByRole("textbox", { name: /Lease end date/i })
    .filter({ visible: true })
    .first();
  const legacyEnd = visibleLocator(page, "#leaseEnd");
  const endTarget = (await endBox.count()) ? endBox : legacyEnd;
  if (await endTarget.isVisible() && !(await endTarget.inputValue())) {
    await endTarget.fill(usDateInDays(395));
  }
}

export async function fillCurrentAddressStep(
  page: Page,
  address = { street: "1200 Pike St, Unit 8", city: "Seattle", state: "WA", zip: "98101" },
) {
  await expect(visibleLocator(page, "#currentStreet")).toBeVisible();
  await visibleLocator(page, "#currentStreet").fill(address.street);
  await visibleLocator(page, "#currentCity").fill(address.city);
  await visibleLocator(page, "#currentState").fill(address.state);
  await visibleLocator(page, "#currentZip").fill(address.zip);
}

export async function fillPreviousAddressStep(page: Page) {
  await page.getByText(/I do not have a previous address/i).filter({ visible: true }).first().click();
}

export async function fillEmploymentStep(page: Page, employer = "Cascade Analytics", income = "7200") {
  await expect(visibleLocator(page, "#employer")).toBeVisible();
  await visibleLocator(page, "#employer").fill(employer);
  await visibleLocator(page, "#monthlyIncome").fill(income);
}

export async function fillReferencesStep(
  page: Page,
  ref = { name: "Alex Morgan", relationship: "Supervisor", phone: "2065550177" },
) {
  await expect(visibleLocator(page, "#ref1Name")).toBeVisible();
  await visibleLocator(page, "#ref1Name").fill(ref.name);
  await visibleLocator(page, "#ref1Relationship").fill(ref.relationship);
  await visibleLocator(page, "#ref1Phone").fill(ref.phone);
}

export async function fillAdditionalDetailsStep(page: Page, occupants = "1") {
  await expect(page.getByText(/Additional Details/i)).toBeVisible();
  const nativeOccupants = visibleLocator(page, "#occupancyCount");
  if (await nativeOccupants.count()) {
    await nativeOccupants.selectOption(occupants);
  } else {
    await pickApplySelect(page, /Number of occupants/, occupants);
  }
  await yesNo(page, "evictionHistory", "No");
  await yesNo(page, "bankruptcyHistory", "No");
  await yesNo(page, "criminalHistory", "No");
}

export async function fillConsentStep(page: Page, signatureName: string) {
  await expect(visibleLocator(page, "#digitalSignature")).toBeVisible();
  await visibleLocator(page, '[data-wizard-field="consentCredit"] input[type="checkbox"]').check();
  await visibleLocator(page, '[data-wizard-field="consentTruth"] input[type="checkbox"]').check();
  await visibleLocator(page, "#digitalSignature").fill(signatureName);
  await visibleLocator(page, "#dateSigned").fill(usDateInDays(0));
}

function applicationSubmitted(page: Page) {
  return page
    .getByText(/Application (ID:|submitted)/i)
    .filter({ visible: true })
    .first();
}

export async function submitReviewAndApplication(page: Page, opts?: { expectFinishPanel?: boolean }) {
  await expect(continueBtn(page)).toBeVisible({ timeout: 15_000 });
  await continueBtn(page).click();
  await expect(continueBtn(page)).toHaveText(/submit application/i, { timeout: 30_000 });
  await continueBtn(page).click();
  if (opts?.expectFinishPanel !== false) {
    await expect(applicationSubmitted(page)).toBeVisible({ timeout: 120_000 });
  }
}

/** Walk the 11-step rental wizard as a signed-in resident and submit. */
// (legacy walkGuestRentalApplication body removed — see walkSignedInRentalApplication above)
