import { expect, type Locator, type Page } from "@playwright/test";
import { pickFieldSelect } from "./field-select";

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

export async function pickApplySelect(page: Page, dataAttr: string, optionName: string | RegExp) {
  const trigger = visibleLocator(page, `[data-attr="${dataAttr}"]`);
  await expect(trigger, `application select ${dataAttr} should be visible`).toBeVisible();
  await pickFieldSelect(page, trigger, optionName);
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
  await fillCurrentRentalApplication(page, applicant, household);
}

/** Fill the current seven-step wizard through its final submit action. */
export async function fillCurrentRentalApplication(
  page: Page,
  applicant: ApplicantInfo,
  household: HouseholdConfig,
  options: { existing?: boolean } = {},
) {
  await expect(page.locator("[data-wizard-lease-choice]").filter({ visible: true }).first()).toBeVisible({ timeout: 60_000 });
  await fillLeaseChoiceStep(page);
  await fillPropertyLeaseStep(page);
  await fillHouseholdStep(page, household);
  await continueBtn(page).click();
  await expect(visibleLocator(page, '[data-application-section="personal"]')).toBeVisible({ timeout: 30_000 });
  await fillSignerStep(page, applicant);
  await continueBtn(page).click();
  await expect(visibleLocator(page, "#currentStreet")).toBeVisible({ timeout: 30_000 });
  await fillCurrentAddressStep(page);
  await visibleLocator(page, "#currentLandlordName").fill("QA Property Manager");
  await visibleLocator(page, "#currentMoveIn").fill(usDateInDays(-900));
  await visibleLocator(page, "#currentReasonLeaving").fill("Relocating for work");
  await continueBtn(page).click();
  await expect(visibleLocator(page, "#employer")).toBeVisible({ timeout: 30_000 });
  await fillEmploymentStep(page);
  await continueBtn(page).click();
  await expect(visibleLocator(page, "#ref1Name")).toBeVisible({ timeout: 30_000 });
  await fillReferencesStep(page);
  await continueBtn(page).click();
  await expect(visibleLocator(page, '[data-attr="select-occupancyCount"]')).toBeVisible({ timeout: 30_000 });
  await fillAdditionalDetailsStep(page);
  await continueBtn(page).click();
  await expect(visibleLocator(page, "#digitalSignature")).toBeVisible({ timeout: 30_000 });
  await fillConsentStep(page, applicant.name);
  await assertPlacementReview(page);
  await submitReviewAndApplication(page, { ...(options.existing ? { existing: true } : {}), expectFinishPanel: !options.existing });
}

