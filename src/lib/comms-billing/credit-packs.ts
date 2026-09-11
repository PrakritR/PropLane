/** Retail credit and purchase price are equal; no automatic replenishment. */
export const COMMS_CREDIT_PACKS_CENTS = [500, 1000, 2500, 5000] as const;
export const COMMS_CREDIT_PURPOSE = "manager_communication_credit";
export function isCommsCreditPack(
  value: unknown,
): value is (typeof COMMS_CREDIT_PACKS_CENTS)[number] {
  return (
    typeof value === "number" &&
    COMMS_CREDIT_PACKS_CENTS.some((amount) => amount === value)
  );
}
