"use client";
import Link from "next/link";
import { useEffect, useState } from "react";

export const RESIDENT_VERIFICATION_HREF = "/resident/profile?tab=profile#verification";
export function ResidentVerificationLink() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let active = true;
    void fetch("/api/resident/identity", { cache: "no-store" }).then(async (response) => response.ok ? await response.json() as { status?: string } : null).then((body) => {
      if (active && body?.status && body.status !== "unavailable") setVisible(true);
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  return visible ? <Link href={RESIDENT_VERIFICATION_HREF} className="text-sm font-medium text-primary">Identity verification</Link> : null;
}
