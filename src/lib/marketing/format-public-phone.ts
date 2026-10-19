/** Format the configured North American shared line; never invent a missing number. */
export function formatPublicPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const national = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone);
  if (national) return `(${national[1]}) ${national[2]}-${national[3]}`;
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
}
