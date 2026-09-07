/**
 * The export password rule, shared by the Settings form and the route so the two can never
 * disagree about what is long enough. No Node imports: this file reaches the browser.
 */
export const EXPORT_PASSWORD_MIN_LENGTH = 12;
export const EXPORT_PASSWORD_MAX_LENGTH = 256;
export const EXPORT_FILE_EXTENSION = ".proplane";
export const EXPORT_FILE_MIME = "application/octet-stream";

export function validateExportPassword(password: unknown): string | null {
  if (typeof password !== "string") return "A password is required.";
  if (password.length < EXPORT_PASSWORD_MIN_LENGTH) {
    return `Use at least ${EXPORT_PASSWORD_MIN_LENGTH} characters.`;
  }
  if (password.length > EXPORT_PASSWORD_MAX_LENGTH) {
    return `Use at most ${EXPORT_PASSWORD_MAX_LENGTH} characters.`;
  }
  return null;
}
