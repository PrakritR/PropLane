export const ENTRY_PERMISSION_OPTIONS: { value: "allowed" | "call_first" | "resident_present"; label: string }[] = [
  { value: "allowed", label: "Yes, they can enter" },
  { value: "call_first", label: "Call me first" },
  { value: "resident_present", label: "No - I'll be home" },
];

export function entryPermissionLabel(value: string | undefined): string {
  return ENTRY_PERMISSION_OPTIONS.find((option) => option.value === value)?.label ?? "Call me first";
}

/** What a vendor reads about getting in - the same three answers, worded for the person arriving. */
export const VENDOR_ENTRY_PERMISSION_LABELS: Record<"allowed" | "call_first" | "resident_present", string> = {
  allowed: "Can enter",
  call_first: "Call first",
  resident_present: "Resident home",
};

export function vendorEntryPermissionLabel(value: string | undefined): string {
  return VENDOR_ENTRY_PERMISSION_LABELS[value as keyof typeof VENDOR_ENTRY_PERMISSION_LABELS] ?? "Call first";
}
