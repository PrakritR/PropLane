/** User-facing copy when Google Calendar OAuth fails (Testing mode, blocked app, etc.). */
export function formatGoogleCalendarConnectError(reason: string | null): string {
  if (!reason?.trim()) {
    return "Could not connect Google Calendar. Check redirect URI in Google Cloud.";
  }
  let decoded = reason.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    /* keep raw reason */
  }
  if (isGoogleCalendarOAuthBlocked(decoded)) {
    return (
      "Google blocked Calendar access for this app (calendar.events is a sensitive scope). " +
      "In Google Cloud → OAuth consent screen, add your Google account under Test users, or publish to Production with verification. " +
      "Use the same Google account you signed into PropLane with."
    );
  }
  return `Could not connect Google Calendar: ${decoded}`;
}

export function isGoogleCalendarOAuthBlocked(reason: string | null): boolean {
  if (!reason?.trim()) return false;
  let decoded = reason.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    /* keep raw */
  }
  const lower = decoded.toLowerCase();
  return (
    lower.includes("access_denied") ||
    lower.includes("blocked") ||
    lower.includes("verification") ||
    lower.includes("sensitive") ||
    lower.includes("has not completed the google verification") ||
    lower.includes("hasn't verified") ||
    lower.includes("has not verified")
  );
}

export const GOOGLE_CALENDAR_UNVERIFIED_APP_STEPS = [
  "On Google's warning page, click Advanced (bottom left).",
  'Choose "Go to PropLane (unsafe)" — this is expected until Google verifies the app.',
  "Approve calendar access for the Google account you use on PropLane.",
] as const;

export const GOOGLE_CALENDAR_PRODUCTION_PUBLISH_STEPS = [
  "Google Cloud Console → APIs & Services → OAuth consent screen.",
  "Publish app → Production (requires privacy policy + terms URLs).",
  "Submit calendar.events for Google verification so every manager can connect without Advanced.",
] as const;
