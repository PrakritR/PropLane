"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AccountLinkInviteDto } from "@/lib/account-links";
import { coManagerPortalSectionAllowed } from "@/lib/co-manager-permissions";
import { deriveManagerNavRole } from "@/lib/co-manager-nav";
import { ownedPropertyIdsForUser } from "@/lib/manager-portfolio-access";
import { fetchAccountLinksCached } from "@/lib/portal-data-store";
import type { PortalDefinition } from "@/lib/portal-types";

const REFRESH_EVENTS = ["axis-pro-relationships", "axis-property-pipeline", "storage"] as const;

const EMPTY_RESTRICTED: ReadonlySet<string> = new Set();

export function useCoManagerNavSections(definition: PortalDefinition, userId: string | null) {
  const [tick, setTick] = useState(0);
  const [invites, setInvites] = useState<AccountLinkInviteDto[] | null>(null);

  const loadInvites = useCallback(async () => {
    if (!userId) {
      setInvites(null);
      return;
    }
    try {
      const body = await fetchAccountLinksCached();
      if (body.migrationRequired) {
        setInvites([]);
        return;
      }
      setInvites(body.invites ?? []);
    } catch {
      setInvites([]);
    }
  }, [userId]);

  const navSectionsDisabled = !userId || (definition.kind !== "pro" && definition.kind !== "manager");

  // Reset invites when leaving pro/manager context — done during render (not in
  // an effect) to avoid a cascading setState-in-effect.
  const [prevNavSectionsDisabled, setPrevNavSectionsDisabled] = useState(navSectionsDisabled);
  if (navSectionsDisabled !== prevNavSectionsDisabled) {
    setPrevNavSectionsDisabled(navSectionsDisabled);
    if (navSectionsDisabled && invites !== null) setInvites(null);
  }

  useEffect(() => {
    if (!userId || (definition.kind !== "pro" && definition.kind !== "manager")) {
      void Promise.resolve().then(() => setInvites(null));
      return;
    }
    void Promise.resolve().then(() => void loadInvites());
  }, [definition.kind, loadInvites, userId, tick]);

  useEffect(() => {
    if (!userId || (definition.kind !== "pro" && definition.kind !== "manager")) return;
    const bump = () => setTick((n) => n + 1);
    for (const ev of REFRESH_EVENTS) window.addEventListener(ev, bump);
    window.addEventListener("focus", bump);
    return () => {
      for (const ev of REFRESH_EVENTS) window.removeEventListener(ev, bump);
      window.removeEventListener("focus", bump);
    };
  }, [definition.kind, userId]);

  return useMemo(() => {
    if (!userId || (definition.kind !== "pro" && definition.kind !== "manager")) {
      return { sections: definition.sections, restrictedSections: EMPTY_RESTRICTED };
    }

    // Default to full nav while account links load to avoid hiding primary-manager sections.
    if (invites === null) {
      return { sections: definition.sections, restrictedSections: EMPTY_RESTRICTED };
    }

    // A user who owns any property is a primary manager for nav (their own
    // portfolio needs every section); linked-property restrictions still apply
    // at the data layer. Recomputed on `tick`, which bumps on the property
    // pipeline sync event.
    const ownsProperties = userId ? ownedPropertyIdsForUser(userId).size > 0 : false;
    const { isPrimaryManager, mergedPermissions, hasEmptyPermissionCoManagerLink } =
      deriveManagerNavRole(invites, ownsProperties);

    // Every section stays in the nav; the ones this link does not grant come
    // back as LOCKED rather than missing. A sidebar that differs between two
    // manager accounts reads as a broken build, and a removed row gives the
    // person nothing to recognise or ask about. The data layer still enforces.
    const restrictedSections = new Set(
      definition.sections
        .filter(
          (s) =>
            !coManagerPortalSectionAllowed({
              section: s.section,
              isPrimaryManager,
              mergedPermissions,
              hasEmptyPermissionCoManagerLink,
            }),
        )
        .map((s) => s.section),
    );

    return { sections: definition.sections, restrictedSections };
  }, [definition, invites, userId, tick]);
}
