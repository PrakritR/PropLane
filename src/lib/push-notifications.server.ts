import crypto from "node:crypto";
import { assertInAppPushPath } from "@/lib/platform/parity";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { captureSmsTestDelivery } from "@/lib/sms/sms-test-transport.server";

/**
 * Server-only push delivery via Firebase Cloud Messaging (HTTP v1).
 *
 * Both iOS and Android tokens go through FCM — configure an APNs auth key in
 * the Firebase console so Firebase can relay to Apple devices. This keeps a
 * single send path instead of talking to APNs and FCM separately.
 *
 * Required env (server-only — never expose to the client):
 *   FCM_PROJECT_ID    Firebase project id
 *   FCM_CLIENT_EMAIL  service account client_email
 *   FCM_PRIVATE_KEY   service account private_key (literal "\n" escapes are fine)
 *
 * When the env is not set, every call no-ops and returns { sent: 0, skipped: true },
 * so existing notification flows keep working before push is fully wired up.
 *
 * Usage from an existing notification path:
 *   import { sendPushToUser } from "@/lib/push-notifications.server";
 *   await sendPushToUser(residentUserId, {
 *     title: "Rent due soon",
 *     body: "Your rent for July is due in 3 days.",
 *     url: "/resident/payments",
 *   });
 */

export type PushPayload = {
  title: string;
  body: string;
  /** In-app path opened when the notification is tapped, e.g. "/resident/dashboard". */
  url?: string;
  /** Extra string key/values delivered alongside the message. */
  data?: Record<string, string>;
};

type FcmCreds = { projectId: string; clientEmail: string; privateKey: string };

function readCreds(): FcmCreds | null {
  const projectId = process.env.FCM_PROJECT_ID;
  const clientEmail = process.env.FCM_CLIENT_EMAIL;
  const privateKey = process.env.FCM_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!projectId || !clientEmail || !privateKey) return null;
  return { projectId, clientEmail, privateKey };
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// Access tokens are valid for an hour; cache across calls within the process.
let cachedAccessToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(creds: FcmCreds): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
    return cachedAccessToken.value;
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(
    JSON.stringify({
      iss: creds.clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signature = base64url(crypto.sign("RSA-SHA256", Buffer.from(`${header}.${claim}`), creds.privateKey));
  const assertion = `${header}.${claim}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`FCM token exchange failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedAccessToken = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return json.access_token;
}

async function sendToToken(
  creds: FcmCreds,
  accessToken: string,
  deviceToken: string,
  payload: PushPayload,
): Promise<{ ok: boolean; invalid: boolean }> {
  const data: Record<string, string> = { ...(payload.data ?? {}) };
  if (payload.url) data.url = payload.url;

  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${creds.projectId}/messages:send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        token: deviceToken,
        notification: { title: payload.title, body: payload.body },
        data,
        apns: { payload: { aps: { sound: "default" } } },
        android: { priority: "high", notification: { sound: "default" } },
      },
    }),
  });

  if (res.ok) return { ok: true, invalid: false };
  // 404 UNREGISTERED / 400 INVALID_ARGUMENT => the token is dead; prune it.
  return { ok: false, invalid: res.status === 404 || res.status === 400 };
}

/**
 * Sends a push to every active device registered to a user. Dead tokens are
 * marked disabled so they stop being retried. Safe to call when push is not
 * yet configured (returns { sent: 0, skipped: true }).
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
): Promise<{ sent: number; skipped?: boolean }> {
  if (captureSmsTestDelivery({
    kind: "push",
    summary: payload.title.trim() || "Push notification captured in the test conversation.",
    status: "captured",
  })) {
    return { sent: 1 };
  }
  if (payload.url) assertInAppPushPath(payload.url);

  const creds = readCreds();
  if (!creds) return { sent: 0, skipped: true };

  const db = createSupabaseServiceRoleClient();
  const { data: rows } = await db
    .from("device_push_tokens")
    .select("token")
    .eq("user_id", userId)
    .is("disabled_at", null);

  const tokens = (rows ?? []).map((r) => r.token as string).filter(Boolean);
  if (tokens.length === 0) return { sent: 0 };

  const accessToken = await getAccessToken(creds);
  let sent = 0;
  const dead: string[] = [];

  await Promise.all(
    tokens.map(async (token) => {
      try {
        const result = await sendToToken(creds, accessToken, token, payload);
        if (result.ok) sent += 1;
        else if (result.invalid) dead.push(token);
      } catch {
        // Transient send error — leave the token in place to retry next time.
      }
    }),
  );

  if (dead.length > 0) {
    await db.from("device_push_tokens").update({ disabled_at: new Date().toISOString() }).in("token", dead);
  }

  return { sent };
}
