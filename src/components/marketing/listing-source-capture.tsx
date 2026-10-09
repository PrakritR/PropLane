"use client";

import { useEffect } from "react";

import { leadSourceCookieAssignment } from "@/lib/listing-channels/lead-source";

/** Keeps the allowlisted `?src=` channel in a first-party cookie so a later tour request or application can credit it. */
export function ListingSourceCapture() {
  useEffect(() => {
    try {
      const assignment = leadSourceCookieAssignment(new URLSearchParams(window.location.search).get("src"));
      if (assignment) document.cookie = assignment;
    } catch {
      /* cookies blocked: the lead is simply untagged */
    }
  }, []);
  return null;
}
