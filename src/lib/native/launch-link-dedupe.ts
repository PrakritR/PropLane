const PREFIX = "axis_native_launch_seen_v1:";

/** The native SDK retains its last launch URL across WebView document reloads. */
export async function claimNativeLaunchUrl(url: string): Promise<boolean> {
  try {
    // A bearer fragment must never be copied into browser storage. Only retain
    // its non-reversible digest for this WebView session, including warm links.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
    const key = PREFIX + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (sessionStorage.getItem(key)) return false;
    sessionStorage.setItem(key, "1");
    return true;
  } catch {
    // Without reliable replay memory, a persisted launch cannot safely cause
    // cross-document navigation. Live appUrlOpen events still work normally.
    return false;
  }
}