async function assertPlacementReview(page: Page) {
  const propertySection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Property information", exact: true }) }).first();
  await expect(propertySection).toBeVisible();
  const placementLabel = propertySection.locator("dt").filter({ hasText: /^(Room|Unit|Lease bundle)$/ }).first();
  await expect(placementLabel, "the submitted fixture must have a room, unit, or selected lease bundle").toBeVisible();
  const placementValue = placementLabel.locator("xpath=following-sibling::dd");
  await expect(placementValue).not.toHaveText("—");
  const moveInLabel = propertySection.locator("dt").filter({ hasText: /^(Move-in date|Check-in date)$/ }).first();
  await expect(moveInLabel, "the submitted fixture must include its selected start date").toBeVisible();
  await expect(moveInLabel.locator("xpath=following-sibling::dd")).not.toHaveText("—");
  const moveOutLabel = propertySection.locator("dt").filter({ hasText: /^(Move-out date|Check-out date)$/ }).first();
  if (await moveOutLabel.count()) await expect(moveOutLabel.locator("xpath=following-sibling::dd")).not.toHaveText("—");
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
  | { kind: "group-joining"; groupLeaderAppId: string };

export async function fillHouseholdStep(page: Page, config: HouseholdConfig, cosigner: "Yes" | "No" = "No") {
  const groupSelect = visibleLocator(page, '[data-attr="application-group"]');
  await expect(groupSelect).toBeVisible();
  await pickFieldSelect(page, groupSelect, config.kind === "solo" ? /^No$/ : /^Yes$/);
  if (config.kind === "group-first") {
    const stepper = page.locator('[data-attr="group-size-stepper"]').filter({ visible: true }).first();
    await expect(stepper).toBeVisible();
    const count = await stepper.locator('[aria-live="polite"]').innerText();
    const current = Number(count);
    const target = Number(config.size);
    if (!Number.isInteger(current) || !Number.isInteger(target) || target < 2 || target > 12) {
      throw new Error("Group fixture requires a valid group size from 2 through 12.");
    }
    for (let value = current; value > target; value -= 1) await stepper.getByRole("button", { name: /Fewer people in the group/i }).click();
    for (let value = current; value < target; value += 1) await stepper.getByRole("button", { name: /More people in the group/i }).click();
  } else if (config.kind === "group-joining") {
    const leader = visibleLocator(page, "#groupLeaderAppId");
    await leader.fill(config.groupLeaderAppId);
    await expect(page.getByText(/Linked to .* group/i).filter({ visible: true })).toBeVisible({ timeout: 15_000 });
  }
  await pickApplySelect(page, "application-cosigner", new RegExp(`^${cosigner}$`));
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

/** Step 1 is “Your lease”; it holds the selected property, lease type, dates and room/unit. */
export async function fillLeaseChoiceStep(page: Page, leaseTerm = "Long-term") {
  const leaseStep = page.locator("[data-wizard-lease-choice]").filter({ visible: true }).first();
  await expect(leaseStep).toBeVisible({ timeout: 30_000 });
  const kind = leaseTerm.toLowerCase().includes("short") ? "short" : "long";
  const kindChoice = visibleLocator(page, `[data-attr="rental-wizard-lease-kind-${kind}"]`);
  if (await kindChoice.isVisible().catch(() => false)) {
    if (await kindChoice.getAttribute("aria-checked") !== "true") await kindChoice.click();
  }
  const lengthTrigger = visibleLocator(page, '[data-attr="select-longTermLength"]');
  if (await lengthTrigger.isVisible().catch(() => false)) {
    const current = (await lengthTrigger.innerText()).trim();
    if (/pick a length/i.test(current)) {
      await lengthTrigger.click();
      const options = page.getByRole("option").filter({ visible: true });
      const count = await options.count();
      let selected = false;
      for (let index = 0; index < count; index += 1) {
        const option = options.nth(index);
        const label = (await option.innerText()).trim();
        if (label && !/pick a length/i.test(label) && (await option.getAttribute("aria-disabled")) !== "true") {
          await option.click();
          selected = true;
          break;
        }
      }
      if (!selected) throw new Error("The offered lease lengths did not contain a selectable choice.");
    }
  }
}

/** Step 1 dates and (when needed) room/unit are part of the same “Your lease” screen. */
export async function fillPropertyLeaseStep(page: Page, startDays = 30, endDays = 395) {
  await expect(page.locator("[data-wizard-lease-choice]").filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
  const start = visibleLocator(page, "#leaseStart");
  await expect(start, "the active lease form must expose its move-in or check-in date").toBeVisible();
  if (!(await start.inputValue())) {
    await start.fill(usDateInDays(startDays));
    await start.blur();
  }
  await expect(start).not.toHaveValue("");
  const end = visibleLocator(page, "#leaseEnd");
  if (await end.isVisible().catch(() => false) && !(await end.inputValue())) {
    await end.fill(usDateInDays(endDays));
    await end.blur();
  }
  if (await end.isVisible().catch(() => false)) await expect(end).not.toHaveValue("");

  const roomField = page.locator('[data-wizard-field="roomChoice1"]').filter({ visible: true }).first();
  const roomTrigger = roomField.getByRole("button").filter({ visible: true }).first();
  if (await roomTrigger.isVisible().catch(() => false)) {
    const current = (await roomTrigger.innerText()).trim();
    if (/^(select a room|select a unit)$/i.test(current)) {
      await roomTrigger.click();
      const options = page.getByRole("option").filter({ visible: true });
      const count = await options.count();
      let selected = false;
      for (let index = 0; index < count; index += 1) {
        const option = options.nth(index);
        const label = (await option.innerText()).trim();
        if (label && !/^select (a room|a unit)$/i.test(label) && (await option.getAttribute("aria-disabled")) !== "true") {
          await option.click();
          selected = true;
          break;
        }
      }
      if (!selected) throw new Error("The selected property has no available room or unit option.");
    }
    await expect(roomTrigger).not.toContainText(/^(select a room|select a unit)$/i);
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
  await expect(visibleLocator(page, '[data-attr="select-occupancyCount"]')).toBeVisible();
  await pickApplySelect(page, "select-occupancyCount", new RegExp(`^${occupants}$`));
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

export async function submitReviewAndApplication(page: Page, opts?: { expectFinishPanel?: boolean; existing?: boolean }) {
  await expect(continueBtn(page)).toHaveText(opts?.existing ? /save application/i : /submit application/i, { timeout: 30_000 });
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/api/manager-applications";
  }, { timeout: 45_000 });
  await continueBtn(page).click();
  const response = await responsePromise;
  if (!response.ok()) throw new Error(`Application ${opts?.existing ? "edit" : "submit"} failed (HTTP ${response.status()}).`);
  if (opts?.expectFinishPanel !== false) {
    await expect(applicationSubmitted(page)).toBeVisible({ timeout: 120_000 });
  }
}

/** Walk the current seven-screen rental wizard as a signed-in resident and submit. */
// (legacy walkGuestRentalApplication body removed — see walkSignedInRentalApplication above)
