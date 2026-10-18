"use client";

import { HomeNavbar, type HomeTextingConfig } from "@/components/layout/home-navbar";
const NO_TEXTING: HomeTextingConfig = { phone: null, smsHref: null };

/** Every public page uses the same small, session-independent navigation. */
export function PublicNavbar({ texting = NO_TEXTING }: { texting?: HomeTextingConfig }) {
  return <HomeNavbar texting={texting} />;
}
