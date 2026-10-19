"use client";

import { HomeNavbar, type HomeTextingConfig } from "@/components/layout/home-navbar";
const NO_TEXTING: HomeTextingConfig = { phone: null, smsHref: null };

/** Public pages share the restored section navigation and configured texting action. */
export function PublicNavbar({ texting = NO_TEXTING }: { texting?: HomeTextingConfig }) {
  return <HomeNavbar texting={texting} />;
}
