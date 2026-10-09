import { resolveEmailLinkBaseUrl } from "@/lib/app-url";

/** Hosts a listing photo may be fetched from server-side: the app's own Supabase storage host and the app origin. */
export function allowedPhotoHosts(): Set<string> {
  const hosts = new Set<string>();
  let origin: string | null = null;
  try {
    origin = resolveEmailLinkBaseUrl();
  } catch {
    origin = null;
  }
  for (const raw of [process.env.NEXT_PUBLIC_SUPABASE_URL, origin]) {
    try {
      if (raw) hosts.add(new URL(raw).host.toLowerCase());
    } catch {
      /* a malformed env value allows nothing */
    }
  }
  return hosts;
}

export function isAllowedPhotoUrl(raw: string, hosts: ReadonlySet<string> = allowedPhotoHosts()): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password && hosts.has(url.host.toLowerCase());
  } catch {
    return false;
  }
}
