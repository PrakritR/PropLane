/**
 * Which credentials a sign-in form actually submits.
 *
 * iOS/iPadOS Password AutoFill writes straight into an input's DOM value, and
 * WebKit does not reliably deliver that to React as a change event — so the box
 * visibly holds a credential while component state is empty or stale. The DOM is
 * authoritative for BOTH fields whenever it holds something, because it is what
 * the person actually sees.
 *
 * Splitting that rule per field is how a credential PAIR that was never shown
 * together got submitted: a returning user's remembered email is pre-seeded into
 * state, so AutoFilling a *different* saved account produced the remembered
 * email with the newly autofilled password, and the sign-in failed with
 * "Invalid login credentials" on exactly the path the DOM read exists to fix.
 */
export function resolveFormCredentials(input: {
  domEmail: string;
  domPassword: string;
  stateEmail: string;
  statePassword: string;
}): { email: string; password: string } {
  return {
    email: (input.domEmail.trim() || input.stateEmail.trim()).trim(),
    password: input.domPassword || input.statePassword,
  };
}
