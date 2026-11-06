/** An editable profile email is never proof of mailbox control. */
export function verifiedSessionEmail(
  user: { email?: string | null; email_confirmed_at?: string | null },
  profileEmail?: string | null,
): string {
  const email = user.email?.trim().toLowerCase() ?? "";
  const profile = profileEmail?.trim().toLowerCase() ?? "";
  if (!user.email_confirmed_at || !email.includes("@") || email.endsWith("@phone.proplane.invalid")) return "";
  return profile && profile !== email ? "" : email;
}
