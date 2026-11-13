import { createManagerCharge, type HouseholdCharge } from "@/lib/household-charges";

/**
 * Charging several residents of one house at once (the manager's Add charge flow). There is ONE write path: every
 * resident goes through `createManagerCharge`, which mirrors the row to `POST /api/portal-household-charges`, whose
 * `persistHouseholdChargeRows` writes the ledger (`syncLedgerChargeEntry`) and emits `charge_created`. That event is the
 * resident's one notice, through the normal channel rules; nothing here sends a notice of its own.
 */

/** The "everyone in this house" entry of the resident picker. */
export const EVERYONE_IN_HOUSE = "__everyone__";

/**
 * The picker's selection after a change. Ticking "Everyone in this house" ticks every resident of the house; unticking
 * it clears them; unticking one resident drops "everyone"; ticking the last resident by hand ticks "everyone". The
 * returned list holds resident ids only (never the everyone marker), in the house's own order.
 */
export function nextResidentSelection(previous: readonly string[], next: readonly string[], houseResidentIds: readonly string[]): string[] {
  const valid = new Set(houseResidentIds);
  const hadEveryone = previous.includes(EVERYONE_IN_HOUSE);
  const hasEveryone = next.includes(EVERYONE_IN_HOUSE);
  if (hasEveryone && !hadEveryone) return [...houseResidentIds];
  if (!hasEveryone && hadEveryone) {
    // "Everyone" was unticked: clear, unless the same change also unticked a single resident (then keep the rest).
    const remaining = next.filter((id) => valid.has(id));
    return remaining.length === houseResidentIds.length ? [] : houseResidentIds.filter((id) => remaining.includes(id));
  }
  return houseResidentIds.filter((id) => next.includes(id) && valid.has(id));
}

/** What the picker shows ticked: the residents, plus "everyone" while every resident of the house is in. */
export function pickerSelection(selectedIds: readonly string[], houseResidentIds: readonly string[]): string[] {
  const everyone = houseResidentIds.length > 0 && houseResidentIds.every((id) => selectedIds.includes(id));
  return everyone ? [EVERYONE_IN_HOUSE, ...selectedIds] : [...selectedIds];
}

/** One resident keeps the minted id as it was; several get a stable suffix so a retried submit upserts the same rows. */
export function chargeIdForResident(baseId: string, index: number, total: number): string {
  return total <= 1 ? baseId : `${baseId}_${index + 1}`;
}

export type BatchChargeResident = {
  applicationId: string;
  residentName: string;
  residentEmail: string;
  propertyId: string;
  propertyLabel: string;
  /** Already carries the room suffix for this resident. */
  title: string;
};

export type BatchChargeTerms = {
  managerUserId: string | null;
  amount: number;
  dueDateLabel: string;
  initialStatus: "pending" | "paid";
  workOrderId?: string;
  baseId: string;
};

export type BatchChargeResult = { created: HouseholdCharge[]; failed: BatchChargeResident[] };

/** Create one charge per resident, same amount, kind and due date. Never sends a notice: `charge_created` does that once per row. */
export function createChargesForResidents(
  residents: readonly BatchChargeResident[],
  terms: BatchChargeTerms,
  create: typeof createManagerCharge = createManagerCharge,
): BatchChargeResult {
  const created: HouseholdCharge[] = [];
  const failed: BatchChargeResident[] = [];
  residents.forEach((resident, index) => {
    const charge = create({
      residentEmail: resident.residentEmail,
      residentName: resident.residentName,
      propertyId: resident.propertyId,
      propertyLabel: resident.propertyLabel,
      managerUserId: terms.managerUserId,
      applicationId: resident.applicationId,
      title: resident.title,
      amount: terms.amount,
      dueDateLabel: terms.dueDateLabel,
      initialStatus: terms.initialStatus,
      id: chargeIdForResident(terms.baseId, index, residents.length),
      workOrderId: terms.workOrderId,
    });
    if (charge) created.push(charge);
    else failed.push(resident);
  });
  return { created, failed };
}

export function chargesAddedMessage(count: number): string {
  return count === 1 ? "Charge added." : `${count} charges added.`;
}
