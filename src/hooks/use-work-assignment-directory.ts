"use client";

import { useEffect, useMemo, useState } from "react";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import {
  MANAGER_VENDORS_EVENT,
  readOwnManagerVendorRows,
  syncManagerVendorsFromServer,
} from "@/lib/manager-vendors-storage";
import { readProRelationships, syncProRelationshipsFromServer } from "@/lib/pro-relationships";
import { PRO_RELATIONSHIPS_EVENT } from "@/lib/property-pipeline-events";

export type WorkAssignmentTeamMember = {
  userId: string;
  name?: string | null;
  email?: string | null;
};

/**
 * Team members (self + linked co-managers) and vendors for assignment pickers.
 */
export function useWorkAssignmentDirectory(opts?: {
  managerUserId?: string | null;
  managerName?: string | null;
}) {
  const session = useManagerUserId();
  const userId = opts?.managerUserId ?? session.userId;
  const email = session.email;
  const [relationshipTick, setRelationshipTick] = useState(0);
  const [vendorTick, setVendorTick] = useState(0);

  useEffect(() => {
    if (!userId) return;
    void syncProRelationshipsFromServer(userId).catch(() => undefined);
    void syncManagerVendorsFromServer().catch(() => undefined);
  }, [userId]);

  useEffect(() => {
    const onRelationships = () => setRelationshipTick((n) => n + 1);
    const onVendors = () => setVendorTick((n) => n + 1);
    window.addEventListener(PRO_RELATIONSHIPS_EVENT, onRelationships);
    window.addEventListener(MANAGER_VENDORS_EVENT, onVendors);
    return () => {
      window.removeEventListener(PRO_RELATIONSHIPS_EVENT, onRelationships);
      window.removeEventListener(MANAGER_VENDORS_EVENT, onVendors);
    };
  }, []);

  const teamMembers = useMemo((): WorkAssignmentTeamMember[] => {
    if (!userId) return [];
    void relationshipTick;
    const members: WorkAssignmentTeamMember[] = [];
    const selfLabel = opts?.managerName?.trim() || email?.trim() || "You";
    members.push({ userId, name: selfLabel, email });
    const seen = new Set<string>([userId]);
    for (const rel of readProRelationships(userId)) {
      const linkedId = rel.linkedUserId?.trim();
      if (!linkedId || seen.has(linkedId)) continue;
      seen.add(linkedId);
      members.push({
        userId: linkedId,
        name: rel.linkedDisplayName?.trim() || rel.linkedAxisId?.trim() || "Team member",
      });
    }
    return members;
  }, [userId, email, opts?.managerName, relationshipTick]);

  const vendors = useMemo(() => {
    void vendorTick;
    if (!userId) return [];
    return readOwnManagerVendorRows(userId);
  }, [userId, vendorTick]);

  return { teamMembers, vendors, ready: session.ready };
}
