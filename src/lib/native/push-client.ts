"use client";

/**
 * Client-only helpers for the Capacitor native shell. Safe to import anywhere:
 * every Capacitor module is loaded lazily, so nothing executes during SSR or in
 * the normal web bundle until a function is actually called inside the app.
 */

export type NativePlatform = "ios" | "android" | "web";
export type PushPermission = "granted" | "denied" | "prompt" | "unsupported";

/** A "View as" support session never registers a device: the token would attach to the viewed account. */
function viewingAs(): boolean {
  return typeof document !== "undefined" && document.documentElement.hasAttribute("data-view-as");
}

let listenersAttached = false;
let cachedToken: { value: string; platform: string } | null = null;

export async function getNativeInfo(): Promise<{ isNative: boolean; platform: NativePlatform }> {
  if (typeof window === "undefined") return { isNative: false, platform: "web" };
  try {
    const { Capacitor } = await import("@capacitor/core");
    return {
      isNative: Capacitor.isNativePlatform(),
      platform: Capacitor.getPlatform() as NativePlatform,
    };
  } catch {
    return { isNative: false, platform: "web" };
  }
}

async function saveToken(token: string, platform: string): Promise<void> {
  if (viewingAs()) return;
  try {
    await fetch("/api/native/register-push-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, platform }),
    });
  } catch {
    // Offline or not signed in yet — retried on resume / next register call.
  }
}

async function attachListeners(platform: string): Promise<void> {
  if (listenersAttached) return;
  const { PushNotifications } = await import("@capacitor/push-notifications");
  await PushNotifications.addListener("registration", (token) => {
    cachedToken = { value: token.value, platform };
    void saveToken(token.value, platform);
  });
  await PushNotifications.addListener("registrationError", (err) => {
    console.error("Push registration error", err);
  });
  await PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
    const url = action.notification?.data?.url;
    if (typeof url === "string" && url.startsWith("/")) window.location.assign(url);
  });
  listenersAttached = true;
}

export async function getPushPermission(): Promise<PushPermission> {
  try {
    const { isNative } = await getNativeInfo();
    if (!isNative) return "unsupported";
    const { PushNotifications } = await import("@capacitor/push-notifications");
    const { receive } = await PushNotifications.checkPermissions();
    if (receive === "granted") return "granted";
    if (receive === "denied") return "denied";
    return "prompt";
  } catch {
    return "unsupported";
  }
}

/**
 * Registers for push only if permission was already granted. Never prompts —
 * call this on app launch so previously-opted-in devices keep their token
 * fresh without nagging everyone else.
 */
export async function registerPushIfGranted(): Promise<void> {
  if (viewingAs()) return;
  const { isNative, platform } = await getNativeInfo();
  if (!isNative) return;
  const { PushNotifications } = await import("@capacitor/push-notifications");
  const { receive } = await PushNotifications.checkPermissions();
  if (receive !== "granted") return;
  await attachListeners(platform);
  await PushNotifications.register();
}

/**
 * Requests permission (if not yet decided) and registers. Drive this from an
 * explicit user action like an "Enable notifications" button — the recommended
 * pattern for good UX and App Store review.
 */
export async function requestPushPermission(): Promise<PushPermission> {
  if (viewingAs()) return "prompt";
  const { isNative, platform } = await getNativeInfo();
  if (!isNative) return "unsupported";
  const { PushNotifications } = await import("@capacitor/push-notifications");
  let { receive } = await PushNotifications.checkPermissions();
  if (receive === "prompt" || receive === "prompt-with-rationale") {
    receive = (await PushNotifications.requestPermissions()).receive;
  }
  if (receive !== "granted") return receive === "denied" ? "denied" : "prompt";
  await attachListeners(platform);
  await PushNotifications.register();
  return "granted";
}

/** Re-send the most recent device token (used on app resume after sign-in). */
export async function resendCachedToken(): Promise<void> {
  if (cachedToken) await saveToken(cachedToken.value, cachedToken.platform);
}

/**
 * Release this device's push token for the account that is signing out, so the
 * next person to sign in on a shared phone does not inherit its notifications.
 * Best-effort: signing out never waits on, or fails because of, this.
 */
export async function releaseCachedPushToken(): Promise<void> {
  if (!cachedToken) return;
  const { value } = cachedToken;
  cachedToken = null;
  try {
    await fetch("/api/native/register-push-token", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ token: value }),
    });
  } catch {
    // Offline: the next sign-in re-registers the token to its new owner anyway.
  }
}
